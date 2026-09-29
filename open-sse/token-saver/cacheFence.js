import { FORMATS } from "../translator/formats.js";

const present = value => value != null;
const hasOpaque = value => value && typeof value === "object" && (
  present(value.cachedContent) || present(value.cached_content) || present(value.previous_response_id) ||
  present(value.conversation) || value._compact === true || present(value.encrypted_content) ||
  present(value.reasoning_encrypted_content) || present(value.reasoning?.encrypted_content) ||
  present(value.thoughtSignature) || present(value.thought_signature) ||
  present(value.signature) && ["thinking", "redacted_thinking"].includes(value.type) ||
  value.type === "compaction" || value.type === "compaction_trigger" ||
  present(value.context_management?.compaction)
);

export function detectCacheFence(body, sourceIndex) {
  const fence = { hasFence: false, protectAll: false, lastProtectedPosition: -1,
    blockPromptInjection: false, reason: null };
  if (!sourceIndex.supported) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = sourceIndex.blockedReason;
    return fence;
  }
  let opaque = false;
  const messageEnds = new Map();
  for (const n of sourceIndex.protocolNodes) if (n.enclosingMessage) messageEnds.set(n.enclosingMessage, n.position);
  opaque = Boolean(hasOpaque(body) || hasOpaque(body.request) || hasOpaque(body.generationConfig) || hasOpaque(body.request?.generationConfig));
  if (opaque || present(body.cache_control) || present(body.request?.cache_control) || present(body.prompt_cache_breakpoint)) {
    fence.protectAll = fence.blockPromptInjection = true;
    fence.reason = opaque ? "opaque_state" : "cache_fence";
    fence.hasFence = !opaque;
  }
  for (const n of sourceIndex.protocolNodes) {
    const owner = n.owner;
    if (hasOpaque(owner) || hasOpaque(owner?.functionCall) || hasOpaque(owner?.reasoning) ||
      hasOpaque(owner?.functionResponse) || hasOpaque(owner?.functionResponse?.response)) {
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
