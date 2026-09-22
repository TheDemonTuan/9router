import { hostname } from "node:os";
import {
  chatGptWebModelSupportsNativeResponses,
  getChatGptWebCatalog,
  hasChatGptWebModel,
  requestChatGptWebBridge,
  sanitizeChatGptWebMaxConcurrency,
} from "../services/chatgptWebBridge.js";

const FORWARDED_HEADERS = new Set([
  "originator",
  "user-agent",
  "x-codex-turn-metadata",
  "x-codex-client-version",
  "x-codex-beta-features",
]);
const TERMINAL_BRIDGE_STATUSES = new Set([499, 409, 413, 424, 502]);
const SAFE_RETRY_CODES = new Set([
  "bridge_offline",
  "provider_busy",
  "service_unavailable",
  "temporarily_unavailable",
  "rate_limit_exceeded",
  "rate_limited",
  "concurrency_limit",
]);
const QUOTA_CODES = new Set(["usage_limit_reached", "insufficient_quota", "quota_exhausted"]);

function normalizedErrorCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeRetryableBridgeError(status, code, message = "") {
  if (TERMINAL_BRIDGE_STATUSES.has(status) || ![429, 503].includes(status)) return false;
  if (QUOTA_CODES.has(normalizedErrorCode(code))) return false;
  const normalizedCode = normalizedErrorCode(code);
  const text = String(message).toLowerCase();
  return !normalizedCode
    || SAFE_RETRY_CODES.has(normalizedCode)
    || /provider\s*busy|temporarily unavailable|too many requests|rate limit/.test(text);
}

function safeResolvedModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model && model.length <= 128 && !/[\r\n]/.test(model) ? model : null;
}

function resolvedModelFromHeaders(headers) {
  for (const name of ["x-9router-resolved-model", "x-resolved-model", "resolved-model"]) {
    const value = safeResolvedModel(headers.get(name));
    if (value) return value;
  }
  return null;
}

function bridgeError(status, code, message) {
  const retryable = safeRetryableBridgeError(status, code);
  const headers = {
    "content-type": "application/json",
    "x-9router-error-code": code,
    "x-should-retry": String(retryable),
    // A Web conversation cannot move to another browser profile mid-turn. The client may retry
    // a retryable 429/503, but the router must not silently fail over this connection.
    "x-9router-no-fallback": "true",
  };
  return new Response(JSON.stringify({ error: { type: "bridge_error", code, message, retryable } }), {
    status,
    headers,
  });
}

function upstreamHeaders(rawHeaders = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (FORWARDED_HEADERS.has(lower) && typeof value === "string") headers.set(lower, value);
  }
  headers.set("x-9router-instance-id", `${hostname()}-${process.pid}`);
  return headers;
}

function resetTimestamp(value, now = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    return ms > now ? ms : null;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return resetTimestamp(numeric, now);
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > now ? ms : null;
  }
  return null;
}

function retryAfterTimestamp(value, now = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return now + value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return retryAfterTimestamp(numeric, now);
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > now ? ms : null;
  }
  return null;
}

export class ChatGPTWebExecutor {
  constructor() {
    this.provider = "chatgpt-web";
    this.noAuth = true;
  }

  getProvider() {
    return this.provider;
  }

  needsRefresh() {
    return false;
  }

  async refreshCredentials() {
    return null;
  }

  parseError(response, bodyText) {
    let body = null;
    try { body = JSON.parse(bodyText); } catch { /* use headers */ }
    const error = body?.error && typeof body.error === "object" ? body.error : body || {};
    const message = error.message || body?.message || bodyText || `HTTP ${response.status}`;
    const code = error.code || response.headers.get("x-9router-error-code") || "";
    const now = Date.now();
    const resetsAtMs = resetTimestamp(
      error.resets_at ?? error.reset_at ?? error.resetAt ?? body?.resets_at ?? body?.reset_at,
      now,
    )
      || retryAfterTimestamp(error.resets_in_seconds ?? error.retry_after ?? body?.retry_after, now)
      || resetTimestamp(response.headers.get("x-ratelimit-reset-at") || response.headers.get("x-ratelimit-reset"), now)
      || retryAfterTimestamp(response.headers.get("retry-after"), now);
    const resolvedModel = safeResolvedModel(error.resolved_model ?? error.resolvedModel ?? error.model)
      || resolvedModelFromHeaders(response.headers);
    return {
      status: response.status,
      message,
      ...(resetsAtMs ? { resetsAtMs } : {}),
      ...(error.type || error.error_type ? { type: error.type || error.error_type } : {}),
      ...(code ? { code } : {}),
      retryable: safeRetryableBridgeError(response.status, code, message) && error.retryable !== false,
      ...(resolvedModel ? { resolvedModel } : {}),
    };
  }

