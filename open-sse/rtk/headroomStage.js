// open-sse/rtk/headroomStage.js
// Pure stage selector for Headroom 0.38.0 Gateway integration.
// Selects the target or source native format. Max 1 call per attempt.

export const HEADROOM_STAGES = {
  TARGET_NATIVE: "target_native",
  SOURCE_NATIVE: "source_native",
  BYPASS: "bypass",
};

export const HEADROOM_NATIVE_FORMATS = new Set([
  "openai",
  "openai-responses",
  "claude",
]);

export function selectHeadroomStage({
  sourceFormat,
  targetFormat,
  provider,
  isCompact = false,
  isBridge = false,
} = {}) {
  // 1. Compact / bridge modes bypass until explicit protocol evidence exists
  if (isCompact || isBridge) {
    return { stage: HEADROOM_STAGES.BYPASS, reason: "compact_or_bridge_bypass" };
  }

  // 2. Cursor protobuf and binary/commandcode streams bypass
  if (provider === "cursor" || sourceFormat === "cursor" || targetFormat === "cursor" || targetFormat === "commandcode") {
    return { stage: HEADROOM_STAGES.BYPASS, reason: "special_binary_bypass" };
  }

  // 3. Effective target format is native to Headroom (OpenAI Chat, OpenAI Responses, Claude)
  // Run AFTER translateRequest
  if (HEADROOM_NATIVE_FORMATS.has(targetFormat)) {
    return { stage: HEADROOM_STAGES.TARGET_NATIVE, format: targetFormat };
  }

  // 4. Target is not native (e.g. Antigravity, Gemini, Vertex, Ollama), but source format is native
  // Run BEFORE translateRequest on the clean source body
  if (HEADROOM_NATIVE_FORMATS.has(sourceFormat)) {
    return { stage: HEADROOM_STAGES.SOURCE_NATIVE, format: sourceFormat };
  }

  // 5. Neither format is native to Headroom (e.g. Gemini -> Antigravity, Antigravity -> Antigravity)
  return { stage: HEADROOM_STAGES.BYPASS, reason: "unsupported_formats" };
}
