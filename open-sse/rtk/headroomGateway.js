// open-sse/rtk/headroomGateway.js
// Native Gateway v2 client for Headroom 0.38.0 (commit 94206e2).
// Stateless, marker-free, no model routing, no output shaper, no tool search.
// Provider request headers extracted from gateway response and forwarded to upstream executor.

import {
  resolveHeadroomTimeout,
  HEADROOM_DEFAULT_TIMEOUT_MS,
  HEADROOM_RESERVE_TIMEOUT_MS,
  HEADROOM_UPSTREAM_MARGIN_MS,
  HEADROOM_UPSTREAM_TIMEOUT_MS,
  HEADROOM_MAX_PAYLOAD_BYTES,
  HEADROOM_SSE_GUARD_ENABLED,
  HEADROOM_STATELESS_SSE_MAX_BYTES,
} from "../config/runtimeConfig.js";
import { validateBodyInvariants } from "./headroomInvariants.js";
import { createDeadlineError, createClientAbortError } from "../utils/preResponseBudget.js";
import { beginHeadroomAttempt, markHeadroomAttemptStarted, finishHeadroomAttempt, recordHeadroomBypass } from "./headroomRuntime.js";
import { normalizeAnthropicBeta } from "../utils/anthropicBeta.js";

function jsonByteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}
export function buildCompressEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}


export function isInternalHost(hostname) {
  const h = String(hostname || "").replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (h === "headroom" || h === "9router-headroom" || h === "host.docker.internal") return true;

  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipMatch) {
    const octet1 = parseInt(ipMatch[1], 10);
    const octet2 = parseInt(ipMatch[2], 10);
    const octet3 = parseInt(ipMatch[3], 10);
    const octet4 = parseInt(ipMatch[4], 10);
    if (octet1 > 255 || octet2 > 255 || octet3 > 255 || octet4 > 255) return false;
    if (octet1 === 127) return true;
    if (octet1 === 10) return true;
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
    if (octet1 === 192 && octet2 === 168) return true;
    return false;
  }
  return false;
}

