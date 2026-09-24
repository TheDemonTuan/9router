// open-sse/rtk/headroomRelay.js
// Usage-only response relay for Headroom 0.38.0 Gateway (POST /v1/compress/response).
// Gated strictly on obligations containing "relay_usage".
// Bounded async, non-blocking, fail-open, no client latency, no raw response.

import { isSafeOrigin } from "./headroomGateway.js";

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
 * Check if obligations include relay_usage (Headroom 0.38 array format or legacy object).
 */
export function hasRelayUsage(obligations) {
  if (Array.isArray(obligations)) {
    return obligations.includes("relay_usage");
  }
  return obligations?.relay_usage === true;
}

/**
 * Normalize provider-specific usage counters into a standard format without double-counting.
 * Preserves both cache read and cache creation tokens for accurate upstream accounting.
 */
export function normalizeRelayUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cachedContentTokenCount
    ?? 0;
  const cacheCreationTokens = usage.prompt_tokens_details?.cache_creation_tokens
    ?? usage.cache_creation_input_tokens
    ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  const res = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens,
  };

  if (cacheCreationTokens > 0) {
    res.cache_creation_input_tokens = cacheCreationTokens;
  }
  if (usage.cache_read_input_tokens !== undefined) {
    res.cache_read_input_tokens = cachedTokens;
  }

  return res;
}

/**
 * Creates a per-attempt complete-once turn context for response usage relay.
 */
export function createHeadroomTurnContext({
  url,
  proxyToken = "",
  turnId = null,
  obligations = [],
  startTime = Date.now(),
  log = null,
} = {}) {
  // If relay_usage obligation is not explicitly present, return a no-op context
  if (!url || !turnId || !hasRelayUsage(obligations)) {
    return {
      complete: () => {},
      isEligible: false,
    };
  }

  let completed = false;

  const complete = ({ statusCode = 200, status = null, usage = null, error = null, latencyMs = null } = {}) => {
    if (completed) return;
    completed = true;

    const effectiveLatency = typeof latencyMs === "number" ? Math.max(0, latencyMs) : Math.max(0, Date.now() - startTime);
    const normalizedUsage = normalizeRelayUsage(usage);

    let finalStatus = 200;
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
      finalStatus = statusCode;
    } else if (Number.isInteger(status) && status >= 100 && status <= 599) {
      finalStatus = status;
    } else if (error) {
      const errCode = Number(error?.status || error?.statusCode);
      finalStatus = Number.isInteger(errCode) && errCode >= 100 && errCode <= 599 ? errCode : 502;
    } else if (status === "error" || status === "failed") {
      finalStatus = 502;
    }

    const payload = {
      turn_id: turnId,
      status: finalStatus,
      latency_ms: effectiveLatency,
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    };

    const endpoint = buildResponseEndpoint(url);
    if (!isSafeOrigin(endpoint)) {
      log?.debug?.("HEADROOM_RELAY", `relay skipped: unsafe origin ${endpoint}`);
      return;
    }

    const headers = { "Content-Type": "application/json" };
    const parsedEndpoint = (() => { try { return new URL(endpoint); } catch { return null; } })();
    if (proxyToken && !parsedEndpoint?.username && !parsedEndpoint?.password) {
      headers["X-Headroom-Proxy-Token"] = proxyToken;
    }

    // Fire-and-forget bounded async relay: do not block or throw
    fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      redirect: "manual",
    }).then((res) => {
      if (!res.ok) {
        log?.debug?.("HEADROOM_RELAY", `relay HTTP error: ${res.status}`);
      }
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
