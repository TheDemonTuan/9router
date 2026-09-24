// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);
// Total pre-response budget to guarantee origin returns HTTP response well before Cloudflare 125s timeout.
export const ROUTER_PRE_RESPONSE_BUDGET_MS = envMs("ROUTER_PRE_RESPONSE_BUDGET_MS", 100 * 1000);

// Downstream SSE heartbeat interval (comment : keepalive\n\n) to prevent proxy idle timeouts.
export const SSE_HEARTBEAT_INTERVAL_MS = envMs("SSE_HEARTBEAT_INTERVAL_MS", 15 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);
// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";
export const TOKEN_SAVER_HEADERS = ["x-9router-token-saver", "x-9r-token-saver"];

// Headroom gateway runtime limits and timeouts
export const HEADROOM_DEFAULT_TIMEOUT_MS = 10000;
export const HEADROOM_MAX_TIMEOUT_MS = 2147483647;

export function isValidHeadroomTimeout(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= HEADROOM_MAX_TIMEOUT_MS;
}

export function resolveHeadroomTimeout(configuredTimeoutMs, envValue = process.env.HEADROOM_DEFAULT_TIMEOUT_MS) {
  if (typeof envValue === "string" && /^\d+$/.test(envValue.trim())) {
    const value = Number(envValue.trim());
    if (isValidHeadroomTimeout(value)) return { timeoutMs: value, source: "env" };
  }
  if (isValidHeadroomTimeout(configuredTimeoutMs)) return { timeoutMs: configuredTimeoutMs, source: "settings" };
  return { timeoutMs: HEADROOM_DEFAULT_TIMEOUT_MS, source: "default" };
}
export const HEADROOM_RESERVE_TIMEOUT_MS = envMs("HEADROOM_RESERVE_TIMEOUT_MS", 1500);
export const HEADROOM_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20MB
export const HEADROOM_CIRCUIT_FAILURE_THRESHOLD = 3;
export const HEADROOM_CIRCUIT_COOLDOWN_MS = 30000;
export const HEADROOM_METRIC_SAMPLE_LIMIT = 2048;
export const HEADROOM_RUNTIME_MAX_ENDPOINTS = 64;
export const HEADROOM_GATEWAY_TURN_TTL_SECONDS = parseInt(process.env.HEADROOM_GATEWAY_TURN_TTL_SECONDS || "120", 10) || 120;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 1, delayMs: 3000 }
};
// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
