import { randomUUID } from "node:crypto";
import { TOKEN_SAVER_CONFIG as LIMIT, SESSION_DEDUP_MODES } from "../config/tokenSaverConfig.js";

const skipNames = ["opted_out", "structured_output", "native_passthrough", "opaque_state", "unsupported_shape",
  "unknown_turn", "ambiguous_turn", "unlinked_call", "ambiguous_call", "structured_result", "below_min_bytes",
  "above_max_bytes", "metadata_budget", "scan_budget", "entry_budget", "hash_collision",
  "final_correspondence", "final_budget", "failed", "cancelled"];
const numeric = keys => Object.fromEntries(keys.map(key => [key, 0]));
const usageKeys = ["preparations", "scannedResults", "eligibleResults", "exactDuplicatesFound", "wouldDedupResults",
  "wouldSaveBytes", "appliedResults", "bytesSaved", "scannedBytes", "estimatedTokensSaved", "crossFamilyDuplicates",
  "budgetStoppedPreparations", "finalGuardSkippedPreparations"];
const cleanupKeys = ["scannedBytes", "budgetStoppedPreparations", "completePreparations", "partialPreparations",
  "visitedSegments", "measuredSegments", "protectedSegments", "trailingWhitespaceBytes", "blankLineBytes",
  "ansiBytes", "adjacentDuplicateBytes", "duplicateSystemBytes", "oldToolTruncationBytes"];
const KEY = Symbol.for("9router.token-saver.runtime.v1");
function createState() {
  return { session: { id: randomUUID(), startedAt: new Date().toISOString(), slot: process.env.DEPLOY_SLOT || null },
    usage: { ...numeric(usageKeys), byMode: numeric(SESSION_DEDUP_MODES),
      protected: numeric(["current", "recent", "error", "cacheFence"]), skipped: numeric(skipNames),
      latency: Object.fromEntries(["shadow", "on"].map(mode => [mode, {
        samples: new Float64Array(LIMIT.latencySamples), count: 0, cursor: 0, softTargetExceeded: 0,
      }])), cleanupShadow: numeric(cleanupKeys) } };
}
const state = () => globalThis[KEY] ??= createState();
const add = (bucket, key, amount) => {
  if (Object.hasOwn(bucket, key) && Number.isFinite(amount) && amount >= 0) {
    bucket[key] = Math.min(Number.MAX_SAFE_INTEGER, bucket[key] + amount);
  }
};
export function recordTokenSaverPreparation({ mode, stats, cleanup, commit, reason, elapsedMs } = {}) {
  const usage = state().usage;
  add(usage, "preparations", 1);
  add(usage.byMode, mode, 1);
  for (const key of usageKeys) if (key !== "preparations") add(usage, key, stats?.[key] || 0);
  for (const [key, count] of Object.entries(stats?.protected ?? {})) add(usage.protected, key, count);
  for (const [key, count] of Object.entries(stats?.skipped ?? {})) add(usage.skipped, key, count);
  if (reason) add(usage.skipped, reason, 1);
  add(usage, "appliedResults", commit?.appliedResults || 0);
  add(usage, "bytesSaved", commit?.bytesSaved || 0);
  add(usage, "estimatedTokensSaved", commit?.estimatedTokensSaved || 0);
  if (commit?.skipReason) {
    add(usage.skipped, commit.skipReason, 1);
    add(usage, "finalGuardSkippedPreparations", 1);
  }
  if (cleanup) {
    for (const key of cleanupKeys) add(usage.cleanupShadow, key, cleanup[key] || 0);
    add(usage.cleanupShadow, cleanup.complete ? "completePreparations" : "partialPreparations", 1);
    if (cleanup.budgetStopped) add(usage.cleanupShadow, "budgetStoppedPreparations", 1);
  }
  const latency = usage.latency[mode];
  if (latency && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    latency.samples[latency.cursor] = elapsedMs;
    latency.cursor = (latency.cursor + 1) % LIMIT.latencySamples;
    latency.count = Math.min(LIMIT.latencySamples, latency.count + 1);
    if (elapsedMs > LIMIT.softTargetMs) add(latency, "softTargetExceeded", 1);
  }
}
export function getTokenSaverSnapshot() {
  const runtime = state();
  const usage = runtime.usage;
  const latency = Object.fromEntries(["shadow", "on"].map(mode => {
    const ring = usage.latency[mode];
    const sorted = Array.from(ring.samples.slice(0, ring.count)).sort((a, b) => a - b);
    return [mode, { sampleCount: ring.count, capacity: LIMIT.latencySamples,
      p50Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
      p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      softTargetExceeded: ring.softTargetExceeded }];
  }));
  return { session: { ...runtime.session }, usage: { ...usage, byMode: { ...usage.byMode },
    protected: { ...usage.protected }, skipped: { ...usage.skipped }, cleanupShadow: { ...usage.cleanupShadow }, latency } };
}
