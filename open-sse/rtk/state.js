import { RTK_REJECTIONS } from "../config/rtkConfig.js";
import { randomUUID } from "node:crypto";

const KEY = Symbol.for("9router.rtk.runtime.v1");
const reasons = ["disabled", "opted_out", "structured_output", "native_passthrough", "unsupported_shape", "no_eligible_output", "no_change", "compressed", "timeout", "cancelled", "failed"];
const outcomes = ["attempts", "succeeded", "unchanged", "failed", "busy", "rejected", "timedOut", "cancelled", "totalDurationMs"];
const skips = ["unconfigured", "invalid_url", "invalid_text", "size_limit", "circuit_open", "probe_in_flight", "saturated", "payload_limit"];
const zero = keys => Object.fromEntries(keys.map(key => [key, 0]));

export function getRtkState() {
  return globalThis[KEY] ??= {
    session: { id: randomUUID(), startedAt: new Date().toISOString(), slot: ["blue", "green"].includes(process.env.DEPLOY_SLOT) ? process.env.DEPLOY_SLOT : null },
    usage: {
      preparations: 0, compressedPreparations: 0, appliedOutputs: 0,
      bytesBefore: 0, bytesAfter: 0, estimatedTokensSaved: 0, lastAppliedAt: null,
      preparationReasons: zero(reasons), http: zero(outcomes), skipped: zero(skips), filters: {},
      eligibility: { toolResults: 0, textLeaves: 0, resultsWithoutText: 0, noToolResultsPreparations: 0, rejected: zero(RTK_REJECTIONS) },
    },
    client: { initialized: false, endpoint: null, endpointState: "unconfigured", dispatcher: null, active: 0, openUntil: 0, generation: 0, probe: false, warningAt: 0, lastSuccessAt: null, lastFailure: null, check: null, checkPromise: null },
  };
}

export function getRtkSnapshot() {
  const { session, usage } = getRtkState();
  return {
    session: { ...session },
    usage: {
      ...usage, preparationReasons: { ...usage.preparationReasons }, http: { ...usage.http },
      skipped: { ...usage.skipped }, filters: Object.values(usage.filters).map(row => ({ ...row })),
      eligibility: { ...usage.eligibility, rejected: { ...usage.eligibility.rejected } },
    },
  };
}
