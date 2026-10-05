import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { MAX_BROWSER_TURNS, MODEL_SLUG_PATTERN, PROTOCOL_VERSION, REASONING_LEVELS, SERVICE_NAME, validateProfileId } from "../../services/chatgpt-web-runtime/protocol.js";

const CATALOG_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3000;
const CATALOG_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 64;
const cache = new Map();
const dispatcher = new Agent();
const CAPABILITY_KEYS = ["text", "vision", "reasoning", "tools", "search", "compact", "native_responses", "generic_responses", "mcp_tools", "exec", "subagents", "computer_use", "browser_tool", "streaming"];
const DATA_PATHS = ["/healthz", "/readyz", "/v1/web-models", "/v1/thread-bindings/resolve", "/v1/responses", "/v1/responses/compact", "/v1/interrupt-turn"];
const ADMIN_PATHS = ["/admin/profiles", "/admin/session/verify", "/admin/session/import", "/admin/login/start", "/admin/login/complete", "/admin/login/status", "/admin/login/session", "/admin/login/close", "/admin/browser/view", "/admin/browser/restart", "/admin/smoke", "/admin/drain", "/admin/quiesce", "/admin/resume", "/admin/interrupt-turn"];
export const CHATGPT_WEB_MAX_CONCURRENCY = MAX_BROWSER_TURNS;
export function validateChatGptWebProfileId(value) { return validateProfileId(value); }
export function sanitizeChatGptWebMaxConcurrency(value) { return value === MAX_BROWSER_TURNS ? MAX_BROWSER_TURNS : null; }
function runtimeUrl() {
  const raw = process.env.CHATGPT_WEB_RUNTIME_URL?.trim();
  if (!raw) throw new Error("CHATGPT_WEB_RUNTIME_URL is required");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid operator ChatGPT Web runtime URL");
  return url.origin;
}
async function token(admin) {
  const path = process.env[admin ? "CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE" : "CHATGPT_WEB_RUNTIME_TOKEN_FILE"]?.trim();
  if (!path) throw new Error("ChatGPT Web runtime secret file is required");
  const secret = (await readFile(path, "utf8")).trim();
  if (secret.length < 32 || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new Error("Invalid runtime bearer secret");
  return secret;
}
async function runtimeRequest(path, init, options, admin, profileId) {
  const url = new URL(path, "http://internal.invalid");
  const allowed = admin ? ADMIN_PATHS.includes(url.pathname) || /^\/admin\/profiles\/[a-z0-9-]+$/.test(url.pathname) : DATA_PATHS.includes(url.pathname);
  if (!allowed || url.origin !== "http://internal.invalid" || url.hash || url.search && !(admin && ["/admin/login/status", "/admin/login/session"].includes(url.pathname))) throw new Error("Unsupported internal runtime endpoint");
  const headers = new Headers(init.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-cgw-") || name === "x-9router-cgw-attestation" || name === "authorization" || name === "x-codex-turn-metadata") headers.delete(name);
  headers.set("authorization", `Bearer ${await token(admin)}`);
  if (profileId) headers.set("x-cgw-profile-id", validateProfileId(profileId));
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : null;
  const signal = init.signal && timeout ? AbortSignal.any([init.signal, timeout]) : init.signal || timeout || undefined;
  // An explicit direct dispatcher never consumes HTTP_PROXY/HTTPS_PROXY environment state.
  return undiciFetch(`${runtimeUrl()}${url.pathname}${url.search}`, { ...init, headers, signal, redirect: "error", dispatcher });
}
export function requestChatGptWebRuntime(connection, path, init = {}, options = {}) {
  const profileId = connection?.providerSpecificData?.profileId;
  if (!profileId && !["/healthz", "/v1/thread-bindings/resolve", "/v1/interrupt-turn"].includes(path)) throw new Error("ChatGPT Web profileId is required");
  return runtimeRequest(path, init, options, false, profileId);
}
export function requestChatGptWebRuntimeAdmin(path, init = {}, options = {}) {
  return runtimeRequest(path, init, options, true, null);
}
function parseRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id.startsWith("chatgpt-web/")) return null;
  const slug = row.id.slice(12);
  if (!slug || slug.length > 128 || !MODEL_SLUG_PATTERN.test(slug)) return null;
  const levels = row.supported_reasoning_levels;
  if (!Array.isArray(levels) || levels.length === 0 || levels.some(value => !REASONING_LEVELS.includes(value)) || new Set(levels).size !== levels.length
    || !levels.includes(row.default_reasoning_level) || typeof row.legacy !== "boolean"
    || row.model_family !== undefined && !["5.6", "6"].includes(row.model_family)
    || !Number.isSafeInteger(row.context_window) || row.context_window <= 0 || !Number.isSafeInteger(row.auto_compact_token_limit) || row.auto_compact_token_limit <= 0
    || row.auto_compact_token_limit > row.context_window || row.max_output !== undefined && (!Number.isSafeInteger(row.max_output) || row.max_output <= 0)) return null;
  if (!row.capabilities || typeof row.capabilities !== "object" || Array.isArray(row.capabilities)) return null;
  const capabilities = {};
  for (const name of CAPABILITY_KEYS) if (typeof row.capabilities[name] === "boolean") capabilities[name] = row.capabilities[name];
  if (Object.keys(capabilities).length === 0) return null;
  return { id: row.id, name: typeof row.display_name === "string" ? row.display_name : row.id, display_name: typeof row.display_name === "string" ? row.display_name : row.id,
    supported_reasoning_levels: [...levels], default_reasoning_level: row.default_reasoning_level,
    ...(row.model_family ? { model_family: row.model_family } : {}), legacy: row.legacy, context_window: row.context_window,
    auto_compact_token_limit: row.auto_compact_token_limit, ...(row.max_output ? { max_output: row.max_output } : {}), capabilities };
}
export function parseChatGptWebCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.profile_epoch !== "string" || !value.profile_epoch || typeof value.catalog_revision !== "string" || !value.catalog_revision
    || typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at)) || value.max_concurrency !== MAX_BROWSER_TURNS || !Array.isArray(value.models)) throw new Error("Invalid runtime catalog contract");
  const profileId = validateProfileId(value.profile_id), models = [], seen = new Set();
  for (const row of value.models) {
    const model = parseRow(row); if (!model || model.legacy || model.supported_reasoning_levels.includes("ultra") || seen.has(model.id)) continue;
    seen.add(model.id); models.push(model);
  }
  if (!models.length) throw new Error("Runtime catalog has no verified model rows");
  return { models, profileId, profileEpoch: value.profile_epoch, revision: value.catalog_revision, checkedAt: value.checked_at, maxConcurrency: MAX_BROWSER_TURNS };
}
export function chatGptWebModelSupportsCapabilities(model, required) {
  return !required?.size || [...required].every(capability => model?.capabilities?.[capability] === true);
}
export function chatGptWebModelSupportsNativeResponses(model) { return model?.capabilities?.native_responses === true; }
export function hasChatGptWebModel(catalog, model) { return catalog?.stale !== true && catalog?.models?.some(row => row.id === model) === true; }
function cacheKey(profileId) { return `${runtimeUrl()}\0${validateProfileId(profileId)}`; }
function waitForCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException("Caller aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
export function invalidateChatGptWebCatalog(profileId) {
  if (profileId === undefined) { cache.clear(); return; }
  cache.delete(cacheKey(profileId));
}
export async function getChatGptWebHealth(connection, { signal } = {}) {
  const response = await requestChatGptWebRuntime(connection, "/healthz", { signal }, { timeoutMs: HEALTH_TIMEOUT_MS });
  const value = await response.json();
  if (!response.ok || value.service !== SERVICE_NAME || value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Runtime health protocol unavailable");
  return value;
}
export function getChatGptWebCatalog(connection, { signal, force = false } = {}) {
  const profileId = validateProfileId(connection?.providerSpecificData?.profileId), key = cacheKey(profileId);
  let entry = cache.get(key);
  if (!force && entry?.catalog && Date.now() - entry.checkedAt < CATALOG_TTL_MS) return waitForCaller(Promise.resolve(entry.catalog), signal);
  if (!entry?.pending) {
    entry = entry || { catalog: null, checkedAt: 0 }; cache.set(key, entry);
    const owner = entry;
    owner.pending = (async () => {
      const response = await requestChatGptWebRuntime(connection, "/v1/web-models", {}, { timeoutMs: CATALOG_TIMEOUT_MS });
      if (!response.ok) throw new Error(`Runtime catalog unavailable (${response.status})`);
      const catalog = parseChatGptWebCatalog(await response.json());
      if (catalog.profileId !== profileId) { cache.delete(key); throw new Error("Runtime catalog profile mismatch"); }
      if (owner.catalog && catalog.profileEpoch !== owner.catalog.profileEpoch) owner.catalog = null;
      owner.catalog = { ...catalog, stale: false }; owner.checkedAt = Date.now();
      return owner.catalog;
    })().catch(error => { owner.catalog = null; owner.checkedAt = 0; throw error; }).finally(() => { owner.pending = null; });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }
  return waitForCaller(entry.pending, signal);
}
