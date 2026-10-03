import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { CompactionTransactionStore as PinnedTransactionStore } from "./fixtures/upstream-fa2d2c6/compaction-transaction";
import {
  ChatGptBrowserProgress,
  ChatGptCompactionIdleDeadline,
  ChatGptExternalTurnProgress,
} from "../src/adapters/chatgpt-web/turn-progress";
import { cancelStructuredCompactionTrace, existingStructuredCompactionRun, runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";

const MINUTE = 60_000;

class Clock {
  time = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;

  install() {
    spyOn(Date, "now").mockImplementation(this.now);
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay = 0) => {
      const id = ++this.sequence;
      this.timers.set(id, { at: this.time + delay, callback });
      return { id, unref() { return this; } };
    }) as unknown as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: { id: number }) => {
      if (handle) this.timers.delete(handle.id);
    }) as unknown as typeof clearTimeout);
  }

  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const candidate of this.timers) {
        if (candidate[1].at <= target && (!next || candidate[1].at < next[1].at)) next = candidate;
      }
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

let clock: Clock;
beforeEach(() => { clock = new Clock(); clock.install(); });
afterEach(() => mock.restore());

function transaction() {
  const store = new CompactionTransactionStore(clock.now);
  const handle = store.begin("idle-test", 5 * MINUTE);
  const idle = new ChatGptCompactionIdleDeadline(new Error("idle timeout"), 5 * MINUTE, clock.now);
  idle.bindTransaction((ttl, now) => store.renew(handle.token, ttl, now));
  const outcome = store.wait(handle.token, idle.signal).then(
    summary => ({ summary }), error => ({ error: (error as Error).message }),
  );
  return { store, handle, idle, outcome };
}

test("real progress at four, eight and twelve minutes preserves both deadlines until summary delivery", async () => {
  const { store, handle, idle, outcome } = transaction();
  const mcp = idle.reporter();
  const browser = new ChatGptBrowserProgress(idle.reporter());
  clock.advance(4 * MINUTE);
  mcp("mcp_call", 1);
  clock.advance(4 * MINUTE);
  browser.observe("response", "First paragraph", true, false);
  clock.advance(4 * MINUTE);
  mcp("mcp_result", 2);
  clock.advance(4 * MINUTE);
  expect(idle.signal.aborted).toBe(false);
  store.submit(handle.token, handle.handoffId, "Continuation summary");
  expect(await outcome).toEqual({ summary: "Continuation summary" });
  expect(store.renew(handle.token, 5 * MINUTE)).toBe(false);
  idle.close();
});

test("repeated projection and static generating control expire once five minutes after real output", async () => {
  const { idle, outcome } = transaction();
  let aborts = 0;
  idle.signal.addEventListener("abort", () => { aborts += 1; });
  const browser = new ChatGptBrowserProgress(idle.reporter());
  browser.observe("response", "Stable paragraph", true, false);
  for (let minute = 0; minute < 4; minute += 1) {
    clock.advance(MINUTE);
    browser.observe("response", "Stable paragraph", true, false);
  }
  clock.advance(MINUTE - 1);
  expect(idle.signal.aborted).toBe(false);
  clock.advance(1);
  expect(idle.signal.aborted).toBe(true);
  expect(await outcome).toEqual({ error: "compaction transaction timed out" });
  clock.advance(10 * MINUTE);
  expect(aborts).toBe(1);
  idle.close();
});

test("replayed and stale source revisions cannot postpone expiry", async () => {
  const { idle, outcome } = transaction();
  idle.noteProgress("tool_batch", 2);
  const report = idle.reporter();
  report("checkpoint", 1);
  clock.advance(4 * MINUTE);
  idle.noteProgress("tool_batch", 2);
  idle.noteProgress("tool_batch", 1);
  report("checkpoint", 1);
  report("checkpoint", 0);
  clock.advance(MINUTE);
  expect(await outcome).toEqual({ error: "compaction transaction timed out" });
  expect(idle.signal.aborted).toBe(true);
  idle.close();
});

test("late progress cannot revive expired capabilities even before delayed timer callbacks execute", async () => {
  const { store, handle, idle, outcome } = transaction();
  clock.time = 5 * MINUTE + 1;
  idle.noteProgress("assistant_dom", 1);
  expect(idle.signal.aborted).toBe(true);
  expect(store.renew(handle.token, 5 * MINUTE)).toBe(false);
  expect(await outcome).toEqual({ error: "compaction transaction aborted" });
  expect(() => store.submit(handle.token, handle.handoffId, "Too late")).toThrow("invalid, expired, or consumed");
  idle.close();
});