export function isSafeOrigin(endpointUrl) {
  try {
    const parsed = new URL(endpointUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN === "1") return true;
    return isInternalHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function computeHeadroomBudget(configuredTimeoutMs, preResponse) {
  const { timeoutMs: configured } = resolveHeadroomTimeout(configuredTimeoutMs);

  if (!preResponse || typeof preResponse.remainingMs !== "function") {
    return configured;
  }

  const remaining = preResponse.remainingMs();
  const available = Math.max(0, remaining - HEADROOM_RESERVE_TIMEOUT_MS);
  return Math.min(configured, available);
}

function betaFromHeaders(headers) {
  if (headers instanceof Headers) return headers.get("anthropic-beta");
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === "anthropic-beta").map(([, value]) => value);
  return values.length && values.every((value) => typeof value === "string") ? values.join(",") : null;
}
/**
 * Call Headroom Gateway v2 POST /v1/compress.
 * Fail-open on Headroom service faults.
 * Abort/Deadline errors propagate to prevent wasteful upstream dispatch.
 */
export async function callHeadroomGateway({
  url,
  proxyToken = "",
  model,
  format,
  body,
  compressUserMessages = false,
  sessionId = null,
  isSSE = false,
  timeoutMs = HEADROOM_DEFAULT_TIMEOUT_MS,
  preResponse = null,
  clientSignal = null,
  diagnostics = {},
  requestHeaders = null,
  isBackgroundPrewarm = false,
} = {}) {
  const startTime = performance.now();
  if (!url) {
    diagnostics.reason = "missing_proxy_url";
    return null;
  }
  if (!body) {
    diagnostics.reason = "missing_body";
    return null;
  }

  const endpoint = buildCompressEndpoint(url);

  if (!isSafeOrigin(endpoint)) {
    diagnostics.reason = "unsafe_proxy_origin";
    return null;
  }

  // 1. Calculate budget: min(configured, max(0, remaining - reserve))
  if (typeof body !== "object" || Array.isArray(body)) {
    diagnostics.reason = "invalid_body_root";
    return null;
  }
  const budgetMs = isBackgroundPrewarm ? timeoutMs : computeHeadroomBudget(timeoutMs, preResponse);
  if (budgetMs <= 0) {
    diagnostics.reason = "budget_exhausted";
    return null;
  }

  // Pre-dispatch contract admission: if upstream timeout is declared and running in foreground,
  // ensure available budget accommodates upstream execution plus transport margin.
  if (!isBackgroundPrewarm && HEADROOM_UPSTREAM_TIMEOUT_MS > 0 && budgetMs < HEADROOM_UPSTREAM_TIMEOUT_MS + HEADROOM_UPSTREAM_MARGIN_MS) {
    diagnostics.reason = "insufficient_upstream_budget";
    return null;
  }

  // Pre-dispatch bounds and fast local bypasses before acquiring inflight slot
  const estimatedSize = jsonByteSize(body);
  if (estimatedSize === 0) {
    diagnostics.reason = "invalid_body_root";
    return null;
  }
  if (estimatedSize > HEADROOM_MAX_PAYLOAD_BYTES) {
    diagnostics.reason = "payload_too_large";
    recordHeadroomBypass(endpoint, diagnostics.reason);
    return null;
  }
  if (!isBackgroundPrewarm && HEADROOM_SSE_GUARD_ENABLED && isSSE && !sessionId && estimatedSize >= HEADROOM_STATELESS_SSE_MAX_BYTES) {
    diagnostics.reason = "stateless_sse_payload_too_large";
    recordHeadroomBypass(endpoint, diagnostics.reason);
    return null;
  }

  if (preResponse?.signal?.aborted) throw preResponse.signal.reason?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" ? preResponse.signal.reason : createDeadlineError();
  if (clientSignal?.aborted) throw clientSignal.reason?.code === "CLIENT_ABORT" ? clientSignal.reason : createClientAbortError();
  const hasSession = Boolean(sessionId && typeof sessionId === "string" && !compressUserMessages);
  const admission = beginHeadroomAttempt(endpoint, {
    isSSE: isBackgroundPrewarm ? false : isSSE,
    hasSession,
    isBackground: isBackgroundPrewarm,
    format,
  });
  if (!admission.ticket) {
    diagnostics.reason = admission.reason;
    recordHeadroomBypass(endpoint, admission.reason);
    return null;
  }
  const ticket = admission.ticket;
  try {

  // 3. Assemble Gateway v2 request payload (stateless, marker-free, client controls locked)
  // Strip any client-supplied headroom control fields from upstream envelope
  const {
    config: _clientConfig,
    gateway: _clientGateway,
    session_id: _clientSessionId,
    token_budget: _clientTokenBudget,
    ...cleanBody
  } = (body && typeof body === "object") ? body : {};

  const expectedBody = Object.fromEntries(Object.entries(cleanBody).filter(([, value]) => value !== undefined));
  if (model !== undefined) expectedBody.model = model;
  const config = {};
  if (compressUserMessages) config.compress_user_messages = true;
  if (sessionId && typeof sessionId === "string" && !compressUserMessages) {
    config.session_id = sessionId;
  }
  const payload = {
    ...expectedBody,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    gateway: {
      can_redrive: false,
      can_relay_response: !isBackgroundPrewarm,
      session_affinity: Boolean(config.session_id),
    },
  };
  const requestBeta = normalizeAnthropicBeta(betaFromHeaders(requestHeaders));
  if (requestBeta) payload.gateway.request_headers = { "anthropic-beta": requestBeta };

  const headers = {
    "Content-Type": "application/json",
  };
  const parsedEndpoint = (() => { try { return new URL(endpoint); } catch { return null; } })();
  if (proxyToken && isSafeOrigin(endpoint) && !parsedEndpoint?.username && !parsedEndpoint?.password) {
    headers["X-Headroom-Proxy-Token"] = proxyToken;
  }

  // A single deadline covers serialization, response headers and body parsing.
  const timeoutError = new Error("Headroom gateway timeout");
  timeoutError.code = "HEADROOM_GATEWAY_TIMEOUT";
  const localCtrl = new AbortController();
  const signals = [localCtrl.signal];
  if (clientSignal) signals.push(clientSignal);
  if (preResponse?.signal) signals.push(preResponse.signal);
  const combinedSignal = AbortSignal.any(signals);
  const remaining = budgetMs - (performance.now() - startTime);
  if (remaining <= 0) {
    diagnostics.reason = "gateway_timeout";
    diagnostics.budgetMs = budgetMs;
    diagnostics.latencyMs = performance.now() - startTime;
    return null;
  }
    diagnostics.queue = {
      inFlight: ticket.current.inFlight,
      circuitState: ticket.current.state,
      failures: ticket.current.failures,
    };
    const timer = setTimeout(() => localCtrl.abort(timeoutError), remaining);
  diagnostics.budgetMs = budgetMs;
  let data;
  try {
    if (combinedSignal.aborted) throw combinedSignal.reason;
    markHeadroomAttemptStarted(ticket);
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: combinedSignal,
      redirect: "manual",
    });
    if (combinedSignal.aborted) throw combinedSignal.reason;
    if (!res.ok) {
      diagnostics.httpStatus = res.status;
      let errData = null;
      try {
        const text = await res.text();
        errData = JSON.parse(text);
      } catch {
        // ignore parse error
      }
      const errType = errData?.error?.type;
      if (typeof errType === "string" && errType) {
        diagnostics.error_type = errType;
      }
      if (errType === "compression_timeout" || errType === "session_busy") {
        diagnostics.reason = errType;
      } else {
        diagnostics.reason = res.status >= 500 && res.status <= 599 ? "gateway_http_5xx" : `gateway_http_${res.status}`;
      }
      return null;
    }
    try {
      data = await res.json();
    } catch (error) {
      if (combinedSignal.aborted) throw error;
      if (error instanceof SyntaxError) {
        diagnostics.reason = "gateway_invalid_json_response";
        return null;
      }
      throw error;
    }
    if (combinedSignal.aborted || performance.now() - startTime >= budgetMs) {
      if (!combinedSignal.aborted) localCtrl.abort(timeoutError);
      throw combinedSignal.reason;
    }
  } catch (error) {
    if (combinedSignal.aborted && combinedSignal.reason !== timeoutError) {
      if (preResponse?.signal?.reason === combinedSignal.reason) {
        diagnostics.cancelled = true;
        throw combinedSignal.reason?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" ? combinedSignal.reason : createDeadlineError();
      }
      if (clientSignal?.reason === combinedSignal.reason) {
        diagnostics.cancelled = true;
        throw combinedSignal.reason?.code === "CLIENT_ABORT" ? combinedSignal.reason : createClientAbortError();
      }
    }
    if (combinedSignal.reason === timeoutError || error === timeoutError) {
      diagnostics.reason = "gateway_timeout";
    } else {
      const code = error?.code || error?.cause?.code;
      diagnostics.reason = code === "ENOTFOUND" || code === "EAI_AGAIN" ? "gateway_dns_error"
        : code === "ECONNREFUSED" ? "gateway_connection_refused"
          : ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) ? "gateway_connection_reset" : "gateway_fetch_error";
    }
    return null;
  } finally {
    clearTimeout(timer);
    diagnostics.latencyMs = performance.now() - startTime;
  }
  // Gateway v2 must return the complete provider envelope.
  const gatewayData = data?.data || {};
  const returnedBody = data?.body ?? gatewayData.body ?? null;
  const transformsApplied = data?.transforms_applied || gatewayData.transforms_applied || [];
  diagnostics.transforms_applied = transformsApplied;
  if (data?.compression_skipped === true || gatewayData.compression_skipped === true) {
    const rawSkipReason = data?.skip_reason ?? gatewayData.skip_reason ?? null;
    diagnostics.skip_reason = typeof rawSkipReason === "string" ? rawSkipReason : null;
    const check = validateBodyInvariants(expectedBody, returnedBody, format, { transforms: transformsApplied });
    diagnostics.reason = check.valid ? "gateway_compression_skipped" : "invariant_violation";
    if (!check.valid) diagnostics.detail = check.detail || check.reason;
    return null;
  }
  if (!returnedBody) {
    diagnostics.reason = "gateway_missing_compressed_body";
    return null;
  }
  if ((data.route?.model !== undefined && data.route.model !== expectedBody.model)
    || (gatewayData.route?.model !== undefined && gatewayData.route.model !== expectedBody.model)) {
    diagnostics.reason = "model_sovereignty_violation";
    return null;
  }
  // Only relay_usage is implemented; redrive or session state must never be requested.
  const rawObligations = data.obligations || gatewayData.obligations || [];
  const obligationsList = Array.isArray(rawObligations)
    ? rawObligations
    : (rawObligations && typeof rawObligations === "object" ? Object.keys(rawObligations).filter((key) => rawObligations[key]) : []);
  const unsupportedObligation = obligationsList.find((obligation) => obligation !== "relay_usage");
  if (unsupportedObligation) {
    diagnostics.reason = "unsupported_obligation";
    return null;
  }

  // 8. Validate body invariants (IDs, reasoning summaries/encrypted, tool pairing, JSON arguments)
  const invariantCheck = validateBodyInvariants(expectedBody, returnedBody, format, { transforms: transformsApplied });
  if (!invariantCheck.valid) {
    diagnostics.reason = "invariant_violation";
    diagnostics.detail = invariantCheck.detail || invariantCheck.reason;
    return null;
  }
  const responseHeaders = data.headers ?? gatewayData.headers ?? null;
  if (responseHeaders !== null && (typeof responseHeaders !== "object" || Array.isArray(responseHeaders))) {
    diagnostics.reason = "gateway_invalid_provider_headers";
    return null;
  }
  const rawBeta = betaFromHeaders(responseHeaders);
  if (responseHeaders && Object.keys(responseHeaders).some((key) => key.toLowerCase() === "anthropic-beta") && !normalizeAnthropicBeta(rawBeta)) {
    diagnostics.reason = "gateway_invalid_provider_headers";
    return null;
  }
  const providerHeaders = rawBeta ? { "anthropic-beta": normalizeAnthropicBeta(rawBeta) } : null;
  diagnostics.latencyMs = performance.now() - startTime;
  if (diagnostics.latencyMs >= budgetMs) {
    diagnostics.reason = "gateway_timeout";
    return null;
  }
  diagnostics.accepted = true;

  // Extract session diagnostics returned by Headroom v0.38
  const sessionInfo = data.session || gatewayData.session || null;
  if (sessionInfo && typeof sessionInfo === "object") {
    diagnostics.session = {
      id: typeof sessionInfo.id === "string" ? sessionInfo.id : null,
      frozen_message_count: Number.isInteger(sessionInfo.frozen_message_count) && sessionInfo.frozen_message_count >= 0
        ? sessionInfo.frozen_message_count
        : null,
      cached_prefix_replayed: Boolean(sessionInfo.cached_prefix_replayed),
    };
  }

  return {
    compressedBody: returnedBody,
    turnId: data.turn_id || gatewayData.turn_id || null,
    route: data.route || gatewayData.route || null,
    obligations: data.obligations || gatewayData.obligations || [],
    providerHeaders,
    tokens_before: data.tokens_before ?? gatewayData.tokens_before ?? null,
    tokens_after: data.tokens_after ?? gatewayData.tokens_after ?? null,
    tokens_saved: data.tokens_saved ?? gatewayData.tokens_saved ?? null,
    compression_ratio: data.compression_ratio ?? gatewayData.compression_ratio ?? null,
    transforms_applied: data.transforms_applied || gatewayData.transforms_applied || [],
    session: diagnostics.session || null,
    latencyMs: diagnostics.latencyMs,
  };
  } finally {
    const reason = diagnostics.reason;
    const isServiceFailure = (
      ["gateway_timeout", "compression_timeout", "gateway_dns_error", "gateway_connection_refused", "gateway_connection_reset",
        "gateway_fetch_error", "gateway_http_5xx", "gateway_http_429", "gateway_invalid_json_response",
        "gateway_missing_compressed_body"].includes(reason)
      || (reason === "gateway_compression_skipped" && diagnostics.skip_reason === "compression_timeout")
    );
    const kind = diagnostics.accepted ? "success" : diagnostics.cancelled ? "cancelled"
      : !ticket.attempted ? "local_bypass"
        : isServiceFailure ? "service_failure" : "neutral";
    diagnostics.transition = finishHeadroomAttempt(ticket, { kind, reason, latencyMs: ticket.attempted ? diagnostics.latencyMs : undefined });
    if (ticket.latencyTrigger) {
      diagnostics.latencyTrigger = ticket.latencyTrigger;
    }
  }
}
