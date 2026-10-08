import { createHash } from "node:crypto";
import { getChatGptWebCatalog, requestChatGptWebRuntime, hasChatGptWebModel } from "../services/chatgptWebRuntimeClient.js";
import { validateBrowserResponsesRequest } from "../../services/chatgpt-web-runtime/browser-request.js";
import { validateAgentResponsesRequest } from "../../services/chatgpt-web-runtime/agent-request.js";

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
    const marker = credentials?.chatGptWebRequestMode;
    const browser = marker === "browser" && !authority;
    const agent = marker === "agent" && !authority;
    const generic = browser || agent;
    const operation = body?._compact === true ? "compact" : "responses";
    let outbound = { ...body, model, stream: operation !== "compact" }; delete outbound._compact;
    const path = agent ? "/v1/agent/responses" : browser ? "/v1/browser/responses" : operation === "compact" ? "/v1/responses/compact" : "/v1/responses";
    const result = response => ({ response, url: `cgw-runtime:${path}`, headers: {}, transformedBody: outbound });
    if (marker !== undefined && (!generic || operation !== "responses")) return result(runtimeError(400, "unsupported_browser_request", "Invalid internal ChatGPT Web request mode"));
    if (!generic && !authority) return result(runtimeError(400, "codex_authority_required", "Use the authenticated local Codex companion"));
    if (!generic && authority.purpose !== operation) return result(runtimeError(400, "authority_purpose_mismatch", "Signed operation differs from runtime operation"));
    // The shared thinking mapper emits Chat-style effort even on Responses wire.
    if (generic && outbound.reasoning_effort !== undefined) {
      outbound.reasoning = { ...outbound.reasoning, effort: outbound.reasoning_effort };
      delete outbound.reasoning_effort;
    }
    if (browser) {
      try { outbound = validateBrowserResponsesRequest(outbound); }
      catch (error) { return result(runtimeError(400, "unsupported_browser_request", error.message)); }
    } else if (agent) {
      try { outbound = validateAgentResponsesRequest(outbound); }
      catch (error) { return result(runtimeError(400, error.code || "unsupported_agent_request", error.message)); }
    }
    let catalog;
    try { catalog = await getChatGptWebCatalog(credentials, { signal, force: true }); }
    catch { return result(runtimeError(503, "runtime_unavailable", "Verified runtime profile catalog unavailable")); }
    const row = catalog.models.find(row => row.id === model);
    const effort = outbound.reasoning?.effort ?? row?.default_reasoning_level;
    if (agent && (row?.capabilities?.generic_tools !== true || row?.capabilities?.generic_responses !== true)) return result(runtimeError(503, "agent_tools_unavailable", "OpenAI-compatible agent tools capability is not verified for the selected model"));
    if (browser && row?.capabilities?.generic_responses !== true) return result(runtimeError(503, "generic_model_unavailable", "No verified generic text model is available. Verify the saved session and runtime prerequisites, or upgrade the runtime."));
    const requiredCapability = agent ? "generic_tools" : browser ? "generic_responses" : "native_responses";
    if (catalog.stale || !hasChatGptWebModel(catalog, model) || row?.capabilities?.[requiredCapability] !== true
      || generic && row.capabilities.text !== true || !row.supported_reasoning_levels.includes(effort)) return result(runtimeError(400, "model_version_unavailable", "Exact selected profile model/reasoning is not verified"));
    if (credentials.chatGptWebProfileEpoch && credentials.chatGptWebProfileEpoch !== catalog.profileEpoch) return result(runtimeError(409, "profile_epoch_mismatch", "Bound account epoch changed"));
    let compactMetadata = body?.client_metadata?.["x-codex-turn-metadata"];
    if (typeof compactMetadata === "string") { try { compactMetadata = JSON.parse(compactMetadata); } catch { compactMetadata = null; } }
    const compactTurn = operation === "compact" || compactMetadata?.request_kind === "compaction"
      || (Array.isArray(body.input) && body.input.some(item => item?.type === "compaction_trigger"));
    if (!generic && !compactTurn && Array.isArray(body.tools) && body.tools.length && row.capabilities.tools !== true) return result(runtimeError(400, "harness_unavailable", "Selected profile Full harness capability is not verified"));
    const envelope = { protocolVersion: 1, profileId: catalog.profileId, profileEpoch: credentials.chatGptWebProfileEpoch || catalog.profileEpoch,
      request: outbound, ...(!generic ? { authority, originalModel: credentials.chatGptWebOriginalModel || `cgw/${model}` } : {}), effectiveModel: model, effectiveReasoning: effort,
      transformedRequestSha256: createHash("sha256").update(JSON.stringify(outbound)).digest("hex") };
    let response;
    try { response = await requestChatGptWebRuntime(credentials, path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal,
    }); }
    catch { return result(runtimeError(signal?.aborted ? 499 : 502, signal?.aborted ? "client_cancelled" : "submission_unknown", "Runtime transport did not settle; request was not retried", "unknown")); }
    if (generic && response.status === 404) return result(runtimeError(503, "runtime_upgrade_required", agent ? "ChatGPT Web runtime requires an upgrade for OpenAI-compatible agent requests" : "ChatGPT Web runtime requires an upgrade for Browser-only text requests"));
    const headers = new Headers(response.headers); headers.set("x-9router-no-fallback", "true");
    if (!response.ok) {
      const text = await response.text(); const parsed = this.parseError(response, text);
      headers.set("x-should-retry", String(parsed.retryable)); headers.set("x-9router-error-code", parsed.code);
      response = new Response(text, { status: response.status, headers });
    } else response = new Response(response.body, { status: response.status, headers });
    return result(response);
  }
}
