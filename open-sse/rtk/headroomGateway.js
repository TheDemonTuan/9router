// open-sse/rtk/headroomGateway.js
// Native Gateway v2 client for Headroom 0.38.0 (commit 94206e2).
// Stateless, marker-free, no model routing, no output shaper, no tool search.
// Provider request headers extracted from gateway response and forwarded to upstream executor.

import {
  HEADROOM_DEFAULT_TIMEOUT_MS,
  HEADROOM_RESERVE_TIMEOUT_MS,
  HEADROOM_MAX_PAYLOAD_BYTES,
} from "../config/runtimeConfig.js";
import { validateBodyInvariants } from "./headroomInvariants.js";
import { createDeadlineError, createClientAbortError } from "../utils/preResponseBudget.js";

function jsonByteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function buildCompressEndpoint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const clean = String(rawUrl).replace(/#.*$/, "");
    const [base, query = ""] = clean.split("?", 2);
    const endpoint = `${base.replace(/\/$/, "")}/v1/compress`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

function scrubSensitiveUrlText(text) {
  return String(text)
    .replace(/\/\/[^/@\s]+@/g, "//")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, "$1");
}

function maskEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(endpoint).replace(/\/\/[^/@\s]+@/, "//").replace(/[?#].*$/, "");
  }
}

export function isInternalHost(hostname) {
  const h = String(hostname || "").replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.startsWith("127.")) return true;
  if (h === "headroom" || h === "9router-headroom" || h === "host.docker.internal") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".test") || h.endsWith(".example") || h === "example.com") return true;

  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipMatch) {
    const octet1 = parseInt(ipMatch[1], 10);
    const octet2 = parseInt(ipMatch[2], 10);
    if (octet1 === 10) return true;
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
    if (octet1 === 192 && octet2 === 168) return true;
    return false;
  }
  return false;
}

function isSafeOrigin(endpointUrl) {
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
  const configured = typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : HEADROOM_DEFAULT_TIMEOUT_MS;

  if (!preResponse || typeof preResponse.remainingMs !== "function") {
    return configured;
  }

  const remaining = preResponse.remainingMs();
  const available = Math.max(0, remaining - HEADROOM_RESERVE_TIMEOUT_MS);
  return Math.min(configured, available);
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
  timeoutMs = HEADROOM_DEFAULT_TIMEOUT_MS,
  preResponse = null,
  clientSignal = null,
  diagnostics = {},
} = {}) {
  const startTime = Date.now();
  if (!url) {
    diagnostics.reason = "missing_proxy_url";
    return null;
  }
  if (!body) {
    diagnostics.reason = "missing_body";
    return null;
  }

  const endpoint = buildCompressEndpoint(url);
  diagnostics.endpoint = maskEndpoint(endpoint);

  if (!isSafeOrigin(endpoint)) {
    diagnostics.reason = "unsafe_proxy_origin";
    return null;
  }

  // 1. Calculate budget: min(configured, max(0, remaining - reserve))
  const budgetMs = computeHeadroomBudget(timeoutMs, preResponse);
  if (budgetMs <= 0) {
    diagnostics.reason = "budget_exhausted";
    return null;
  }

  // 2. Resource bounds: check payload size limit (max 20MB)
  const estimatedSize = jsonByteSize(body);
  if (estimatedSize > HEADROOM_MAX_PAYLOAD_BYTES) {
    diagnostics.reason = "payload_too_large";
    return null;
  }

  // 3. Assemble Gateway v2 request payload (stateless, marker-free)
  const payload = {
    ...body,
    model,
    config: {
      can_redrive: false,
      can_relay_response: false,
      session_affinity: false,
      ...(compressUserMessages ? { compress_user_messages: true } : {}),
    },
  };

  const headers = {
    "Content-Type": "application/json",
  };
  const parsedEndpoint = (() => { try { return new URL(endpoint); } catch { return null; } })();
  if (proxyToken && isSafeOrigin(endpoint) && !parsedEndpoint?.username && !parsedEndpoint?.password) {
    headers["X-Headroom-Proxy-Token"] = proxyToken;
  }

  // 4. Linked timeouts: client abort + preResponse deadline + local budget
  const localCtrl = new AbortController();
  const timer = setTimeout(() => {
    localCtrl.abort(new Error(`Headroom gateway timeout after ${budgetMs}ms`));
  }, budgetMs);

  const signals = [localCtrl.signal];
  if (clientSignal) signals.push(clientSignal);
  if (preResponse?.signal) signals.push(preResponse.signal);
  const combinedSignal = AbortSignal.any(signals);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: combinedSignal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timer);
    // If client aborted or preResponse deadline passed, propagate typed error with code & status
    if (preResponse?.signal?.aborted) {
      const deadlineError = preResponse.signal.reason && typeof preResponse.signal.reason === "object" && preResponse.signal.reason.code
        ? preResponse.signal.reason
        : createDeadlineError();
      throw deadlineError;
    }
    if (clientSignal?.aborted) {
      const abortError = clientSignal.reason && typeof clientSignal.reason === "object" && clientSignal.reason.code
        ? clientSignal.reason
        : createClientAbortError();
      throw abortError;
    }
    const cleanMsg = scrubSensitiveUrlText(error.message || String(error));
    diagnostics.reason = `gateway_fetch_error: ${cleanMsg}`;
    diagnostics.latencyMs = Date.now() - startTime;
    return null;
  }

  clearTimeout(timer);

  if (!res.ok) {
    diagnostics.reason = `gateway_http_${res.status}`;
    diagnostics.latencyMs = Date.now() - startTime;
    return null;
  }

  let data;
  try {
    data = await res.json();
  } catch (parseError) {
    diagnostics.reason = "gateway_invalid_json_response";
    diagnostics.latencyMs = Date.now() - startTime;
    return null;
  }

  diagnostics.latencyMs = Date.now() - startTime;

  // 5. Unpack Gateway v2 response
  // v0.38.0 native gateway returns { data: { body, turn_id, route, obligations, headers }, ... }
  // or legacy top-level { messages, ... }
  const gatewayData = data?.data || {};
  const returnedBody = gatewayData.body || data.body || (Array.isArray(data.messages) ? { messages: data.messages } : (Array.isArray(data.input) ? { input: data.input } : null));

  if (!returnedBody) {
    diagnostics.reason = "gateway_missing_compressed_body";
    return null;
  }

  // 6. Sovereignty check: model must not be changed by Headroom
  const returnedModel = returnedBody.model || data.model || model;
  if (returnedModel !== model && returnedModel !== body.model) {
    diagnostics.reason = `model_sovereignty_violation: returned ${returnedModel} expected ${model}`;
    return null;
  }

  // 7. Validate body invariants (IDs, reasoning summaries/encrypted, tool pairing, JSON arguments)
  const invariantCheck = validateBodyInvariants(body, returnedBody, format);
  if (!invariantCheck.valid) {
    diagnostics.reason = `invariant_violation: ${invariantCheck.reason}`;
    return null;
  }

  return {
    compressedBody: returnedBody,
    turnId: gatewayData.turn_id || data.turn_id || null,
    route: gatewayData.route || data.route || null,
    obligations: gatewayData.obligations || data.obligations || {},
    providerHeaders: gatewayData.headers || data.headers || null,
    tokens_before: data.tokens_before ?? null,
    tokens_after: data.tokens_after ?? null,
    tokens_saved: data.tokens_saved ?? null,
    compression_ratio: data.compression_ratio ?? null,
    transforms_applied: data.transforms_applied || [],
    latencyMs: diagnostics.latencyMs,
  };
}
