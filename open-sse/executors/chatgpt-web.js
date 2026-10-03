import { createHash } from "node:crypto";
import { getChatGptWebCatalog, requestChatGptWebRuntime, hasChatGptWebModel } from "../services/chatgptWebRuntimeClient.js";

const QUOTA_CODES = ["quota_exhausted", "usage_limit_reached", "insufficient_quota"];
function runtimeError(status, code, message, submissionState = "not_sent") {
  return Response.json({ error: { type: "runtime_error", code, message, retryable: false, submission_state: submissionState } },
    { status, headers: { "x-9router-no-fallback": "true", "x-should-retry": "false", "x-9router-error-code": code } });
}
export function isChatGptWebRetryable(status, error) {
  return error?.submission_state === "not_sent" && error.retryable === true && Number.isFinite(Number(error.retry_after)) && Number(error.retry_after) > 0
    && (status === 429 && error.code === "rate_limited" || status === 503 && error.code === "temporarily_unavailable");
}
export class ChatGPTWebExecutor {
  constructor() { this.provider = "chatgpt-web"; this.noAuth = true; }
  getProvider() { return this.provider; }
  needsRefresh() { return false; }
  async refreshCredentials() { return null; }
  parseError(response, bodyText) {
    let body; try { body = JSON.parse(bodyText); } catch { body = {}; }
    const error = body?.error && typeof body.error === "object" ? body.error : {};
    const reset = typeof error.resets_at === "number" ? (error.resets_at < 1e12 ? error.resets_at * 1000 : error.resets_at) : Date.parse(error.resets_at);
    const resetEvidence = QUOTA_CODES.includes(error.code) || error.code === "rate_limited";
    return { status: response.status, message: typeof error.message === "string" ? error.message : "ChatGPT Web runtime request failed",
      code: typeof error.code === "string" ? error.code : "submission_unknown", type: "runtime_error",
      errorClass: QUOTA_CODES.includes(error.code) ? "quota_exhausted" : error.code === "rate_limited" ? "rate_limited" : "runtime_error",
      retryable: isChatGptWebRetryable(response.status, error), submissionState: error.submission_state || "unknown",
      ...(resetEvidence && Number.isFinite(reset) && reset > Date.now() ? { resetsAtMs: reset } : {}),
      ...(error.code === "rate_limited" && Number(error.retry_after) > 0 ? { resetsAtMs: Date.now() + Number(error.retry_after) * 1000 } : {}) };
  }
  async execute({ model, body, credentials, signal }) {
    const authority = credentials?.chatGptWebAuthority;
    const operation = body?._compact === true ? "compact" : "responses";
    const outbound = { ...body, model, stream: operation !== "compact" }; delete outbound._compact;
    const result = response => ({ response, url: `cgw-runtime:/v1/${operation === "compact" ? "responses/compact" : "responses"}`,
      headers: {}, transformedBody: outbound });
    if (!authority) return result(runtimeError(400, "codex_authority_required", "Use the authenticated local Codex companion"));
    if (authority.purpose !== operation) return result(runtimeError(400, "authority_purpose_mismatch", "Signed operation differs from runtime operation"));
    let catalog;
    try { catalog = await getChatGptWebCatalog(credentials, { signal }); }
    catch { return result(runtimeError(503, "runtime_unavailable", "Verified runtime profile catalog unavailable")); }
    const row = catalog.models.find(row => row.id === model);
    const effort = body.reasoning?.effort ?? row?.default_reasoning_level;
    if (catalog.stale || !hasChatGptWebModel(catalog, model) || row?.capabilities?.native_responses !== true
      || !row.supported_reasoning_levels.includes(effort)) return result(runtimeError(400, "model_version_unavailable", "Exact selected profile model/reasoning is not verified"));
    if (credentials.chatGptWebProfileEpoch && credentials.chatGptWebProfileEpoch !== catalog.profileEpoch) return result(runtimeError(409, "profile_epoch_mismatch", "Bound account epoch changed"));
    let compactMetadata = body?.client_metadata?.["x-codex-turn-metadata"];
    if (typeof compactMetadata === "string") { try { compactMetadata = JSON.parse(compactMetadata); } catch { compactMetadata = null; } }
    const compactTurn = operation === "compact" || compactMetadata?.request_kind === "compaction"
      || (Array.isArray(body.input) && body.input.some(item => item?.type === "compaction_trigger"));
    if (!compactTurn && Array.isArray(body.tools) && body.tools.length && row.capabilities.tools !== true) return result(runtimeError(400, "harness_unavailable", "Selected profile Full harness capability is not verified"));
    const envelope = { protocolVersion: 1, profileId: catalog.profileId, profileEpoch: credentials.chatGptWebProfileEpoch || catalog.profileEpoch,
      request: outbound, authority, originalModel: credentials.chatGptWebOriginalModel || `cgw/${model}`, effectiveModel: model, effectiveReasoning: effort,
      transformedRequestSha256: createHash("sha256").update(JSON.stringify(outbound)).digest("hex") };
    let response;
    try { response = await requestChatGptWebRuntime(credentials, operation === "compact" ? "/v1/responses/compact" : "/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal,
    }); }
    catch { return result(runtimeError(signal?.aborted ? 499 : 502, signal?.aborted ? "client_cancelled" : "submission_unknown", "Runtime transport did not settle; request was not retried", "unknown")); }
    const headers = new Headers(response.headers); headers.set("x-9router-no-fallback", "true");
    if (!response.ok) {
      const text = await response.text(); const parsed = this.parseError(response, text);
      headers.set("x-should-retry", String(parsed.retryable)); headers.set("x-9router-error-code", parsed.code);
      response = new Response(text, { status: response.status, headers });
    } else response = new Response(response.body, { status: response.status, headers });
    return result(response);
  }
}
