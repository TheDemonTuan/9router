import { describe, expect, test } from "bun:test";
import { DomPollCadence, waitForDomPoll, type DomPollState, type ChatGptTurnProgressReader } from "../src/adapters/chatgpt-web/turn-progress";

const waiting: DomPollState = {
  signature: "unchanged-response", externalRevision: 1, activeToolCalls: 1,
  acknowledgedToolBatch: true, generationActive: false,
};

// Pure state/Promise fixtures: no browser, server, network or elapsed-time sleeps.
describe("DOM poll cadence", () => {
  test("fixed polling is the default even during a stable tool wait", () => {
    const cadence = new DomPollCadence();
    for (let i = 0; i < 20; i++) expect(cadence.observe(waiting)).toBe(250);
  });

  test("only four stable external-tool polls start backoff, bounded at 1000ms", () => {
    const cadence = new DomPollCadence(true);
    expect(Array.from({ length: 12 }, () => cadence.observe(waiting)))
      .toEqual([250, 250, 250, 250, 500, 500, 500, 500, 1000, 1000, 1000, 1000]);
  });

  test("DOM growth, generation transitions and external revisions reset immediately", () => {
    for (const change of [
      { signature: "grown-response" }, { externalRevision: 2 }, { generationActive: true },
    ]) {
      const cadence = new DomPollCadence(true);
      for (let i = 0; i < 10; i++) cadence.observe(waiting);
      expect(cadence.observe({ ...waiting, ...change })).toBe(250);
    }
  });

  test("approval, fences, submission, publication and model silence never back off", () => {
    for (const blocker of [
      { pendingApproval: true }, { pendingCompletionFence: true }, { pendingSubmission: true },
      { pendingResultPublication: true }, { acknowledgedToolBatch: false }, { activeToolCalls: 0 },
    ]) {
      const cadence = new DomPollCadence(true);
      for (let i = 0; i < 12; i++) expect(cadence.observe({ ...waiting, ...blocker })).toBe(250);
      expect(cadence.observe(waiting)).toBe(250);
    }
  });

  test("reset restarts the stability window", () => {
    const cadence = new DomPollCadence(true);
    for (let i = 0; i < 10; i++) cadence.observe(waiting);
    cadence.reset();
    expect(cadence.observe(waiting)).toBe(250);
  });

  test("external progress cancels the losing waiter without an elapsed delay", async () => {
    let loserSignal: AbortSignal | undefined;
    const snapshot = { revision: 2, lastToolBatchRevision: 1, activeToolCalls: 1 };
    const reader: ChatGptTurnProgressReader = {
      snapshot: () => snapshot,
      acknowledgeToolBatch: async () => {},
      waitForChange: async (_revision, signal) => { loserSignal = signal; return snapshot; },
    };
    await waitForDomPoll(1000, reader, 1);
    expect(loserSignal?.aborted).toBe(true);
  });

  test("abort rejects the delay and cancels the external waiter", async () => {
    const abort = new AbortController();
    let loserSignal: AbortSignal | undefined;
    const reader: ChatGptTurnProgressReader = {
      snapshot: () => ({ revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1 }),
      acknowledgeToolBatch: async () => {},
      waitForChange: (_revision, signal) => {
        loserSignal = signal;
        const { promise, reject } = Promise.withResolvers<never>();
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        return promise;
      },
    };
    const delay = waitForDomPoll(1000, reader, 1, abort.signal);
    abort.abort(new Error("synthetic cancellation"));
    await expect(delay).rejects.toThrow("synthetic cancellation");
    expect(loserSignal?.aborted).toBe(true);
  });
});
