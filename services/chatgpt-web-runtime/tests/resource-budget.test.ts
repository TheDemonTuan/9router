import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_RESOURCE_LIMITS, loadRuntimeResourceLimits, type RuntimeResourceLimits } from "../src/config";
import { ResourceCapacityError, RuntimeResourceBudget, type ResourceLease } from "../src/resource-budget";

// No browser, filesystem, server, network, or real-time sleeps: queued deadlines
// and fairness are driven by an injected clock and explicit notify().
function fixture(overrides: Partial<RuntimeResourceLimits> = {}) {
  let now = 0;
  const budget = new RuntimeResourceBudget({ ...DEFAULT_RUNTIME_RESOURCE_LIMITS, ...overrides }, { now: () => now });
  return { budget, advance: (ms: number) => { now += ms; budget.notify(); } };
}
const beforeSend = { status: 503, code: "runtime_capacity_exceeded", retryable: false, submission_state: "not_sent" };

describe("strict resource configuration", () => {
  test("defaults are conservative and generic-stateful policy is absent", () => {
    expect(loadRuntimeResourceLimits({})).toEqual(DEFAULT_RUNTIME_RESOURCE_LIMITS);
    expect(loadRuntimeResourceLimits({ CGW_GENERIC_SESSION_IDLE_TTL_MS: "invalid-removed-policy" })).toEqual(DEFAULT_RUNTIME_RESOURCE_LIMITS);
  });

  test("each numeric policy accepts both bounds and rejects malformed values", () => {
    const policies: [string, keyof RuntimeResourceLimits, number, number][] = [
      ["CGW_MAX_GLOBAL_BROWSERS", "maxGlobalBrowsers", 1, 32],
      ["CGW_MAX_GLOBAL_TURNS", "maxGlobalTurns", 1, 64],
      ["CGW_MAX_GLOBAL_TABS", "maxGlobalTabs", 5, 160],
      ["CGW_MAX_RETAINED_TABS_PER_PROFILE", "maxRetainedTabsPerProfile", 1, 5],
      ["CGW_MAX_QUEUE_SIZE", "maxQueueSize", 0, 128],
      ["CGW_QUEUE_TIMEOUT_MS", "queueTimeoutMs", 1000, 120000],
      ["CGW_BROWSER_IDLE_TTL_MS", "browserIdleTtlMs", 1000, 3600000],
    ];
    for (const [env, field, min, max] of policies) {
      expect(loadRuntimeResourceLimits({ [env]: String(min) })[field]).toBe(min);
      expect(loadRuntimeResourceLimits({ [env]: String(max) })[field]).toBe(max);
      for (const raw of ["", " ", " 2", "2 ", "2.0", "1e1", "0x10", "+2", "02", "NaN", "Infinity", "9007199254740992", String(min - 1), String(max + 1)]) {
        expect(() => loadRuntimeResourceLimits({ [env]: raw })).toThrow(env);
      }
    }
  });

  test("browser mode and adaptive flag are exact opt-ins", () => {
    expect(loadRuntimeResourceLimits({ CGW_BROWSER_MODE: "headless-text", CGW_ADAPTIVE_DOM_POLLING: "true" })).toMatchObject({ browserMode: "headless-text", adaptiveDomPolling: true });
    for (const value of ["", "headless", "Headed", " headed"]) expect(() => loadRuntimeResourceLimits({ CGW_BROWSER_MODE: value })).toThrow("CGW_BROWSER_MODE");
    for (const value of ["", "TRUE", "1", "yes", "false "]) expect(() => loadRuntimeResourceLimits({ CGW_ADAPTIVE_DOM_POLLING: value })).toThrow("CGW_ADAPTIVE_DOM_POLLING");
  });
});

