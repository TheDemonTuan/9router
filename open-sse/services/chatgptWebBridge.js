import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";

const BRIDGE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MODEL_PREFIX = "chatgpt-web/";
const CATALOG_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;
const CATALOG_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 64;
export const CHATGPT_WEB_MAX_CONCURRENCY = 5;
const cache = new Map();
const dispatchers = new Map();
const turnSlots = new Map();
const TURN_PATHS = new Set(["/v1/responses", "/v1/responses/compact"]);

export function validateChatGptWebBridgeId(value) {
  const bridgeId = typeof value === "string" ? value.trim() : "";
  if (!BRIDGE_ID.test(bridgeId)) throw new Error("bridgeId must be a lowercase slug");
  return bridgeId;
}

export function chatGptWebSocketRoot() {
  return resolve(/* turbopackIgnore: true */ process.env.CHATGPT_WEB_BRIDGE_SOCKET_ROOT || "/run/9router-chatgpt-web");
}

export async function resolveChatGptWebSocket(bridgeId, { platform = process.platform } = {}) {
  const id = validateChatGptWebBridgeId(bridgeId);
  const root = chatGptWebSocketRoot();
  const socketPath = join(root, `${id}.sock`);
  const rel = relative(root, socketPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(socketPath) !== socketPath) {
    throw new Error("Bridge socket escapes the configured root");
  }
  if (platform === "win32") return socketPath;
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Bridge socket root is not a real directory");
  const [realRoot, realParent, stat] = await Promise.all([
    realpath(/* turbopackIgnore: true */ root),
    realpath(/* turbopackIgnore: true */ dirname(socketPath)),
    lstat(socketPath),
  ]);
  if (realParent !== realRoot) throw new Error("Bridge socket parent resolves outside the configured root");
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("Bridge endpoint is not a Unix socket");
  return socketPath;
}

const LIVE_CAPABILITY_KEYS = [
  "text",
  "vision",
  "reasoning",
  "tools",
  "search",
  "compact",
  "native_responses",
  "generic_responses",
];

function safeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capabilities = {};
  for (const key of LIVE_CAPABILITY_KEYS) {
    if (typeof value[key] === "boolean") capabilities[key] = value[key];
  }
  return Object.keys(capabilities).length > 0 ? capabilities : null;
}

function safePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function sanitizeChatGptWebMaxConcurrency(value) {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, CHATGPT_WEB_MAX_CONCURRENCY)
    : null;
}

function chatGptWebConnectionKey(connection) {
  return String(connection?.providerSpecificData?.bridgeId || connection?.id || "unknown");
}

export function tryAcquireChatGptWebTurn(connection, requestedLimit) {
  const key = chatGptWebConnectionKey(connection);
  const limit = sanitizeChatGptWebMaxConcurrency(requestedLimit) || CHATGPT_WEB_MAX_CONCURRENCY;
  const state = turnSlots.get(key) || { active: 0 };
  if (state.active >= limit) return null;
  state.active += 1;
  turnSlots.set(key, state);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active -= 1;
    if (state.active === 0) turnSlots.delete(key);
  };
}

export function resetChatGptWebTurnSlots() {
  turnSlots.clear();
}

function safeModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id : typeof value.slug === "string" ? value.slug : "";
  const slug = id.slice(MODEL_PREFIX.length);
  if (!id.startsWith(MODEL_PREFIX) || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) return null;
  const capabilities = safeCapabilities(value.capabilities);
  const contextWindow = safePositiveNumber(value.context_window);
  const maxOutput = safePositiveNumber(value.max_output);
  const autoCompactTokenLimit = safePositiveNumber(value.auto_compact_token_limit);
  return {
    id,
    name: typeof value.name === "string" ? value.name : typeof value.display_name === "string" ? value.display_name : id,
    ...(capabilities ? { capabilities } : {}),
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxOutput ? { max_output: maxOutput } : {}),
    ...(autoCompactTokenLimit ? { auto_compact_token_limit: autoCompactTokenLimit } : {}),
  };
}

export function chatGptWebModelSupportsCapabilities(model, required) {
  if (!required || required.size === 0) return true;
  const capabilities = model?.capabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  return [...required].every((capability) => capabilities[capability] === true);
}

export function chatGptWebModelSupportsNativeResponses(model) {
  return model?.capabilities?.native_responses === true;
}

export function parseChatGptWebCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge catalog must be an object");
  const rows = Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : null;
  if (!rows) throw new Error("Bridge catalog is missing models");
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const model = safeModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  const maxConcurrency = sanitizeChatGptWebMaxConcurrency(value.max_concurrency ?? value.maxConcurrency);
  return {
    models,
    bridgeIdentity: typeof value.profile_identity === "string" ? value.profile_identity : null,
    revision: typeof value.catalog_revision === "string" || typeof value.catalog_revision === "number" ? String(value.catalog_revision) : null,
    checkedAt: typeof value.checked_at === "string" ? value.checked_at : null,
    ...(maxConcurrency ? { maxConcurrency } : {}),
  };
}

