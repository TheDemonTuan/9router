
/**
 * Merge candidate model lists while filtering out entries already present in models,
 * deduplicating by ID, preserving metadata and stable insertion order.
 *
 * @param {Array<Array<object>|object>} candidateLists - List of candidate arrays (or items)
 * @param {Array<object>} [models=[]] - Models already selected or present
 * @returns {Array<object>} Merged candidate models
 */
export function mergeCodexCandidateModels(candidateLists, models = []) {
  const modelIds = new Set((models || []).map((m) => m?.id).filter(Boolean));
  const order = [];
  const byId = new Map();

  const lists = Array.isArray(candidateLists) ? candidateLists : [];
  for (const item of lists) {
    if (!item) continue;
    const candidates = Array.isArray(item) ? item : [item];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      if (!id || modelIds.has(id)) continue;

      if (!byId.has(id)) {
        order.push(id);
        byId.set(id, { ...candidate });
      }
    }
  }

  return order.map((id) => byId.get(id));
}
