import { getExecutor } from "../executors/index.js";
import { withCredentialRefreshLock } from "./oauthCredentialManager.js";
import { U, fetchWithTimeout, cancelResponseBody } from "./usage/shared.js";
import {
  ANTIGRAVITY_MODEL_CACHE_TTL_MS,
  ANTIGRAVITY_MODEL_FETCH_TIMEOUT_MS,
  MAX_ANTIGRAVITY_OUTPUT_TOKENS,
  ANTIGRAVITY_INTERNAL_MODEL_IDS,
  NON_CHAT_MODALITY_RE,
} from "../config/antigravityModels.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { getModelUpstreamId } from "../config/providerModels.js";

const liveCache = new Map();
const liveInflight = new Map();

function getConnectionId(connection) {
  return connection?.id || connection?.connectionId || "unknown";
}

function getCacheKey(connection, endpoint, proxyOptions) {
  const token = connection?.accessToken || connection?.apiKey || "";
  const fingerprint = token.length > 16 ? `${token.slice(0, 8)}...${token.slice(-6)}` : token;
  const proxyKey = proxyOptions?.url || proxyOptions?.connectionProxyUrl || "";
  return `${getConnectionId(connection)}::${endpoint}::${fingerprint}::${proxyKey}`;
}

export function normalizeAntigravityCatalog(payload) {
  const rawModels = payload?.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    throw new Error("Invalid Antigravity catalog response: missing models map");
  }

  const normalized = [];
  for (const [modelId, meta] of Object.entries(rawModels)) {
    if (!modelId || typeof modelId !== "string" || !meta || typeof meta !== "object") continue;
    if (meta.isInternal === true) continue;
    if (ANTIGRAVITY_INTERNAL_MODEL_IDS.has(modelId)) continue;
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
}

async function requestCatalog(endpoint, accessToken, options = {}) {
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-Client-Name": "antigravity",
    },
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
  const endpoint = U("antigravity").quotaApiUrl || "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
  const cacheKey = getCacheKey(connection, endpoint, options.proxyOptions);

  if (!options.forceRefresh) {
    const cached = liveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { resolved: true, models: cached.models, source: "cache", cached: true };
    }
  }

  if (liveInflight.has(cacheKey)) {
    return liveInflight.get(cacheKey);
  }

  const inflight = (async () => {
    let activeToken = connection?.accessToken || connection?.apiKey;
    let result;
    try {
      result = await requestCatalog(endpoint, activeToken, options);
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
          result = await requestCatalog(endpoint, activeToken, options);
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

    const payload = {
      resolved: true,
      models: result.models,
      source: "live",
      fetchedAt: Date.now(),
    };
    liveCache.set(cacheKey, {
      models: result.models,
      expiresAt: Date.now() + ANTIGRAVITY_MODEL_CACHE_TTL_MS,
    });
    return payload;
  })().finally(() => {
    liveInflight.delete(cacheKey);
  });

  liveInflight.set(cacheKey, inflight);
  return inflight;
}