function withDeadline(signal, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function waitForCallerAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function socketFetch(socketPath, path, init = {}, fetchImpl = undiciFetch) {
  let dispatcher = dispatchers.get(socketPath);
  if (!dispatcher) {
    dispatcher = new Agent({ connect: { socketPath } });
    dispatchers.set(socketPath, dispatcher);
  }
  return fetchImpl(`http://localhost${path}`, { ...init, dispatcher });
}

export function chatGptWebProviderBusyResponse() {
  return new Response(JSON.stringify({
    error: {
      type: "bridge_error",
      code: "provider_busy",
      message: "ChatGPT Web bridge has reached its active turn limit",
    },
  }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "x-9router-no-fallback": "true",
      "x-should-retry": "false",
      "x-9router-error-code": "provider_busy",
    },
  });
}

function holdSlotUntilBodyDone(response, release, signal) {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const onAbort = () => {
    releaseOnce();
    reader.cancel(signal.reason).catch(() => {});
  };
  const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
  const releaseOnce = () => {
    if (finished) return;
    finished = true;
    removeAbortListener();
    release();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      try {
        await reader.cancel(reason);
      } catch {
        // Upstream may already be closed or aborted.
      }
    },
  });

  try {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    releaseOnce();
    reader.cancel(error).catch(() => {});
    throw error;
  }
}

export async function requestChatGptWebBridge(connection, path, init = {}, options = {}) {
  const socketPath = options.socketPath || await resolveChatGptWebSocket(connection?.providerSpecificData?.bridgeId);
  const release = options.turn && TURN_PATHS.has(path)
    ? tryAcquireChatGptWebTurn(connection, options.maxConcurrency)
    : null;
  if (options.turn && TURN_PATHS.has(path) && !release) return chatGptWebProviderBusyResponse();
  try {
    const response = await socketFetch(socketPath, path, init, options.fetchImpl);
    return release ? holdSlotUntilBodyDone(response, release, init.signal) : response;
  } catch (error) {
    release?.();
    throw error;
  }
}

export async function getChatGptWebHealth(connection, options = {}) {
  const response = await requestChatGptWebBridge(connection, "/healthz", {
    method: "GET",
    signal: withDeadline(options.signal, options.timeoutMs || HEALTH_TIMEOUT_MS),
  }, options);
  if (!response.ok) throw new Error(`Bridge health returned HTTP ${response.status}`);
  const value = await response.json();
  if (!value || value.service !== "codex-chatgpt-web") throw new Error("Unexpected bridge health response");
  return value;
}

export async function getChatGptWebCatalog(connection, { force = false, ...options } = {}) {
  const key = connection?.id || validateChatGptWebBridgeId(connection?.providerSpecificData?.bridgeId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit?.pending) return waitForCallerAbort(hit.pending, options.signal);
  if (!force && hit?.value && hit.expiresAt > now) return { ...hit.value, stale: false };
  const pending = (async () => {
    const response = await requestChatGptWebBridge(connection, "/v1/web-models", {
      method: "GET",
      signal: withDeadline(options.signal, options.timeoutMs || CATALOG_TIMEOUT_MS),
    }, options);
    if (!response.ok) throw new Error(`Bridge catalog returned HTTP ${response.status}`);
    const value = parseChatGptWebCatalog(await response.json());
    cache.delete(key);
    cache.set(key, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return { ...value, stale: false };
  })();
  // A caller abort can reject waitForCallerAbort before the underlying fetch settles.
  // Always clear that pending entry so the next request can retry instead of inheriting a dead promise.
  pending.catch(() => {
    if (cache.get(key)?.pending !== pending) return;
    if (hit?.value) cache.set(key, { value: hit.value, expiresAt: 0 });
    else cache.delete(key);
  });
  cache.set(key, { ...hit, pending });
  try {
    return await waitForCallerAbort(pending, options.signal);
  } catch (error) {
    if (cache.get(key)?.pending === pending) {
      if (hit?.value) cache.set(key, { value: hit.value, expiresAt: 0 });
      else cache.delete(key);
    }
    if (options.signal?.aborted) throw error;
    if (hit?.value) {
      cache.set(key, { value: hit.value, expiresAt: 0 });
      return { ...hit.value, stale: true, error: error.message };
    }
    throw error;
  }
}

export function invalidateChatGptWebCatalog(connectionId) {
  if (connectionId) cache.delete(connectionId);
  else cache.clear();
}

export function hasChatGptWebModel(catalog, modelId) {
  return catalog?.models?.some((model) => model.id === modelId) === true;
}