describe("executing turn admission", () => {
  test("global and per-profile permits are independent and FIFO at equal priority", async () => {
    const { budget } = fixture({ maxGlobalTurns: 6 });
    const held: ResourceLease[] = [];
    for (let i = 0; i < 5; i++) held.push(await budget.acquire({ profileId: "one", kind: "new" }));
    const sixth = budget.acquire({ profileId: "one", kind: "new" });
    const seventh = budget.acquire({ profileId: "one", kind: "new" });
    const other = await budget.acquire({ profileId: "two", kind: "new" });
    expect(budget.snapshot()).toMatchObject({ executingTurns: 6, queueDepth: 2 });
    held[0]!.release(); held[0]!.release();
    const next = await sixth;
    expect(budget.snapshot()).toMatchObject({ executingTurns: 6, queueDepth: 1 });
    next.release();
    const last = await seventh;
    last.release(); other.release(); held.forEach(lease => lease.release());
    expect(budget.snapshot()).toMatchObject({ executingTurns: 0, queueDepth: 0, totals: { admitted: 8 } });
  });

  test("queue capacity rejects overflow and abort removes a waiter immediately", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1, maxQueueSize: 1 });
    const held = await budget.acquire({ profileId: "one", kind: "new" });
    const abort = new AbortController();
    const waiter = budget.acquire({ profileId: "two", kind: "new", signal: abort.signal });
    await expect(budget.acquire({ profileId: "three", kind: "new" })).rejects.toMatchObject(beforeSend);
    abort.abort();
    expect(budget.snapshot().queueDepth).toBe(0);
    await expect(waiter).rejects.toMatchObject(beforeSend);
    held.release();
    const next = await budget.acquire({ profileId: "three", kind: "new" });
    expect(budget.snapshot().executingTurns).toBe(1);
    next.release();
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(budget.acquire({ profileId: "one", kind: "new", signal: alreadyAborted.signal })).rejects.toMatchObject(beforeSend);
    expect(budget.snapshot().executingTurns).toBe(0);
  });

  test("zero queue capacity still admits free permits", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1, maxQueueSize: 0 });
    const active = await budget.acquire({ profileId: "one", kind: "new" });
    await expect(budget.acquire({ profileId: "two", kind: "continuation" })).rejects.toMatchObject(beforeSend);
    active.release();
    const next = await budget.acquire({ profileId: "two", kind: "new" }); next.release();
  });

  test("expired waiters never consume permits after release", async () => {
    const { budget, advance } = fixture({ maxGlobalTurns: 1, queueTimeoutMs: 1000 });
    const held = await budget.acquire({ profileId: "one", kind: "new" });
    const queued = budget.acquire({ profileId: "two", kind: "new" });
    advance(1000);
    await expect(queued).rejects.toMatchObject(beforeSend);
    held.release(); budget.notify();
    expect(budget.snapshot()).toMatchObject({ executingTurns: 0, queueDepth: 0, totals: { admitted: 1, rejected: 1 } });
  });

  test("ineligible browser owners do not head-of-line block warm profiles", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1 });
    const held = await budget.acquire({ profileId: "one", kind: "new" });
    let browserAvailable = false;
    const cold = budget.acquire({ profileId: "cold", kind: "continuation", canRun: () => browserAvailable });
    const warm = budget.acquire({ profileId: "warm", kind: "new" });
    held.release();
    const warmLease = await warm;
    expect(budget.snapshot().queueDepth).toBe(1);
    warmLease.release();
    expect(budget.snapshot().executingTurns).toBe(0);
    browserAvailable = true; budget.notify();
    const coldLease = await cold; coldLease.release();
  });

  test("continuations outrank new work until new work reaches half its deadline", async () => {
    const { budget, advance } = fixture({ maxGlobalTurns: 1, queueTimeoutMs: 1000 });
    const held = await budget.acquire({ profileId: "one", kind: "new" });
    const root = budget.acquire({ profileId: "root", kind: "new" });
    const continuation = budget.acquire({ profileId: "continuation", kind: "continuation" });
    advance(499); held.release();
    const continuationLease = await continuation;
    expect(budget.snapshot().queueDepth).toBe(1);
    const laterContinuation = budget.acquire({ profileId: "another", kind: "continuation" });
    advance(1); continuationLease.release();
    const rootLease = await root;
    expect(budget.snapshot().profiles.find(profile => profile.profileId === "root")?.executingTurns).toBe(1);
    rootLease.release();
    const last = await laterContinuation; last.release();
    expect(budget.snapshot().totals.queueWaitMs).toBe(1000);
  });

  test("eligibility exceptions settle once without consuming compute", async () => {
    const { budget } = fixture();
    await expect(budget.acquire({ profileId: "one", kind: "new", canRun: () => { throw new Error("fixture"); } })).rejects.toMatchObject(beforeSend);
    expect(budget.snapshot()).toMatchObject({ executingTurns: 0, queueDepth: 0, totals: { rejected: 1 } });
  });
});

