import { FORMATS } from "../translator/formats.js";

const present = value => value != null;
function collectOpaqueReasons(value, set) {
  if (!value || typeof value !== "object") return;
  if (present(value.previous_response_id)) set.add("previous_response_id");
  if (present(value.conversation)) set.add("conversation");
  if (present(value.cachedContent) || present(value.cached_content)) set.add("cached_content");
  if (present(value.encrypted_content) || present(value.reasoning_encrypted_content) || present(value.reasoning?.encrypted_content)) set.add("encrypted_reasoning");
  if (present(value.thoughtSignature) || present(value.thought_signature)) set.add("thought_signature");
  if (present(value.signature) && ["thinking", "redacted_thinking"].includes(value.type)) set.add("claude_thinking_signature");
  if (value.type === "compaction" || value.type === "compaction_trigger" || value._compact === true || present(value.context_management?.compaction)) set.add("compaction");
}
export function detectCacheFence(body, sourceIndex) {
  const opaqueSet = new Set();
  const fence = { hasFence: false, protectAll: false, lastProtectedPosition: -1,
    blockPromptInjection: false, reason: null, opaqueReasons: [] };
  if (!sourceIndex.supported) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = sourceIndex.blockedReason;
    return fence;
  }
  const messageEnds = new Map();
  for (const n of sourceIndex.protocolNodes) if (n.enclosingMessage) messageEnds.set(n.enclosingMessage, n.position);
  collectOpaqueReasons(body, opaqueSet);
  collectOpaqueReasons(body.request, opaqueSet);
  collectOpaqueReasons(body.generationConfig, opaqueSet);
  collectOpaqueReasons(body.request?.generationConfig, opaqueSet);
  let opaque = opaqueSet.size > 0;
  if (opaque || present(body.cache_control) || present(body.request?.cache_control) || present(body.prompt_cache_breakpoint)) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = opaque ? "opaque_state" : "cache_fence";
    fence.hasFence = !opaque;
  }
  for (const n of sourceIndex.protocolNodes) {
    const owner = n.owner;
    collectOpaqueReasons(owner, opaqueSet);
    collectOpaqueReasons(owner?.functionCall, opaqueSet);
    collectOpaqueReasons(owner?.reasoning, opaqueSet);
    collectOpaqueReasons(owner?.functionResponse, opaqueSet);
    collectOpaqueReasons(owner?.functionResponse?.response, opaqueSet);
    if (opaqueSet.size > 0) {
      opaque = true;
      fence.protectAll = fence.blockPromptInjection = true;
      fence.reason = "opaque_state";
    }
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
        fence.reason = "cache_fence";
      } else {
        const message = n.enclosingMessage;
        fence.lastProtectedPosition = Math.max(fence.lastProtectedPosition, message ? messageEnds.get(message) ?? n.position : n.position);
      }
    }
  }
  if (opaque) fence.reason = "opaque_state";
  fence.opaqueReasons = Array.from(opaqueSet);
  if (fence.protectAll) fence.lastProtectedPosition = Number.MAX_SAFE_INTEGER;
  for (const result of sourceIndex.results) {
    result.cacheProtected = result.position <= fence.lastProtectedPosition;
  }
  for (const segment of sourceIndex.textSegments) {
    if (segment.position <= fence.lastProtectedPosition) segment.protectedReason = "cache_fence";
  }
  if (fence.hasFence && !fence.reason) fence.reason = "cache_fence";
  return fence;
}
