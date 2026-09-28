import { FORMATS } from "../../translator/formats.js";

// Legacy review aliases remain routable for saved configs, but are no longer advertised.
export const CODEX_REVIEW_SUFFIX = "-review";

function isLegacyCodexReviewVariant(modelId) {
  return typeof modelId === "string"
    && modelId.endsWith(CODEX_REVIEW_SUFFIX)
    && modelId !== "codex-auto-review";
}

export function withCodexReviewModels(models) {
  return (models || []).filter((model) => !isLegacyCodexReviewVariant(model?.id));
}

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}

// Endpoint families for OpenCode models outside the curated registry (modelsFetcher /
// passthrough ids) — regex keeps auto-fetched models on the right endpoint:
// /responses (gpt/grok/muse-spark), /messages (minimax/qwen), /chat/completions (rest).
// Curated registry entries always win; this is the unknown-id fallback only.
const OPENCODE_FAMILIES = [
  { match: /^(grok|gpt|muse[-_]?spark)/i, supportedFormats: [FORMATS.OPENAI_RESPONSES], targetFormat: FORMATS.OPENAI_RESPONSES },
  { match: /^deepseek-v4-(pro|flash)/, supportedFormats: [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES] },
  { match: /^(minimax|qwen)/, supportedFormats: [FORMATS.OPENAI, FORMATS.CLAUDE] },
  { match: /^claude-/i, supportedFormats: [FORMATS.CLAUDE] },
];

export function opencodeFamilyFormats(modelId) {
  if (!modelId || typeof modelId !== "string") return null;
  const base = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  return OPENCODE_FAMILIES.find((f) => f.match.test(base)) || null;
}
