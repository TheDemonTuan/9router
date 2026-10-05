import { getExecutor } from "../executors/index.js";
import { withCredentialRefreshLock } from "./oauthCredentialManager.js";
import { U, fetchWithTimeout, cancelResponseBody } from "./usage/shared.js";
import {
  ANTIGRAVITY_MODEL_CACHE_TTL_MS,
  ANTIGRAVITY_MODEL_FETCH_TIMEOUT_MS,
  MAX_ANTIGRAVITY_OUTPUT_TOKENS,
  ANTIGRAVITY_INTERNAL_MODEL_IDS,
  NON_CHAT_MODALITY_RE,
  ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION,
  ANTIGRAVITY_VERSION_MANIFEST_URL,
  ANTIGRAVITY_VERSION_CACHE_TTL_MS,
  ANTIGRAVITY_VERSION_RETRY_MS,
  ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS,
  ANTIGRAVITY_DISCOVERY_USER_AGENT_SUFFIX,
} from "../config/antigravityModels.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { getModelUpstreamId } from "../config/providerModels.js";

const liveCache = new Map();
const liveInflight = new Map();
let lastValidVersion = null;
let lastFetchedAt = 0;
let lastFailedAt = 0;
let manifestInflight = null;

export function parseAntigravityManifestVersion(manifestText) {
  if (typeof manifestText !== "string" || !manifestText.trim()) return null;
  const lineRe = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/;
  for (const line of manifestText.split(/\r?\n/)) {
    const match = line.match(lineRe);
    if (!match) continue;
    const rawVersion = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (/^\d+\.\d+\.\d+$/.test(rawVersion)) {
      return rawVersion;
    }
    return null;
  }
  return null;
}

