import { FORMATS } from "../translator/formats.js";
import { signatureFamily } from "../services/thoughtSignatureStore.js";
import { RESPONSES_ITEM } from "../translator/schema/blocks.js";

const present = value => value != null;
const openai = [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX];
const gemini = [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX];
const claude = [FORMATS.CLAUDE, FORMATS.KIRO];
function collectOpaqueReasons(value, set) {
  if (!value || typeof value !== "object") return;
  if (present(value.previous_response_id)) set.add("previous_response_id");
  if (present(value.conversation)) set.add("conversation");
  if (present(value.cachedContent) || present(value.cached_content)) set.add("cached_content");
  if (present(value.encrypted_content) || present(value.reasoning_encrypted_content) || present(value.reasoning?.encrypted_content)) set.add("encrypted_reasoning");
  if (present(value.thoughtSignature) || present(value.thought_signature)) set.add("thought_signature");
  if ((present(value.signature) && ["thinking", "redacted_thinking"].includes(value.type)) ||
    value.type === "redacted_thinking" && present(value.data)) set.add("claude_thinking_signature");
  if (value.type === "compaction" || value.type === "compaction_trigger" || value._compact === true || present(value.context_management?.compaction)) set.add("compaction");
}
const validOpaqueString = value => value == null || typeof value === "string" && value.length > 0;
export function detectCacheFence(body, sourceIndex, { targetFormat = sourceIndex.format, targetModel = body?.model } = {}) {
  const opaqueSet = new Set();
  const fence = { hasFence: false, protectAll: false, protectCurrentTurn: false, lastProtectedPosition: -1,
    blockPromptInjection: false, reason: null, opaqueReasons: [] };
  if (!sourceIndex.supported) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = sourceIndex.blockedReason;
    return fence;
  }
  const family = signatureFamily(targetModel);
  const cannotScope = claude.includes(sourceIndex.format) || claude.includes(targetFormat) ||
    (sourceIndex.format === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.ANTIGRAVITY) && family !== "gemini";
  const signedMessages = new Set();
  const messageEnds = new Map();
  for (const n of sourceIndex.protocolNodes) if (n.enclosingMessage) messageEnds.set(n.enclosingMessage, n.position);
  let globalOpaque = false;
  let cacheAll = false;
  const reasons = new Set();
  function observe(value, local = false, message = null) {
    reasons.clear();
    collectOpaqueReasons(value, reasons);
    for (const reason of reasons) {
      opaqueSet.add(reason);
      const validLocal = reason === "encrypted_reasoning"
        ? validOpaqueString(value.encrypted_content) && validOpaqueString(value.reasoning_encrypted_content) && validOpaqueString(value.reasoning?.encrypted_content)
        : validOpaqueString(value.thoughtSignature) && validOpaqueString(value.thought_signature);
      if (!local || cannotScope || reason !== local || !validLocal) globalOpaque = true;
      else {
        fence.protectCurrentTurn = true;
        signedMessages.add(message);
      }
    }
  }
  observe(body);
  observe(body.request);
  observe(body.generationConfig);
  observe(body.request?.generationConfig);
  if (present(body.cache_control) || present(body.request?.cache_control) || present(body.prompt_cache_breakpoint)) {
    fence.protectAll = fence.blockPromptInjection = fence.hasFence = true;
    fence.reason = "cache_fence";
    cacheAll = true;
  }
  if (sourceIndex.calls.length > 0) {
    if (gemini.includes(targetFormat) || targetFormat === FORMATS.ANTIGRAVITY && family === "gemini") fence.protectCurrentTurn = true;
    else if (targetFormat === FORMATS.ANTIGRAVITY) {
      fence.protectAll = fence.blockPromptInjection = true;
      fence.reason = "opaque_state";
    }
  }
  // Gemini normalization merges adjacent result/user wrappers. Do not mutate
  // source results when translation would erase the genuine user boundary.
  let previousResult = false;
  const predictsGemini = sourceIndex.calls.length > 0 && (gemini.includes(targetFormat) || targetFormat === FORMATS.ANTIGRAVITY && family === "gemini");
  for (const n of sourceIndex.protocolNodes) {
    const owner = n.owner;
    const message = n.enclosingMessage;
    if (predictsGemini && openai.includes(sourceIndex.format) && message === n) {
      if (owner?.role === "user" && previousResult) globalOpaque = true;
      if (owner?.role === "tool" || [RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(owner?.type)) previousResult = true;
      else if (owner?.role === "user" || owner?.type === RESPONSES_ITEM.FUNCTION_CALL ||
        owner?.role === "assistant" && (typeof owner.content === "string" && owner.content.length > 0 ||
          typeof owner.reasoning_content === "string" && owner.reasoning_content.length > 0 ||
          Array.isArray(owner.tool_calls) && owner.tool_calls.some(call => call?.type === "function" && call.function))) previousResult = false;
    }
    const localOpenai = openai.includes(sourceIndex.format) && owner === message?.owner &&
      (message?.kind === "item" && owner?.type === RESPONSES_ITEM.REASONING || message?.kind === "message" && owner?.role === "assistant");
    const part = n.kind === "part" ? owner : n.parent?.kind === "part" ? n.parent.owner : null;
    const localGemini = (gemini.includes(sourceIndex.format) || sourceIndex.format === FORMATS.ANTIGRAVITY && family === "gemini") &&
      part && (owner === part || owner === part.functionCall) && message?.owner?.role === "model" &&
      (part.functionCall || typeof part.text === "string");
    observe(owner, localOpenai ? "encrypted_reasoning" : localGemini ? "thought_signature" : null, message);
    observe(owner?.functionCall, localGemini ? "thought_signature" : null, message);
    observe(owner?.reasoning, localOpenai ? "encrypted_reasoning" : null, message);
    observe(owner?.functionResponse);
    observe(owner?.functionResponse?.response);
    observe(owner?.function);
    observe(owner?.response);
    observe(owner?.output);
    if (!owner || typeof owner !== "object") continue;
    if (n.kind === "result_text" || n.kind === "text") continue;
    for (const [field, marker] of [["cache_control", owner.cache_control], ["prompt_cache_breakpoint", owner.prompt_cache_breakpoint]]) {
      if (!Object.hasOwn(owner, field)) continue;
      fence.hasFence = fence.blockPromptInjection = true;
      const valid = field === "cache_control"
        ? sourceIndex.format === FORMATS.CLAUDE && marker && typeof marker === "object" && marker.type === "ephemeral"
        : [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX].includes(sourceIndex.format) && marker && typeof marker === "object" && marker.mode === "explicit";
      if (!valid || n.kind === "tool_definition" && field === "prompt_cache_breakpoint") {
        fence.protectAll = true;
        cacheAll = true;
        fence.reason = "cache_fence";
      } else {
        const message = n.enclosingMessage;
        fence.lastProtectedPosition = Math.max(fence.lastProtectedPosition, message ? messageEnds.get(message) ?? n.position : n.position);
      }
    }
  }
  if (opaqueSet.size > 0) {
    fence.blockPromptInjection = true;
    fence.reason = "opaque_state";
  }
  if (fence.protectCurrentTurn && (sourceIndex.currentTurnIndex < 0 || sourceIndex.blockedReason || sourceIndex.diagnostics?.ambiguousTurns)) globalOpaque = true;
  if (globalOpaque) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = "opaque_state";
  }
  fence.opaqueReasons = Array.from(opaqueSet);
  if (cacheAll) fence.lastProtectedPosition = Number.MAX_SAFE_INTEGER;
  const resultMessages = new Map();
  for (const n of sourceIndex.protocolNodes) if (n.kind === "result") resultMessages.set(n.position, n.enclosingMessage);
  for (const result of sourceIndex.results) {
    result.cacheProtected = cacheAll || result.position <= fence.lastProtectedPosition;
    result.opaqueProtected = fence.reason === "opaque_state" && fence.protectAll ||
      fence.protectCurrentTurn && (result.isRecentTurn || signedMessages.has(resultMessages.get(result.position)));
  }
  for (const segment of sourceIndex.textSegments) {
    if (segment.resultIndex != null && sourceIndex.results[segment.resultIndex]?.opaqueProtected) segment.protectedReason = "opaque_state";
    else if (cacheAll || segment.position <= fence.lastProtectedPosition) segment.protectedReason = "cache_fence";
  }
  if (fence.hasFence && !fence.reason) fence.reason = "cache_fence";
  return fence;
}
