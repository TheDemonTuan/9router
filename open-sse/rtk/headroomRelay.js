// open-sse/rtk/headroomRelay.js
// Usage-only response relay for Headroom 0.38.0 Gateway (POST /v1/compress/response).
// Gated strictly on obligations.relay_usage === true.
// Bounded async, non-blocking, fail-open, no client latency, no raw response.

import { HEADROOM_GATEWAY_TURN_TTL_SECONDS } from "../config/runtimeConfig.js";

const RELAY_TIMEOUT_MS = 1500;

function buildResponseEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress/response`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const clean = String(rawUrl).replace(/#.*$/, "");
    const [base, query = ""] = clean.split("?", 2);
    const endpoint = `${base.replace(/\/$/, "")}/v1/compress/response`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

/**
 * Normalize provider-specific usage counters into a standard format without double-counting.
 */
export function normalizeRelayUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  // OpenAI format
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cachedContentTokenCount
    ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens,
  };
}

/**
 * Creates a per-attempt complete-once turn context for response usage relay.
 */
export function createHeadroomTurnContext({
  url,
  proxyToken = "",
  turnId = null,
  obligations = {},
  startTime = Date.now(),
  log = null,
} = {}) {
  // If relay_usage obligation is not explicitly true, return a no-op context
  if (!url || !turnId || obligations?.relay_usage !== true) {
    return {
      complete: () => {},
      isEligible: false,
    };
  }

  let completed = false;

  const complete = ({ status = "completed", usage = null, error = null, latencyMs = null } = {}) => {
    if (completed) return;
    completed = true;

    const effectiveLatency = typeof latencyMs === "number" ? latencyMs : (Date.now() - startTime);
    const normalizedUsage = normalizeRelayUsage(usage);

    const payload = {
      turn_id: turnId,
      status: error ? "error" : status,
      latency_ms: effectiveLatency,
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
      ttl_seconds: HEADROOM_GATEWAY_TURN_TTL_SECONDS,
    };

    const endpoint = buildResponseEndpoint(url);
    const headers = { "Content-Type": "application/json" };
    if (proxyToken) {
      headers["X-Headroom-Proxy-Token"] = proxyToken;
    }

    // Fire-and-forget bounded async relay: do not block or throw
    fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "manual",
    }).catch((err) => {
      log?.debug?.("HEADROOM_RELAY", `relay failed: ${err.message || String(err)}`);
    });
  };

  return {
    complete,
    isEligible: true,
    turnId,
  };
}
