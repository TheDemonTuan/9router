import { callHeadroomGateway, stripHeadroomControls } from "./headroomGateway.js";

// Keep the caller's body reference: translators and executors share it.
export function applyValidatedGatewayBody(body, returned) {
  for (const key of Object.keys(body)) delete body[key];
  Object.assign(body, stripHeadroomControls(returned));
  return body;
}

export async function compressWithHeadroom(body, {
  enabled = true, url, proxyToken = "", model, format,
  compressUserMessages = false, sessionId = null,
  preResponse = null, clientSignal = null, diagnostics = null, requestHeaders = null,
} = {}) {
  if (!enabled) return null;
  const diag = diagnostics || {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    diag.reason = "invalid_body_root";
    if (sessionId && !compressUserMessages) {
      const error = new Error("Headroom session compression unavailable");
      error.code = "HEADROOM_SESSION_FAILURE";
      error.reason = diag.reason;
      error.status = 502;
      error.retryable = false;
      throw error;
    }
    return null;
  }
  // Client controls are not provider fields, even when Headroom is offline.
  for (const key of ["config", "gateway", "token_budget", "session_id", "_headroom_responses_view"]) delete body[key];
  try {
    const data = await callHeadroomGateway({
      url, proxyToken, model, format, body, compressUserMessages, sessionId,
      preResponse, clientSignal, diagnostics: diag, requestHeaders,
    });
    if (!data) return null;
    applyValidatedGatewayBody(body, data.compressedBody);
    return data;
  } catch (error) {
    if (["CLIENT_ABORT", "PRE_RESPONSE_DEADLINE_EXCEEDED", "HEADROOM_SESSION_FAILURE"].includes(error?.code)) throw error;
    diag.reason = "gateway_unexpected_error";
    if (sessionId && !compressUserMessages) {
      const failure = new Error("Headroom session compression unavailable");
      failure.code = "HEADROOM_SESSION_FAILURE";
      failure.reason = diag.reason;
      failure.status = 503;
      failure.retryable = true;
      throw failure;
    }
    return null;
  }
}

export function formatHeadroomLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const delta = stats.tokens_saved || 0;
  const pct = before > 0 ? ((delta / before) * 100).toFixed(1) : "0";
  return `reported token delta=${delta} before=${before}${after ? ` after=${after}` : ""} (${pct}%)`.trim();
}

export function formatHeadroomSummaryTag(stats, diagnostics) {
  const elapsed = Math.round(diagnostics?.latencyMs ?? stats?.latencyMs ?? 0);
  const elapsedStr = elapsed > 0 ? ` ${elapsed}ms` : "";
  if (stats?.compressionSkipped) return `HEADROOM:BYPASS:${diagnostics?.skip_reason || "compression_skipped"}${elapsedStr}`;
  if (stats) {
    const saved = stats.tokens_saved;
    const before = stats.tokens_before;
    if (Number.isFinite(saved) && saved > 0 && Number.isFinite(before) && before > 0) {
      return `HEADROOM:${saved}tok/${Math.round((saved / before) * 100)}%${elapsedStr}`;
    }
    return `HEADROOM:${Number.isFinite(saved) ? `${saved}tok` : "ok"}${elapsedStr}`;
  }
  return diagnostics?.reason ? `HEADROOM:BYPASS:${diagnostics.reason}${elapsedStr}` : null;
}
