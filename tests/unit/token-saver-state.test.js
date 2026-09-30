import { describe, expect, it } from "vitest";
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
});
