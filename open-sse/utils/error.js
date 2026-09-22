import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

const QUOTA_CODES = new Set([
  "usage_limit_reached", "insufficient_quota", "quota_exhausted", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
]);

export function classifyUpstreamError(statusCode, message, error = {}) {
  const code = String(error?.code || error?.type || "").toLowerCase();
  const text = `${code} ${String(message || "")}`.toLowerCase();
  if (QUOTA_CODES.has(code) ||
    (statusCode === 402 && /additional usage limit for your plan/.test(text)) ||
    /(?:free )?usage (?:limit |is )?exhausted|quota (?:is )?exhausted|quota remaining\s*[=:]\s*0/.test(text)) {
    return { errorClass: "quota_exhausted", retryable: false };
  }
  if (statusCode === 401 || statusCode === 403) return { errorClass: "auth_failed", retryable: false };
  if (statusCode === 429 || /rate limit|too many requests|concurrency limit|requests per (?:minute|second)|capacity|overloaded/.test(text)) {
    return { errorClass: "rate_limited", retryable: true };
  }
  if (statusCode >= 500) return { errorClass: "transient_provider_failure", retryable: true };
  return { errorClass: "request_error", retryable: false };
}

/**
 * Parse upstream provider error response.
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON provider error */ }
  const providerError = body?.error && typeof body.error === "object" ? body.error : body || {};
  let parsed = null;
  if (executor && typeof executor.parseError === "function") {
    try { parsed = executor.parseError(response, bodyText); } catch { /* default parser below */ }
  }
  const statusCode = parsed?.status || response.status;
  const message = parsed?.message || providerError.message || body?.message || (typeof body?.error === "string" ? body.error : "") || bodyText || DEFAULT_ERROR_MESSAGES[statusCode] || `Upstream error: ${statusCode}`;
  const classification = classifyUpstreamError(statusCode, message, {
    type: parsed?.type || providerError.type,
    code: parsed?.code || providerError.code,
  });
  return {
    statusCode,
    message: typeof message === "string" ? message : JSON.stringify(message),
    resetsAtMs: parsed?.resetsAtMs,
    ...(parsed?.resolvedModel ? { resolvedModel: parsed.resolvedModel } : {}),
    ...classification,
    ...(typeof parsed?.retryable === "boolean" ? { retryable: parsed.retryable } : {}),
  };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, classification = {}) {
  const headers = {
    ...(typeof classification.retryable === "boolean" ? { "x-should-retry": String(classification.retryable) } : {}),
    ...(resetsAtMs ? { "x-9router-retry-at": new Date(resetsAtMs).toISOString() } : {}),
    ...(classification.resolvedModel ? { "x-9router-resolved-model": classification.resolvedModel } : {}),
  };
  const response = errorResponse(statusCode, message);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    errorClass: classification.errorClass,
    retryable: classification.retryable,
    ...(classification.resolvedModel ? { resolvedModel: classification.resolvedModel } : {}),
    response,
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAtMs = Date.parse(retryAfter);
  const retryAfterSec = Number.isFinite(retryAtMs)
    ? Math.max(Math.ceil((retryAtMs - Date.now()) / 1000), 1)
    : null;
  const msg = retryAfterHuman ? `${message} (${retryAfterHuman})` : message;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {})
      }
    }
  );
}

/**
 * Create a terminal response for confirmed provider quota exhaustion.
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when quota becomes available
 * @param {string} retryAfterHuman - Human-readable retry info
 * @returns {Response}
 */
export function quotaExhaustedResponse(message, retryAfter, retryAfterHuman) {
  const retryAtMs = Date.parse(retryAfter);
  const hasRetryAt = Number.isFinite(retryAtMs);
  const resetsAt = hasRetryAt ? Math.floor(retryAtMs / 1000) : null;
  const msg = retryAfterHuman ? `${message} (${retryAfterHuman})` : message;

  return new Response(
    JSON.stringify({
      error: {
        message: msg,
        type: "usage_limit_reached",
        code: "insufficient_quota",
        param: null,
        ...(resetsAt !== null ? { resets_at: resetsAt } : {}),
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "x-should-retry": "false",
        "x-9router-error-code": "provider_quota_exhausted",
        ...(hasRetryAt ? { "x-9router-retry-at": retryAfter } : {}),
      },
    }
  );
}

/**
 * Map classified credential exhaustion to its client-facing response.
 */
export function credentialUnavailableResponse(statusCode, message, credentials) {
  if (credentials?.unavailabilityReason === "quota_exhausted") {
    return quotaExhaustedResponse(message, credentials.retryAfter, credentials.retryAfterHuman);
  }
  if (credentials?.unavailabilityReason === "auth_failed") {
    const authStatus = statusCode === 401 || statusCode === 403
      ? statusCode
      : (Number(credentials.lastErrorCode) === 403 ? 403 : 401);
    return errorResponse(authStatus, message);
  }
  return unavailableResponse(statusCode, message, credentials?.retryAfter, credentials?.retryAfterHuman);
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
