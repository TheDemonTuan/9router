import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockMetadataUpdate, buildClearModelLockMetadataUpdate, getModelLockKey, getModelLockUntil, getModelLockMetadata } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { isAlitpModelAvailableForEdition } from "open-sse/providers/alibabaTokenPlanCatalog.js";
import {
  getChatGptWebCatalog,
  hasChatGptWebModel,
  chatGptWebModelSupportsCapabilities,
} from "open-sse/services/chatgptWebBridge.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function getExactModelLockMetadata(connection, model) {
  const suffix = model || "__all";
  return {
    unavailabilityReason: connection?.[`modelLockReason_${suffix}`] ?? (model === null ? connection?.unavailabilityReason : null),
    errorCode: connection?.[`modelLockErrorCode_${suffix}`] ?? (model === null ? connection?.errorCode : null),
    lastError: connection?.[`modelLockLastError_${suffix}`] ?? (model === null ? connection?.lastError : null),
    backoffLevel: connection?.[`modelLockBackoffLevel_${suffix}`] ?? (model === null ? connection?.backoffLevel : 0),
  };
}


function getUnavailabilityReason(connections, lockedConns, model) {
  if (lockedConns.length !== connections.length) return "unavailable";
  const metadata = lockedConns.map((connection) => getModelLockMetadata(connection, model));
  const reasons = metadata.map(({ unavailabilityReason }) => unavailabilityReason);
  if (reasons.every((reason) => reason === "quota_exhausted")) return "quota_exhausted";
  if (reasons.every((reason) => reason === "rate_limited")) return "rate_limited";
  if (reasons.every((reason) => reason === "auth_failed")) return "auth_failed";
  if (reasons.every((reason) => reason === "transient_provider_failure")) return "transient_provider_failure";

  const errorCodes = metadata.map(({ errorCode }) => Number(errorCode));
  if (errorCodes.every((status) => status === 401 || status === 403)) return "auth_failed";
  if (errorCodes.every((status) => status >= 500 && status <= 599)) return "transient_provider_failure";
  return "unavailable";
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 * @param {{ preferredConnectionId?: string, pinConnectionId?: string, requiredCapabilities?: Set<string>|string[], bridgeCapability?: "native_responses"|"generic_responses" }} options
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const pinConnectionId = options?.pinConnectionId || null;
  const bridgeCapability = options?.bridgeCapability === "generic_responses"
    ? "generic_responses"
    : "native_responses";
  const requiredCapabilities = options?.requiredCapabilities instanceof Set
    ? options.requiredCapabilities
    : new Set(Array.isArray(options?.requiredCapabilities) ? options.requiredCapabilities : []);
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return pinConnectionId
        ? { pinnedConnectionUnavailable: true, connectionId: pinConnectionId }
        : null;
    }


    const bridgeEligible = new Set();
    if (providerId === "chatgpt-web" && model) {
      await Promise.all(connections.map(async (connection) => {
        try {
          const catalog = await getChatGptWebCatalog(connection);
          const liveModel = catalog.models?.find((entry) => entry.id === model);
          if (!catalog.stale && hasChatGptWebModel(catalog, model)
            && liveModel?.capabilities?.[bridgeCapability] === true
            && chatGptWebModelSupportsCapabilities(liveModel, requiredCapabilities)) {
            bridgeEligible.add(connection.id);
          }
        } catch { /* Offline/unknown bridges are not dispatch candidates. */ }
      }));
    }

    // Filter out model-locked, excluded, and capability-ineligible connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (pinConnectionId && c.id !== pinConnectionId) return false;
      if (providerId === "chatgpt-web" && model && !bridgeEligible.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Alibaba Token Plan: Team-only models require a Team Edition connection
      // (metadata check on the cached connection — no network during selection).
      if (providerId === "alitp-intl" && model &&
          !isAlitpModelAvailableForEdition(model, c.providerSpecificData?.tokenPlanEdition)) {
        return false;
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getModelLockUntil(c, model);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      if (pinConnectionId) return { pinnedConnectionUnavailable: true, connectionId: pinConnectionId };
      // Classify only persisted, future-dated model locks.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const unavailabilityReason = getUnavailabilityReason(connections, lockedConns, model);
      const expiries = lockedConns
        .map(c => ({ connection: c, expiry: getModelLockUntil(c, model), at: Date.parse(getModelLockUntil(c, model)) }))
        .filter(({ at }) => Number.isFinite(at) && at > Date.now())
        .sort((a, b) => a.at - b.at);
      const earliestEntry = expiries[0] || null;
      if (earliestEntry) {
        const metadata = getModelLockMetadata(earliestEntry.connection, model);
        const lastError = unavailabilityReason === "quota_exhausted"
          ? "All accounts have exhausted their usage quota"
          : metadata.lastError;
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliestEntry.expiry)}) | reason=${unavailabilityReason}`);
        return {
          allRateLimited: true,
          unavailabilityReason,
          retryAfter: earliestEntry.expiry,
          retryAfterHuman: formatRetryAfter(earliestEntry.expiry),
          lastError,
          lastErrorCode: metadata.errorCode
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, errorClass = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  let effective = null;
  let lockKey = null;
  let connectionName = connectionId.slice(0, 8);
  let didUpdate = false;

  const updated = await updateProviderConnection(connectionId, (current) => {
    const now = Date.now();
    const resolvedProvider = provider || current.provider;
    const githubResetAtMs = githubMonthlyResetMs(status, errorText, resolvedProvider);
    const lockModel = githubResetAtMs ? null : model;
    lockKey = getModelLockKey(lockModel);
    connectionName = current.displayName || current.name || current.email || connectionName;

    const exactMetadata = getExactModelLockMetadata(current, lockModel);
    const backoffLevel = Number(exactMetadata.backoffLevel) || 0;
    const currentExpiryMs = Date.parse(current[lockKey]);
    const currentActive = Number.isFinite(currentExpiryMs) && currentExpiryMs > now;

    let shouldFallback = false;
    let candidateExpiryMs = null;
    let newBackoffLevel = backoffLevel;
    if (githubResetAtMs && githubResetAtMs > now) {
      shouldFallback = true;
      candidateExpiryMs = githubResetAtMs;
      newBackoffLevel = 0;
    } else if (typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs)) {
      const resetDate = new Date(resetsAtMs);
      if (Number.isFinite(resetDate.getTime()) && resetsAtMs > now) {
        shouldFallback = true;
        candidateExpiryMs = errorClass === "quota_exhausted"
          ? resetDate.getTime()
          : Math.min(resetDate.getTime(), now + MAX_RATE_LIMIT_COOLDOWN_MS);
        newBackoffLevel = 0;
      }
    }
    if (!shouldFallback) {
      const fallback = checkFallbackError(status, errorText, backoffLevel);
      shouldFallback = fallback.shouldFallback;
      candidateExpiryMs = shouldFallback ? now + fallback.cooldownMs : null;
      newBackoffLevel = fallback.newBackoffLevel ?? backoffLevel;
    }

    if (!shouldFallback || !Number.isFinite(candidateExpiryMs) || candidateExpiryMs <= now) {
      effective = currentActive
        ? { shouldFallback: true, cooldownMs: currentExpiryMs - now }
        : { shouldFallback: false, cooldownMs: 0 };
      return null;
    }

    const candidateReason = errorClass || (githubResetAtMs ? "quota_exhausted" : null);
    let effectiveExpiryMs = candidateExpiryMs;
    let effectiveReason = candidateReason;
    let effectiveErrorCode = status;
    let effectiveLastError = reason;
    let effectiveBackoffLevel = newBackoffLevel;
    const currentIsQuota = exactMetadata.unavailabilityReason === "quota_exhausted";
    const candidateIsQuota = candidateReason === "quota_exhausted";

    if (currentActive && currentExpiryMs > candidateExpiryMs) {
      effectiveExpiryMs = currentExpiryMs;
      effectiveReason = exactMetadata.unavailabilityReason;
      effectiveErrorCode = exactMetadata.errorCode;
      effectiveLastError = exactMetadata.lastError;
      effectiveBackoffLevel = exactMetadata.backoffLevel;
    } else if (currentActive && currentExpiryMs === candidateExpiryMs && !(candidateIsQuota && !currentIsQuota)) {
      effective = { shouldFallback: true, cooldownMs: currentExpiryMs - now };
      return null;
    }

    effective = { shouldFallback: true, cooldownMs: Math.max(0, effectiveExpiryMs - now) };
    didUpdate = true;
    return {
      [lockKey]: new Date(effectiveExpiryMs).toISOString(),
      ...buildModelLockMetadataUpdate(lockModel, {
        unavailabilityReason: effectiveReason,
        errorCode: effectiveErrorCode,
        lastError: effectiveLastError,
        backoffLevel: effectiveBackoffLevel,
      }),
      testStatus: "unavailable",
      lastError: effectiveLastError,
      errorCode: effectiveErrorCode,
      unavailabilityReason: effectiveReason,
      lastErrorAt: new Date(now).toISOString(),
      ...(lockModel === null ? { backoffLevel: effectiveBackoffLevel } : {}),
    };
  }, { resetHealth: false });

  if (!didUpdate) return effective || { shouldFallback: false, cooldownMs: 0 };
  log.warn("AUTH", `${connectionName} locked ${lockKey} for ${Math.round(effective.cooldownMs / 1000)}s [${status}]`);
  if (provider && status && reason && errorClass !== "quota_exhausted") console.error(`❌ ${provider} [${status}]: ${reason}`);
  return effective;
}

/**
 * Batch persist model locks in a single transaction with idempotent no-op.
 */
export async function persistModelLocksBatch(connectionId, locks, {
  provider = "antigravity",
  status = 429,
  reason = "Antigravity quota remaining=0",
  errorClass = "quota_exhausted",
} = {}) {
  if (!connectionId || connectionId === "noauth" || !Array.isArray(locks) || locks.length === 0) {
    return { changed: 0, effective: null };
  }

  let didUpdate = false;
  let changedCount = 0;
  let latestResetMs = 0;
  let connectionName = connectionId.slice(0, 8);

  await updateProviderConnection(connectionId, (current) => {
    const now = Date.now();
    connectionName = current.displayName || current.name || current.email || connectionName;
    const patch = {};

    for (const item of locks) {
      const model = typeof item === "string" ? item : item.model;
      const resetMs = typeof item === "object" && Number.isFinite(item.resetMs) ? item.resetMs : null;
      if (!model || !Number.isFinite(resetMs) || resetMs <= now) continue;

      const lockKey = getModelLockKey(model);
      const exactMetadata = getExactModelLockMetadata(current, model);
      const currentExpiryMs = Date.parse(current[lockKey]);
      const currentActive = Number.isFinite(currentExpiryMs) && currentExpiryMs > now;
      const currentIsQuota = exactMetadata.unavailabilityReason === "quota_exhausted";

      if (currentActive && currentExpiryMs >= resetMs && currentIsQuota) {
        continue;
      }

      changedCount++;
      if (resetMs > latestResetMs) latestResetMs = resetMs;

      patch[lockKey] = new Date(resetMs).toISOString();
      Object.assign(patch, buildModelLockMetadataUpdate(model, {
        unavailabilityReason: errorClass,
        errorCode: status,
        lastError: reason,
        backoffLevel: 0,
      }));
    }

    if (changedCount === 0) return null;

    didUpdate = true;
    return {
      ...patch,
      testStatus: "unavailable",
      lastError: reason,
      errorCode: status,
      unavailabilityReason: errorClass,
      lastErrorAt: new Date(now).toISOString(),
    };
  }, { resetHealth: false });

  if (didUpdate && changedCount > 0) {
    const diffMs = Math.max(0, latestResetMs - Date.now());
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    const timeStr = `${hours}h${String(mins).padStart(2, "0")}m`;
    log.info("AG_QUOTA", `${connectionName} · locked ${changedCount} models · reset ${timeStr}`);
  }
  return { changed: changedCount };
}

/**
 * Clear the successful model lock and expired locks from the latest DB row.
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const snapshot = currentConnection?._connection || currentConnection || {};
  const snapshotTargetKey = getModelLockKey(model);
  const snapshotTargetExpiry = snapshot[snapshotTargetKey];

  await updateProviderConnection(connectionId, (current) => {
    const now = Date.now();
    const allLockKeys = Object.keys(current).filter(key => key.startsWith("modelLock_"));
    const keysToClear = allLockKeys.filter((key) => {
      const expiryMs = Date.parse(current[key]);
      if (Number.isFinite(expiryMs) && expiryMs <= now) return true;
      return key === snapshotTargetKey
        && snapshotTargetExpiry != null
        && current[key] === snapshotTargetExpiry;
    });

    const remainingActiveLocks = allLockKeys.filter((key) => {
      if (keysToClear.includes(key)) return false;
      const expiryMs = Date.parse(current[key]);
      return Number.isFinite(expiryMs) && expiryMs > now;
    });

    const patch = Object.fromEntries(keysToClear.map(key => [key, null]));
    for (const key of keysToClear) {
      const lockModel = key === "modelLock___all" ? null : key.slice("modelLock_".length);
      Object.assign(patch, buildClearModelLockMetadataUpdate(lockModel));
    }
    if (remainingActiveLocks.length === 0
      && (current.testStatus === "unavailable" || current.lastError || current.errorCode || current.unavailabilityReason || current.backoffLevel)) {
      Object.assign(patch, {
        testStatus: "active",
        lastError: null,
        errorCode: null,
        unavailabilityReason: null,
        lastErrorAt: null,
        backoffLevel: 0,
      });
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }, { resetHealth: false });
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