  async execute({ model, body, credentials, signal, clientTool }) {
    const operation = body?._compact === true ? "compact" : "responses";
    const outbound = { ...body, model };
    delete outbound._compact;
    // The bridge emits SSE for both turn endpoints; chatCore may still receive stream:false.
    outbound.stream = true;

    let catalog;
    try {
      catalog = await getChatGptWebCatalog(credentials, { signal });
    } catch (error) {
      return {
        response: bridgeError(503, "bridge_offline", error.message),
        url: "unix:/v1/web-models",
        headers: {},
        transformedBody: outbound,
      };
    }
    const liveModel = catalog.models?.find((entry) => entry.id === model);
    if (catalog.stale || !hasChatGptWebModel(catalog, model)) {
      return {
        response: bridgeError(409, catalog.stale ? "catalog_stale" : "model_unavailable", `Bridge has not verified model ${model}`),
        url: "unix:/v1/web-models",
        headers: {},
        transformedBody: outbound,
      };
    }
    const requiredCapability = clientTool === "codex" ? "native_responses" : "generic_responses";
    const capabilityVerified = clientTool === "codex"
      ? chatGptWebModelSupportsNativeResponses(liveModel)
      : liveModel?.capabilities?.generic_responses === true;
    if (!capabilityVerified) {
      return {
        response: bridgeError(400, "unsupported_capability", `${requiredCapability} is not verified for ${model}`),
        url: "unix:/v1/web-models",
        headers: {},
        transformedBody: outbound,
      };
    }

    const path = operation === "compact" ? "/v1/responses/compact" : "/v1/responses";
    const headers = upstreamHeaders(credentials?.rawHeaders);
    let response;
    try {
      response = await requestChatGptWebBridge(credentials, path, {
        method: "POST",
        headers,
        body: JSON.stringify(outbound),
        signal,
      }, {
        turn: true,
        maxConcurrency: sanitizeChatGptWebMaxConcurrency(
          credentials?.providerSpecificData?.maxConcurrency ?? catalog.maxConcurrency,
        ),
      });
    } catch (error) {
      response = bridgeError(signal?.aborted ? 499 : 502, signal?.aborted ? "client_cancelled" : "submission_unknown", error.message);
    }

    const responseHeaders = new Headers(response.headers);
    if (!response.ok) {
      // Consume wrapped error bodies so the per-connection turn slot releases before
      // chatCore rebuilds or forwards the terminal response.
      const bodyText = await response.text();
      const parsed = this.parseError(response, bodyText);
      const code = parsed.code || responseHeaders.get("x-9router-error-code") || "bridge_terminal_error";
      const retryable = safeRetryableBridgeError(response.status, code)
        && parsed.retryable !== false;
      const resolvedModel = safeResolvedModel(parsed.resolvedModel) || resolvedModelFromHeaders(responseHeaders);
      if (resolvedModel) responseHeaders.set("x-9router-resolved-model", resolvedModel);
      if (parsed.resetsAtMs) responseHeaders.set("x-9router-retry-at", new Date(parsed.resetsAtMs).toISOString());
      responseHeaders.set("x-9router-error-code", code);
      responseHeaders.set("x-should-retry", String(retryable));
      // Retryability is a client hint only; account fallback remains disabled for stateful Web turns.
      responseHeaders.set("x-9router-no-fallback", "true");
      response = new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    return { response, url: `unix:${path}`, headers: Object.fromEntries(headers), transformedBody: outbound };
  }
}

export default ChatGPTWebExecutor;