function buildDiscoveryProfile(version) {
  return {
    version,
    userAgent: `antigravity/hub/${version}${ANTIGRAVITY_DISCOVERY_USER_AGENT_SUFFIX}`,
  };
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    const err = signal.reason || new DOMException("This operation was aborted", "AbortError");
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || new DOMException("This operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

export function clearAntigravityDiscoveryProfileCache() {
  lastValidVersion = null;
  lastFetchedAt = 0;
  lastFailedAt = 0;
  manifestInflight = null;
}

export async function resolveAntigravityDiscoveryProfile(options = {}) {
  const signal = options.signal;
  if (signal?.aborted) {
    throw (signal.reason || new DOMException("This operation was aborted", "AbortError"));
  }

  const now = Date.now();
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh && lastValidVersion && (now - lastFetchedAt < ANTIGRAVITY_VERSION_CACHE_TTL_MS)) {
    return buildDiscoveryProfile(lastValidVersion);
  }

  if (!forceRefresh && lastFailedAt && (now - lastFailedAt < ANTIGRAVITY_VERSION_RETRY_MS)) {
    return buildDiscoveryProfile(lastValidVersion || ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
  }

  if (manifestInflight) {
    return waitWithSignal(manifestInflight, signal);
  }

  const task = (async () => {
    try {
      const response = await fetchWithTimeout(
        ANTIGRAVITY_VERSION_MANIFEST_URL,
        {
          method: "GET",
          headers: {
            "User-Agent": "electron-builder",
            "Cache-Control": "no-cache",
          },
        },
        ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS,
        options.proxyOptions
      );

      if (!response.ok) {
        cancelResponseBody(response);
        lastFailedAt = Date.now();
        return buildDiscoveryProfile(lastValidVersion || ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
      }

      const text = await response.text();
      const parsedVersion = parseAntigravityManifestVersion(text);
      if (parsedVersion) {
        lastValidVersion = parsedVersion;
        lastFetchedAt = Date.now();
        lastFailedAt = 0;
        return buildDiscoveryProfile(parsedVersion);
      }

      lastFailedAt = Date.now();
      return buildDiscoveryProfile(lastValidVersion || ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
    } catch {
      lastFailedAt = Date.now();
      return buildDiscoveryProfile(lastValidVersion || ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
    }
  })().finally(() => {
    manifestInflight = null;
  });

  manifestInflight = task;
  return waitWithSignal(task, signal);
}

function getConnectionId(connection) {
  return connection?.id || connection?.connectionId || "unknown";
}

function getCacheKey(connection, endpoint, proxyOptions, clientVersion = "") {
  const token = connection?.accessToken || connection?.apiKey || "";
  const fingerprint = token.length > 16 ? `${token.slice(0, 8)}...${token.slice(-6)}` : token;
  const proxyKey = proxyOptions?.url || proxyOptions?.connectionProxyUrl || "";
  return `${getConnectionId(connection)}::${endpoint}::${fingerprint}::${proxyKey}::${clientVersion}`;
}

export function normalizeAntigravityCatalog(payload) {
  const rawModels = payload?.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    throw new Error("Invalid Antigravity catalog response: missing models map");
  }

  const imageModelExclusions = new Set(
    Array.isArray(payload?.imageGenerationModelIds)
      ? payload.imageGenerationModelIds.filter((id) => typeof id === "string" && id.trim())
      : []
  );

  const normalized = [];
  for (const [modelId, meta] of Object.entries(rawModels)) {
    if (!modelId || typeof modelId !== "string" || !meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    if (meta.isInternal === true) continue;
    if (ANTIGRAVITY_INTERNAL_MODEL_IDS.has(modelId)) continue;
    if (imageModelExclusions.has(modelId)) continue;
    if (NON_CHAT_MODALITY_RE.test(modelId)) continue;

    const entry = {
      id: modelId,
      name: (typeof meta.displayName === "string" && meta.displayName.trim()) ? meta.displayName.trim() : modelId,
      capabilities: {},
    };

    if (Number.isFinite(meta.maxTokens) && meta.maxTokens > 0) {
      entry.contextLength = meta.maxTokens;
    }
    if (Number.isFinite(meta.maxOutputTokens) && meta.maxOutputTokens > 0) {
      entry.maxOutputTokens = Math.min(meta.maxOutputTokens, MAX_ANTIGRAVITY_OUTPUT_TOKENS);
    }
    if (typeof meta.supportsImages === "boolean") {
      entry.capabilities.vision = meta.supportsImages;
    }
    if (typeof meta.supportsThinking === "boolean") {
      entry.capabilities.reasoning = meta.supportsThinking;
    }

    normalized.push(entry);
  }

  return normalized;
}

export function isAntigravityModelAvailable(models = [], modelId = "") {
  if (!modelId || typeof modelId !== "string") return false;
  const bareId = stripThinkingSuffix(modelId).trim();
  const aliasUpstream = stripThinkingSuffix(getModelUpstreamId("ag", bareId) || "").trim();
  const allowed = new Set((models || []).map((m) => m?.id).filter(Boolean));
  return allowed.has(bareId) || (Boolean(aliasUpstream) && allowed.has(aliasUpstream));
}

export function clearAntigravityModelCache() {
  liveCache.clear();
  liveInflight.clear();
  clearAntigravityDiscoveryProfileCache();
}
async function requestCatalog(endpoint, accessToken, profile, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "X-Client-Name": "antigravity",
  };
  if (profile?.userAgent) {
    headers["User-Agent"] = profile.userAgent;
  }
  if (profile?.version) {
    headers["X-Client-Version"] = profile.version;
  }

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
    signal: options.signal,
  }, options.timeoutMs || ANTIGRAVITY_MODEL_FETCH_TIMEOUT_MS, options.proxyOptions);

  if (response.status === 401) {
    cancelResponseBody(response);
    return { status: 401, error: new Error("Unauthorized") };
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return { status: response.status, error: new Error(`HTTP ${response.status}: ${errorText}`) };
  }

  const payload = await response.json();
  const models = normalizeAntigravityCatalog(payload);
  return { status: 200, models };
}

export async function resolveAntigravityModels(connection, options = {}) {
  if (!connection?.accessToken && !connection?.apiKey) return null;
  if (options.signal?.aborted) {
    throw (options.signal.reason || new DOMException("This operation was aborted", "AbortError"));
  }

  const profile = await resolveAntigravityDiscoveryProfile({
    proxyOptions: options.proxyOptions,
    signal: options.signal,
    forceRefresh: options.forceRefresh,
  });

  const endpoint = U("antigravity").quotaApiUrl || "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
  const cacheKey = getCacheKey(connection, endpoint, options.proxyOptions, profile?.version || "");

  if (!options.forceRefresh) {
    const cached = liveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        resolved: true,
        models: cached.models,
        source: "cache",
        cached: true,
        fetchedAt: cached.fetchedAt,
        clientVersion: cached.clientVersion,
      };
    }
  }

  if (liveInflight.has(cacheKey)) {
    return liveInflight.get(cacheKey);
  }

  const inflight = (async () => {
    let activeToken = connection?.accessToken || connection?.apiKey;
    let result;
    try {
      result = await requestCatalog(endpoint, activeToken, profile, options);
      if (result.status === 401 && connection?.refreshToken) {
        options.log?.info?.("AG_MODELS", "Access token expired during discovery; attempting refresh.");
        const refreshed = await withCredentialRefreshLock("antigravity", connection, async () => {
          const executor = getExecutor("antigravity");
          return executor.refreshCredentials(connection, options.log, options.proxyOptions);
        });
        if (refreshed?.accessToken) {
          activeToken = refreshed.accessToken;
          connection.accessToken = refreshed.accessToken;
          if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
          await options.onCredentialsRefreshed?.(refreshed);
          result = await requestCatalog(endpoint, activeToken, profile, options);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw (options.signal.reason || error);
      options.log?.warn?.("AG_MODELS", `Catalog discovery failed: ${error?.message || error}`);
      return null;
    }

    if (!result || result.status !== 200) {
      options.log?.warn?.("AG_MODELS", `Catalog fetch returned ${result?.status}: ${result?.error?.message || "unknown error"}`);
      return null;
    }

    const fetchedAt = Date.now();
    const payload = {
      resolved: true,
      models: result.models,
      source: "live",
      fetchedAt,
      clientVersion: profile.version,
    };
    liveCache.set(cacheKey, {
      models: result.models,
      expiresAt: fetchedAt + ANTIGRAVITY_MODEL_CACHE_TTL_MS,
      fetchedAt,
      clientVersion: profile.version,
    });
    return payload;
  })().finally(() => {
    liveInflight.delete(cacheKey);
  });

  liveInflight.set(cacheKey, inflight);
  return inflight;
}
