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
  it("bounds rolling samples without carrying payloads", () => {
    for (let i = 1; i <= 1100; i++) recordTokenSaverPreparation({ mode: "on", elapsedMs: i,
      stats: { scannedBytes: Number.MAX_SAFE_INTEGER, skipped: { unlinked_call: 1 } } });
    const { usage } = getTokenSaverSnapshot();
    expect(usage.scannedBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(usage.latency.on.sampleCount).toBe(1024);
    expect(usage.latency.on.capacity).toBe(1024);
    expect(JSON.stringify(usage)).not.toContain("synthetic-secret");
  });
});
