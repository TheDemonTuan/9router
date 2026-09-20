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

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message)
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
  const retryAfterSec = hasRetryAt
    ? Math.max(Math.ceil((retryAtMs - Date.now()) / 1000), 1)
    : null;
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
        ...(retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {}),
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
