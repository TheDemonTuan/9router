// Legacy review aliases remain routable for saved configs, but are no longer advertised.
export const CODEX_REVIEW_SUFFIX = "-review";
const LEGACY_CODEX_REVIEW_BASES = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
]);

function isLegacyCodexReviewVariant(modelId) {
  return typeof modelId === "string"
    && modelId.endsWith(CODEX_REVIEW_SUFFIX)
    && LEGACY_CODEX_REVIEW_BASES.has(modelId.slice(0, -CODEX_REVIEW_SUFFIX.length));
}

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if (isLegacyCodexReviewVariant(model?.id)) return [];
    if (
      (model.kind || model.type || "llm") !== "llm"
      || model.id.endsWith(CODEX_REVIEW_SUFFIX)
      || LEGACY_CODEX_REVIEW_BASES.has(model.id)
    ) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review"
      }
    ];
  });
}

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}