test("a separately expired transaction cannot renew the still-live local idle deadline", async () => {
  const store = new CompactionTransactionStore(clock.now);
  const handle = store.begin("short-capability", MINUTE);
  const outcome = store.wait(handle.token).catch(error => error.message);
  const idle = new ChatGptCompactionIdleDeadline(new Error("idle timeout"), 5 * MINUTE, clock.now);
  clock.time = MINUTE + 1;
  // An expired capability must fail binding, not receive a fresh five-minute lifetime.
  idle.bindTransaction((ttl, now) => store.renew(handle.token, ttl, now));
  idle.noteProgress("mcp_call", 1);
  expect(await outcome).toBe("compaction transaction timed out");
  expect(idle.signal.aborted).toBe(true);
  idle.close();
});

test("settled, consumed and explicitly aborted transactions cannot renew", async () => {
  const store = new CompactionTransactionStore(clock.now);
  const settled = store.begin("settled", 5 * MINUTE);
  store.submit(settled.token, settled.handoffId, "Finished");
  expect(store.renew(settled.token, 5 * MINUTE)).toBe(false);
  expect(await store.wait(settled.token)).toBe("Finished");
  expect(store.renew(settled.token, 5 * MINUTE)).toBe(false);
  const aborted = store.begin("aborted", 5 * MINUTE);
  store.abort(aborted.token);
  expect(store.renew(aborted.token, 5 * MINUTE)).toBe(false);
  store.close();
});

test("retirement and unchanged active tool counts cannot renew compaction", async () => {
  const { idle, outcome } = transaction();
  const progress = new ChatGptExternalTurnProgress();
  progress.subscribeProgress(idle.reporter());
  progress.recordToolBatch(1, clock.time);
  clock.advance(4 * MINUTE);
  expect(progress.snapshot().activeToolCalls).toBe(1);
  progress.retire(new Error("cancelled"));
  progress.recordProgress("mcp_call", 20);
  clock.advance(MINUTE);
  expect(await outcome).toEqual({ error: "compaction transaction timed out" });
  expect(idle.signal.aborted).toBe(true);
  idle.close();
});

test("logical settlement does not prune a physical compaction owner after thirty minutes", async () => {
  let finishPhysical!: () => void;
  let finishSummary!: (summary: string) => void;
  const physical = new Promise<void>(resolve => { finishPhysical = resolve; });
  const summary = new Promise<string>(resolve => { finishSummary = resolve; });
  const key = "idle-test:physical-owner";
  const run = runStructuredCompactionOnce(key, {
    executionNamespace: "idle-test", ownerKey: "idle-test:owner", traceIds: ["physical-test"],
  }, async (_signal, retain) => { retain(physical); return summary; });
  await Promise.resolve();
  clock.advance(31 * MINUTE);
  expect(existingStructuredCompactionRun(key)).toBe(run);
  finishSummary("Checkpoint");
  expect(await run).toBe("Checkpoint");
  clock.advance(31 * MINUTE);
  expect(existingStructuredCompactionRun(key)).toBe(run);
  finishPhysical();
  await cancelStructuredCompactionTrace("physical-test", new Error("test cleanup"));
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
});

test("isolated frozen upstream #731 reproducer loses the capability despite four-minute progress", async () => {
  // Verbatim source from fa2d2c6c24926078b46eedb2186f69f2e8d548d7, not a hand-written old implementation.
  const pinned = new PinnedTransactionStore();
  const handle = pinned.begin("pinned-731", 5 * MINUTE);
  const outcome = pinned.wait(handle.token).catch(error => error.message);
  const idle = new ChatGptCompactionIdleDeadline(new Error("idle timeout"), 5 * MINUTE, clock.now);
  clock.advance(4 * MINUTE);
  idle.noteProgress("assistant_dom", 1);
  clock.advance(MINUTE);
  expect(idle.signal.aborted).toBe(false);
  expect(await outcome).toBe("compaction transaction timed out");
  expect(() => pinned.submit(handle.token, handle.handoffId, "Lost summary")).toThrow("invalid, expired, or consumed");
  idle.close();
  pinned.close();
});