describe("native external-tool suspension and parent resumption", () => {
  test("parent -> nested child -> result -> parent resume never oversubscribes", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1 });
    const browser = await budget.reserveBrowser("one");
    const tab = budget.reserveTab("one");
    const retained = budget.reserveRetained("one");
    const parent = await budget.acquire({ profileId: "one", kind: "new" }); parent.markSubmitted();
    const newRoot = budget.acquire({ profileId: "root", kind: "new" });
    const child = budget.acquire({ profileId: "one", kind: "new", priority: "nested" });
    parent.suspendForExternalTools(); parent.suspendForExternalTools();
    const childLease = await child;
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, waitingToolTurns: 1, browsers: 1, tabs: { active: 1 } });
    const result = parent.resume();
    expect(parent.resume()).toBe(result);
    childLease.release(); await result;
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, waitingToolTurns: 0, queueDepth: 1 });
    // Reacquisition is complete before the consumer sends the external result.
    await parent.resume(); parent.release(); parent.release();
    const rootLease = await newRoot; rootLease.release();
    expect(budget.snapshot()).toMatchObject({ executingTurns: 0, browsers: 1, tabs: { active: 1 } });
    tab.release(); retained.release(); browser.release();
  });

  test("aged roots never outrank parent resumes or verified nested dependencies", async () => {
    const { budget, advance } = fixture({ maxGlobalTurns: 1, queueTimeoutMs: 1000 });
    const parent = await budget.acquire({ profileId: "parent", kind: "new" });
    const root = budget.acquire({ profileId: "root", kind: "new" });
    advance(500);
    const nested = budget.acquire({ profileId: "child", kind: "new", priority: "nested" });
    parent.suspendForExternalTools();
    const child = await nested;
    const resume = parent.resume();
    const nextNested = budget.acquire({ profileId: "child-two", kind: "continuation", priority: "nested" });
    child.release(); await resume;
    expect(budget.snapshot().profiles.find(profile => profile.profileId === "parent")?.executingTurns).toBe(1);
    parent.release();
    const next = await nextNested; next.release();
    const last = await root; last.release();
  });

  test("resume timeout after Send is unknown, preserves physical holds, and can settle", async () => {
    const { budget, advance } = fixture({ maxGlobalTurns: 1, queueTimeoutMs: 1000 });
    const parent = await budget.acquire({ profileId: "one", kind: "new" });
    const browser = await budget.reserveBrowser("one"); const tab = budget.reserveTab("one");
    parent.markSubmitted(); parent.suspendForExternalTools();
    const child = await budget.acquire({ profileId: "two", kind: "new", priority: "nested" });
    const resume = parent.resume(); advance(1000);
    await expect(resume).rejects.toMatchObject({ ...beforeSend, submission_state: "unknown" });
    expect(budget.snapshot()).toMatchObject({ waitingToolTurns: 1, executingTurns: 1, browsers: 1, tabs: { active: 1 } });
    parent.release(); child.release(); budget.notify();
    expect(budget.snapshot()).toMatchObject({ waitingToolTurns: 0, executingTurns: 0 });
    tab.release(); browser.release();
  });

  test("resume cancellation before Send is not_sent and release cancels pending resumption", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1 });
    const parent = await budget.acquire({ profileId: "one", kind: "new" }); parent.suspendForExternalTools();
    const child = await budget.acquire({ profileId: "two", kind: "new" });
    const abort = new AbortController();
    const resume = parent.resume(abort.signal); abort.abort();
    await expect(resume).rejects.toMatchObject(beforeSend);
    const anotherResume = parent.resume(); parent.release();
    await expect(anotherResume).rejects.toMatchObject(beforeSend);
    child.release();
    await parent.resume(); parent.suspendForExternalTools();
    expect(budget.snapshot()).toMatchObject({ waitingToolTurns: 0, executingTurns: 0, queueDepth: 0 });
  });
});

