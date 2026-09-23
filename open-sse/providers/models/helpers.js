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
