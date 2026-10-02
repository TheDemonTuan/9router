import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordTokenSaverPreparation, getTokenSaverSnapshot } from "../../open-sse/token-saver/state.js";

describe("token saver numeric state", () => {
  it("keeps bounded percentiles and detached numeric snapshots", () => {
    const before = getTokenSaverSnapshot();
    for (let i = 1; i <= 100; i++) recordTokenSaverPreparation({ mode: "shadow", elapsedMs: i });
    const snapshot = getTokenSaverSnapshot();
    expect(snapshot.usage.latency.shadow.p50Ms).toBe(50);
    expect(snapshot.usage.latency.shadow.p95Ms).toBe(95);
    expect(snapshot.usage.preparations - before.usage.preparations).toBe(100);
    snapshot.usage.byMode.shadow = -5;
    snapshot.usage.latency.shadow.p50Ms = -5;
    expect(getTokenSaverSnapshot().usage.byMode.shadow).toBeGreaterThanOrEqual(100);
    expect(getTokenSaverSnapshot().usage.latency.shadow.p50Ms).toBe(50);
  });
  it("bounds rolling samples and verifies privacy with sentinel input", () => {
    const secret = "SUPER-SECRET-PAYLOAD-SENTINEL-12345";
    for (let i = 1; i <= 1100; i++) {
      recordTokenSaverPreparation({
        mode: "on",
        elapsedMs: i,
        stats: {
          scannedBytes: Number.MAX_SAFE_INTEGER,
          hashedResults: 5,
          intraTurnEligibleResults: 3,
          intraTurnDuplicatesFound: 2,
          skipped: { unlinked_call: 1, [secret]: 1 }, // unknown skip name should not leak
          payload: secret,
        },
        sourceDiagnostics: {
          userTurns: 1,
          responsesImplicitUserMessages: 2,
          currentCompletedToolBatches: 3,
          currentIncompleteToolBatches: 1,
          ambiguousTurns: 0,
          secretPayload: secret,
        },
        opaqueReasons: ["thought_signature", "cached_content", secret],
      });
    }
    const { usage } = getTokenSaverSnapshot();
    expect(usage.scannedBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(usage.hashedResults).toBeGreaterThanOrEqual(5500);
    expect(usage.intraTurnEligibleResults).toBeGreaterThanOrEqual(3300);
    expect(usage.intraTurnDuplicatesFound).toBeGreaterThanOrEqual(2200);
    expect(usage.preparationsByUserTurns.single).toBeGreaterThanOrEqual(1100);
    expect(usage.responsesImplicitUserMessages).toBeGreaterThanOrEqual(2200);
    expect(usage.toolBatches.currentCompleted).toBeGreaterThanOrEqual(3300);
    expect(usage.toolBatches.currentIncomplete).toBeGreaterThanOrEqual(1100);
    expect(usage.opaqueReasons.thought_signature).toBeGreaterThanOrEqual(1100);
    expect(usage.opaqueReasons.cached_content).toBeGreaterThanOrEqual(1100);
    expect(usage.latency.on.sampleCount).toBe(1024);
    expect(usage.latency.on.capacity).toBe(1024);
    expect(usage.latency.on.totalSamples).toBe(1100);
    expect(usage.latency.on.p50Ms).toBe(588);
    expect(usage.latency.on.p95Ms).toBe(1049);
    expect(usage.latency.on.softTargetExceeded).toBe(1098);

    // Verify privacy: sentinel input never appears anywhere in the telemetry snapshot
    expect(JSON.stringify(usage)).not.toContain(secret);
  });
  it("detaches all nested telemetry objects from internal state", () => {
    const snap1 = getTokenSaverSnapshot();
    snap1.usage.preparationsByUserTurns.single = -999;
    snap1.usage.toolBatches.currentCompleted = -999;
    snap1.usage.opaqueReasons.thought_signature = -999;
    const snap2 = getTokenSaverSnapshot();
    expect(snap2.usage.preparationsByUserTurns.single).not.toBe(-999);
    expect(snap2.usage.toolBatches.currentCompleted).not.toBe(-999);
    expect(snap2.usage.opaqueReasons.thought_signature).not.toBe(-999);
  });
  it("separates result skips from once-per-preparation reasons", () => {
    const before = getTokenSaverSnapshot().usage;
    recordTokenSaverPreparation({ mode: "on", stats: { skipped: { unlinked_call: 2, scan_budget: 5 } }, reason: "scan_budget", commit: { skipReason: "scan_budget" } });
    const after = getTokenSaverSnapshot().usage;
    expect(after.skippedResults.unlinked_call - before.skippedResults.unlinked_call).toBe(2);
    expect(after.skippedPreparations.unlinked_call - before.skippedPreparations.unlinked_call).toBe(0);
    expect(after.skippedPreparations.scan_budget - before.skippedPreparations.scan_budget).toBe(1);
    recordTokenSaverPreparation({ mode: "on", reason: "ambiguous_turn" });
    expect(getTokenSaverSnapshot().usage.skippedPreparations.ambiguous_turn - before.skippedPreparations.ambiguous_turn).toBe(1);
  });
  it("does not invent a cumulative denominator for a legacy populated ring", () => {
    const ring = globalThis[Symbol.for("9router.token-saver.runtime.v2")].usage.latency.on;
    const total = ring.totalSamples;
    delete ring.totalSamples;
    try {
      expect(getTokenSaverSnapshot().usage.latency.on.totalSamples).toBeNull();
      recordTokenSaverPreparation({ mode: "on", elapsedMs: 1 });
      expect(getTokenSaverSnapshot().usage.latency.on.totalSamples).toBeNull();
    } finally { ring.totalSamples = total; }
  });
});

describe("token saver final diagnostics", () => {
  const key = Symbol.for("9router.token-saver.runtime.v2");
  const opaqueNames = [
    "previous_response_id", "conversation", "cached_content", "encrypted_reasoning",
    "thought_signature", "claude_thinking_signature", "compaction",
  ];
  const correspondenceNames = [
    "unsupported_final", "call_count", "result_count", "call_identity",
    "result_linkage", "anchor_mapping", "leaf_proof", "body_proof", "non_writable",
  ];
  let previousRuntime;
  beforeEach(() => {
    previousRuntime = globalThis[key];
    delete globalThis[key];
  });
  afterEach(() => {
    if (previousRuntime === undefined) delete globalThis[key];
    else globalThis[key] = previousRuntime;
  });

  it("counts unique final opaque categories separately from source presence", () => {
    recordTokenSaverPreparation({
      mode: "on",
      opaqueReasons: ["encrypted_reasoning", "encrypted_reasoning"],
      finalOpaqueReasons: [...opaqueNames, ...opaqueNames],
      commit: { skipReason: "final_opaque_state" },
    });
    const { usage } = getTokenSaverSnapshot();
    expect(usage.finalOpaqueReasons).toEqual(Object.fromEntries(opaqueNames.map(name => [name, 1])));
    expect(usage.opaqueReasons.encrypted_reasoning).toBe(1);
    expect(usage.opaqueReasons.thought_signature).toBe(0);
    expect(usage.finalGuardSkippedPreparations).toBe(1);
    expect(usage.skippedPreparations.final_opaque_state).toBe(1);
    expect(usage.skippedResults.final_opaque_state).toBe(0);
  });

  it("attributes only the actual final guard, not supplied presence or preparation reasons", () => {
    const finalOpaqueReasons = ["thought_signature"];
    recordTokenSaverPreparation({ mode: "on", reason: "final_opaque_state", finalOpaqueReasons });
    recordTokenSaverPreparation({ mode: "on", finalOpaqueReasons, commit: { skipReason: "final_cache_fence", skipDetail: "leaf_proof" } });
    recordTokenSaverPreparation({
      mode: "on", finalOpaqueReasons, opaqueReasons: ["encrypted_reasoning"],
      commit: { skipReason: "final_correspondence", skipDetail: "call_identity" },
    });
    recordTokenSaverPreparation({ mode: "on", commit: { skipReason: "final_opaque_state", skipDetail: "leaf_proof" } });
    const { usage } = getTokenSaverSnapshot();
    expect(usage.finalOpaqueReasons).toEqual(Object.fromEntries(opaqueNames.map(name => [name, 0])));
    expect(usage.finalCorrespondenceReasons.call_identity).toBe(1);
    expect(usage.finalCorrespondenceReasons.leaf_proof).toBe(0);
    expect(usage.opaqueReasons.encrypted_reasoning).toBe(1);
    expect(usage.finalGuardSkippedPreparations).toBe(3);
    expect(usage.skippedPreparations.final_opaque_state).toBe(2);
  });

  it("records one allowed correspondence detail per rejected preparation", () => {
    for (const skipDetail of correspondenceNames) {
      recordTokenSaverPreparation({ mode: "on", commit: { skipReason: "final_correspondence", skipDetail } });
    }
    const { usage } = getTokenSaverSnapshot();
    expect(usage.finalCorrespondenceReasons).toEqual(Object.fromEntries(correspondenceNames.map(name => [name, 1])));
    expect(usage.finalGuardSkippedPreparations).toBe(correspondenceNames.length);
    expect(usage.skippedPreparations.final_correspondence).toBe(correspondenceNames.length);
  });

  it("ignores unknown or non-string enum values without retaining payloads", () => {
    const sentinel = "PRIVATE-DIAGNOSTIC-PAYLOAD-12345";
    const invalid = [sentinel, "__proto__", "constructor", null, 1, ["leaf_proof"], { toString: () => "leaf_proof" }];
    recordTokenSaverPreparation({
      mode: "on", opaqueReasons: [...invalid, { toString: () => "thought_signature" }],
      finalOpaqueReasons: [...invalid, { toString: () => "thought_signature" }],
      stats: { protected: { opaque: 2, [sentinel]: 7 } },
      commit: { skipReason: "final_opaque_state", payload: sentinel },
    });
    for (const skipDetail of invalid) {
      recordTokenSaverPreparation({ mode: "on", commit: { skipReason: "final_correspondence", skipDetail } });
    }
    const snapshot = getTokenSaverSnapshot();
    expect(snapshot.usage.finalOpaqueReasons).toEqual(Object.fromEntries(opaqueNames.map(name => [name, 0])));
    expect(snapshot.usage.opaqueReasons).toEqual(Object.fromEntries(opaqueNames.map(name => [name, 0])));
    expect(snapshot.usage.finalCorrespondenceReasons).toEqual(Object.fromEntries(correspondenceNames.map(name => [name, 0])));
    expect(snapshot.usage.protected.opaque).toBe(2);
    expect(Object.hasOwn(snapshot.usage.protected, sentinel)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
  });

  it("detaches final diagnostic and opaque protection buckets", () => {
    recordTokenSaverPreparation({ mode: "on", stats: { protected: { opaque: 3 } }, finalOpaqueReasons: ["encrypted_reasoning"], commit: { skipReason: "final_opaque_state" } });
    recordTokenSaverPreparation({ mode: "on", commit: { skipReason: "final_correspondence", skipDetail: "non_writable" } });
    const before = getTokenSaverSnapshot();
    const detached = getTokenSaverSnapshot();
    detached.usage.finalOpaqueReasons.encrypted_reasoning = -999;
    detached.usage.finalCorrespondenceReasons.non_writable = -999;
    detached.usage.protected.opaque = -999;
    expect(getTokenSaverSnapshot()).toEqual(before);
  });

  it("initializes missing hot-state fields without resetting existing counters or latency", () => {
    recordTokenSaverPreparation({ mode: "on", elapsedMs: 5, opaqueReasons: ["encrypted_reasoning"], stats: { plannedResults: 4, plannedSaveBytes: 800, protected: { cacheFence: 2 } } });
    const before = getTokenSaverSnapshot();
    const runtime = globalThis[key];
    const ring = runtime.usage.latency.on;
    delete runtime.usage.finalOpaqueReasons;
    delete runtime.usage.finalCorrespondenceReasons;
    delete runtime.usage.protected.opaque;
    expect(getTokenSaverSnapshot()).toEqual(before);
    expect(globalThis[key]).toBe(runtime);
    expect(runtime.usage.latency.on).toBe(ring);
    recordTokenSaverPreparation({ mode: "on", stats: { protected: { opaque: 3 } }, finalOpaqueReasons: ["thought_signature"], commit: { skipReason: "final_opaque_state" } });
    const after = getTokenSaverSnapshot();
    expect(after.session).toEqual(before.session);
    expect(after.usage.preparations).toBe(before.usage.preparations + 1);
    expect(after.usage.plannedResults).toBe(4);
    expect(after.usage.plannedSaveBytes).toBe(800);
    expect(after.usage.protected.cacheFence).toBe(2);
    expect(after.usage.protected.opaque).toBe(3);
    expect(after.usage.opaqueReasons).toEqual(before.usage.opaqueReasons);
    expect(after.usage.finalOpaqueReasons.thought_signature).toBe(1);
    expect(after.usage.latency).toEqual(before.usage.latency);
  });

  it("fills partial hot diagnostic buckets while preserving their populated counters", () => {
    getTokenSaverSnapshot();
    const usage = globalThis[key].usage;
    usage.finalOpaqueReasons = { encrypted_reasoning: 9 };
    usage.finalCorrespondenceReasons = { leaf_proof: 7 };
    usage.protected.opaque = 4;
    const snapshot = getTokenSaverSnapshot();
    expect(snapshot.usage.finalOpaqueReasons).toEqual(Object.fromEntries(opaqueNames.map(name => [name, name === "encrypted_reasoning" ? 9 : 0])));
    expect(snapshot.usage.finalCorrespondenceReasons).toEqual(Object.fromEntries(correspondenceNames.map(name => [name, name === "leaf_proof" ? 7 : 0])));
    expect(snapshot.usage.protected.opaque).toBe(4);
  });

  it("saturates counters and rejects invalid increments while keeping integer totals", () => {
    getTokenSaverSnapshot();
    const usage = globalThis[key].usage;
    usage.finalOpaqueReasons.encrypted_reasoning = Number.MAX_SAFE_INTEGER - 1;
    usage.finalCorrespondenceReasons.leaf_proof = Number.MAX_SAFE_INTEGER - 1;
    usage.protected.opaque = Number.MAX_SAFE_INTEGER - 1;
    for (let i = 0; i < 3; i++) {
      recordTokenSaverPreparation({ mode: "on", stats: { protected: { opaque: Number.MAX_VALUE } }, finalOpaqueReasons: ["encrypted_reasoning"], commit: { skipReason: "final_opaque_state" } });
      recordTokenSaverPreparation({ mode: "on", commit: { skipReason: "final_correspondence", skipDetail: "leaf_proof" } });
    }
    for (const amount of [-1, NaN, Infinity, -Infinity, "2", null]) {
      recordTokenSaverPreparation({ mode: "on", stats: { eligibleResults: amount, protected: { recent: amount } } });
    }
    recordTokenSaverPreparation({ mode: "on", stats: { eligibleResults: 2.9, protected: { recent: 2.9 } } });
    const snapshot = getTokenSaverSnapshot().usage;
    expect(snapshot.finalOpaqueReasons.encrypted_reasoning).toBe(Number.MAX_SAFE_INTEGER);
    expect(snapshot.finalCorrespondenceReasons.leaf_proof).toBe(Number.MAX_SAFE_INTEGER);
    expect(snapshot.protected.opaque).toBe(Number.MAX_SAFE_INTEGER);
    expect(snapshot.eligibleResults).toBe(2);
    expect(snapshot.protected.recent).toBe(2);
  });
});