describe("physical resource ownership and drain", () => {
  test("browser reservations share one launch owner and last until physical close", async () => {
    const { budget } = fixture({ maxGlobalBrowsers: 1 });
    const [first, same] = await Promise.all([budget.reserveBrowser("one"), budget.reserveBrowser("one")]);
    expect(same).toBe(first);
    expect(budget.snapshot().browsers).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(budget.reserveBrowser("one", abort.signal)).rejects.toMatchObject(beforeSend);
    await expect(budget.reserveBrowser("two")).rejects.toMatchObject(beforeSend);
    const turn = await budget.acquire({ profileId: "one", kind: "new" }); turn.release();
    expect(budget.snapshot().browsers).toBe(1);
    first.release(); same.release();
    const next = await budget.reserveBrowser("two"); next.release();
    expect(budget.snapshot().browsers).toBe(0);
  });

  test("active and retained pages share the cap but inspections are separately bounded", () => {
    const { budget } = fixture({ maxGlobalTabs: 5 });
    const tabs = Array.from({ length: 5 }, () => budget.reserveTab("one"));
    tabs[0]!.setState("retainedNative"); tabs[0]!.setState("retainedNative");
    const inspection = budget.reserveTab("one", { inspection: true });
    expect(budget.snapshot().tabs).toEqual({ active: 4, retainedNative: 1, retainedGeneric: 0, inspection: 1 });
    expect(() => budget.reserveTab("two")).toThrow(ResourceCapacityError);
    expect(() => budget.reserveTab("one", { inspection: true })).toThrow(ResourceCapacityError);
    expect(() => inspection.setState("active")).toThrow(ResourceCapacityError);
    expect(() => tabs[0]!.setState("inspection")).toThrow(ResourceCapacityError);
    tabs[1]!.release(); tabs[1]!.release();
    const other = budget.reserveTab("two");
    tabs[0]!.setState("active");
    expect(budget.snapshot().tabs.active).toBe(5);
    other.release(); tabs.forEach(tab => tab.release()); inspection.release(); inspection.release();
    expect(budget.snapshot().tabs).toEqual({ active: 0, retainedNative: 0, retainedGeneric: 0, inspection: 0 });
  });

  test("per-profile physical tab ceiling stays five with a larger global limit", () => {
    const { budget } = fixture({ maxGlobalTabs: 10 });
    const tabs = Array.from({ length: 5 }, () => budget.reserveTab("one"));
    expect(() => budget.reserveTab("one")).toThrow(ResourceCapacityError);
    const other = budget.reserveTab("two");
    other.release(); tabs.forEach(tab => tab.release());
  });

  test("native retained ownership is independent of executing turns and never evicts", async () => {
    const { budget } = fixture({ maxRetainedTabsPerProfile: 1 });
    const retained = budget.reserveRetained("one");
    const parent = await budget.acquire({ profileId: "one", kind: "new" });
    parent.suspendForExternalTools();
    expect(() => budget.reserveRetained("one")).toThrow(ResourceCapacityError);
    expect(budget.snapshot().profiles[0]?.retainedSlots).toBe(1);
    await parent.resume(); parent.release();
    expect(() => budget.reserveRetained("one")).toThrow(ResourceCapacityError);
    retained.release(); retained.release();
    const next = budget.reserveRetained("one"); next.release();
  });

  test("pinned physical caps reject nested dependency before Send, without destroying parent", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1, maxGlobalTabs: 5 });
    const tabs = Array.from({ length: 5 }, () => budget.reserveTab("one"));
    tabs[0]!.setState("retainedNative");
    const parent = await budget.acquire({ profileId: "one", kind: "new" }); parent.markSubmitted(); parent.suspendForExternalTools();
    const child = await budget.acquire({ profileId: "child", kind: "new", priority: "nested" });
    let failure: unknown;
    try { budget.reserveTab("child"); } catch (error) { failure = error; } finally { child.release(); }
    expect(failure).toMatchObject(beforeSend);
    await parent.resume();
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, tabs: { active: 4, retainedNative: 1 } });
    parent.release(); tabs.forEach(tab => tab.release());
  });

  test("drain cancels queued work, leaves active and physical holds, and can reopen", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1 });
    const browser = await budget.reserveBrowser("one"); const tab = budget.reserveTab("one"); const retained = budget.reserveRetained("one");
    const active = await budget.acquire({ profileId: "one", kind: "new" });
    const queued = budget.acquire({ profileId: "two", kind: "new" }); budget.drain(); budget.drain();
    await expect(queued).rejects.toMatchObject(beforeSend);
    await expect(budget.acquire({ profileId: "three", kind: "new" })).rejects.toMatchObject(beforeSend);
    await expect(budget.reserveBrowser("three")).rejects.toMatchObject(beforeSend);
    expect(() => budget.reserveTab("three")).toThrow(ResourceCapacityError);
    expect(() => budget.reserveRetained("three")).toThrow(ResourceCapacityError);
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, queueDepth: 0, browsers: 1, tabs: { active: 1 } });
    active.release(); tab.release(); retained.release(); browser.release(); budget.undrain();
    const next = await budget.acquire({ profileId: "two", kind: "new" }); next.release();
  });

  test("drain rejects new work but lets accepted tool parents resume", async () => {
    const { budget } = fixture({ maxGlobalTurns: 1 });
    const parent = await budget.acquire({ profileId: "parent", kind: "new" });
    parent.markSubmitted(); parent.suspendForExternalTools();
    const child = await budget.acquire({ profileId: "child", kind: "new", priority: "nested" });
    const resume = parent.resume();
    const queuedRoot = budget.acquire({ profileId: "root", kind: "new" });
    budget.drain();
    await expect(queuedRoot).rejects.toMatchObject(beforeSend);
    child.release(); await resume;
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, waitingToolTurns: 0, queueDepth: 0 });
    parent.suspendForExternalTools(); await parent.resume();
    expect(budget.snapshot()).toMatchObject({ executingTurns: 1, waitingToolTurns: 0 });
    await expect(budget.acquire({ profileId: "root", kind: "new" })).rejects.toMatchObject(beforeSend);
    parent.release();
  });

  test("snapshots are aggregate copies and independent budgets never share state", async () => {
    const { budget } = fixture(); const other = fixture().budget;
    const lease = await budget.acquire({ profileId: "one", kind: "new" });
    budget.recordDomPoll({ cacheHit: true }); budget.recordDomPoll({ cacheHit: false }); budget.recordDomPoll();
    const snapshot = budget.snapshot();
    expect(snapshot.totals).toMatchObject({ polls: 3, domCacheHits: 1, domCacheMisses: 1 });
    expect(Object.keys(snapshot)).toEqual(["limits", "browsers", "tabs", "executingTurns", "waitingToolTurns", "queueDepth", "profiles", "totals"]);
    snapshot.tabs.active = 99; snapshot.limits.maxGlobalTurns = 99; snapshot.totals.admitted = 99;
    expect(budget.snapshot()).toMatchObject({ limits: { maxGlobalTurns: 2 }, tabs: { active: 0 }, totals: { admitted: 1 } });
    expect(other.snapshot()).toMatchObject({ executingTurns: 0, profiles: [], totals: { admitted: 0 } });
    lease.release();
  });
});
