// Gateway v2 contract: Headroom 0.38.0 @ 94206e265203acfd72a3b939e9a964e29175ad50.
import { validateBodyInvariants } from "./headroomInvariants.js";
import { createDeadlineError, createClientAbortError } from "../utils/preResponseBudget.js";
import { normalizeAnthropicBeta } from "../utils/anthropicBeta.js";

const CONTROL_FIELDS = new Set(["config", "gateway", "token_budget", "session_id", "_headroom_responses_view"]);

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
    if (octet1 === 127 || octet1 === 10) return true;
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
    return octet1 === 192 && octet2 === 168;
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

export function stripHeadroomControls(body) {
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => !CONTROL_FIELDS.has(key) && value !== undefined));
}

function betaFromHeaders(headers) {
  if (headers instanceof Headers) return headers.get("anthropic-beta");
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === "anthropic-beta").map(([, value]) => value);
  return values.length && values.every((value) => typeof value === "string") ? values.join(",") : null;
}

function sessionFailure(reason, status = 503) {
  const error = new Error("Headroom session compression unavailable");
  error.code = "HEADROOM_SESSION_FAILURE";
  error.reason = reason;
  error.status = status;
  error.retryable = status === 503;
  return error;
}

export async function callHeadroomGateway({
  url, proxyToken = "", model, body, compressUserMessages = false,
  sessionId = null, preResponse = null, clientSignal = null,
  diagnostics = {}, requestHeaders = null,
} = {}) {
  const startTime = performance.now();
  const session = Boolean(sessionId && typeof sessionId === "string" && !compressUserMessages);
  const fail = (reason, status = 503) => {
    diagnostics.reason = reason;
    if (session) throw sessionFailure(reason, status);
    return null;
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_body_root", 502);
  const cleanBody = stripHeadroomControls(body);
  // Even a bypass must not forward client-provided compression controls.
  for (const key of CONTROL_FIELDS) delete body[key];
  if (!url) return fail("missing_proxy_url", 502);
  const endpoint = buildCompressEndpoint(url);
  if (!isSafeOrigin(endpoint)) return fail("unsafe_proxy_origin", 502);
  if (preResponse?.signal?.aborted) throw preResponse.signal.reason?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" ? preResponse.signal.reason : createDeadlineError();
  if (clientSignal?.aborted) throw clientSignal.reason?.code === "CLIENT_ABORT" ? clientSignal.reason : createClientAbortError();

  if (model !== undefined) cleanBody.model = model;
  const config = {};
  if (compressUserMessages) config.compress_user_messages = true;
  if (session) config.session_id = sessionId;
  const payload = {
    ...cleanBody,
    ...(Object.keys(config).length ? { config } : {}),
    gateway: { can_redrive: false, can_relay_response: true, session_affinity: session },
  };
  const requestBeta = normalizeAnthropicBeta(betaFromHeaders(requestHeaders));
  if (requestBeta) payload.gateway.request_headers = { "anthropic-beta": requestBeta };
  const parsedEndpoint = new URL(endpoint);
  const headers = { "Content-Type": "application/json" };
  if (proxyToken && !parsedEndpoint.username && !parsedEndpoint.password) headers["X-Headroom-Proxy-Token"] = proxyToken;
  const signals = [clientSignal, preResponse?.signal].filter(Boolean);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;

  let data;
  try {
    const res = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "manual",
    });
    if (signal?.aborted) throw signal.reason;
    if (!res.ok) {
      diagnostics.httpStatus = res.status;
      let errorType;
      try {
        const errorBody = await res.json();
        errorType = errorBody?.error?.type;
      } catch { /* An HTTP error can have a non-JSON body. */ }
      if (signal?.aborted) throw signal.reason;
      const reason = ["compression_timeout", "session_busy", "compression_error"].includes(errorType)
        ? errorType : `gateway_http_${res.status}`;
      return fail(reason, res.status === 503 ? 503 : 502);
    }
    data = await res.json();
    if (signal?.aborted) throw signal.reason;
  } catch (error) {
    if (preResponse?.signal?.aborted) throw preResponse.signal.reason?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" ? preResponse.signal.reason : createDeadlineError();
    if (clientSignal?.aborted) throw clientSignal.reason?.code === "CLIENT_ABORT" ? clientSignal.reason : createClientAbortError();
    if (error?.code === "HEADROOM_SESSION_FAILURE") throw error;
    const code = error?.code || error?.cause?.code;
    const reason = error instanceof SyntaxError ? "gateway_invalid_json_response"
      : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "gateway_dns_error"
        : code === "ECONNREFUSED" ? "gateway_connection_refused"
          : ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) ? "gateway_connection_reset" : "gateway_fetch_error";
    return fail(reason, reason === "gateway_invalid_json_response" ? 502 : 503);
  } finally {
    diagnostics.latencyMs = performance.now() - startTime;
  }

  if (!data || typeof data !== "object" || Array.isArray(data) || (data.data != null && (typeof data.data !== "object" || Array.isArray(data.data)))) {
    return fail("gateway_invalid_response", 502);
  }
  const gatewayData = data.data || {};
  const returnedBody = data.body ?? gatewayData.body;
  const route = data?.route ?? gatewayData.route ?? null;
  const obligations = data?.obligations ?? gatewayData.obligations ?? [];
  const turnId = data?.turn_id ?? gatewayData.turn_id ?? null;
  const responseHeaders = data?.headers ?? gatewayData.headers ?? null;
  const check = validateBodyInvariants(cleanBody, returnedBody, { route, obligations, turnId, headers: responseHeaders });
  if (!check.valid) return fail(check.reason, 502);
  const rawBeta = betaFromHeaders(responseHeaders);
  if (responseHeaders && Object.keys(responseHeaders).some((key) => key.toLowerCase() === "anthropic-beta") && !normalizeAnthropicBeta(rawBeta)) {
    return fail("gateway_invalid_provider_headers", 502);
  }
  const skipped = data?.compression_skipped === true || gatewayData.compression_skipped === true;
  if (skipped && session) return fail("session_compression_skipped", 502);
  diagnostics.reason = skipped ? "gateway_compression_skipped" : null;
  diagnostics.skip_reason = skipped ? data?.skip_reason ?? gatewayData.skip_reason ?? null : null;
  diagnostics.accepted = true;
  return {
    compressedBody: returnedBody, turnId, route, obligations,
    providerHeaders: rawBeta ? { "anthropic-beta": normalizeAnthropicBeta(rawBeta) } : null,
    tokens_before: data?.tokens_before ?? gatewayData.tokens_before ?? null,
    tokens_after: data?.tokens_after ?? gatewayData.tokens_after ?? null,
    tokens_saved: data?.tokens_saved ?? gatewayData.tokens_saved ?? null,
    compression_ratio: data?.compression_ratio ?? gatewayData.compression_ratio ?? null,
    transforms_applied: data?.transforms_applied ?? gatewayData.transforms_applied ?? [],
    compressionSkipped: skipped,
    latencyMs: performance.now() - startTime,
  };
}
