import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldAttemptPrewarm,
  enqueuePrewarmJob,
  getSessionWarmupState,
  recordWarmupSuccess,
  recordWarmupFailure,
  estimateBodyTextTokens,
  buildWarmupKey,
  resetWarmupStoreForTest,
  getWarmupRuntimeSnapshot,
} from "../../open-sse/rtk/headroomWarmup.js";

beforeEach(() => {
  resetWarmupStoreForTest();
  vi.restoreAllMocks();
});

describe("Headroom Warmup Queue and Orchestration", () => {
  const endpoint = "http://127.0.0.1:8787/v1/compress";
  const sessionId = "s_session_12345";
  const makeBody = (chars = 200000) => ({
    model: "claude-3-7-sonnet",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "x".repeat(chars) },
    ],
  });

  it("calculates text token estimate safely for large contexts", () => {
    const body = makeBody(200000);
    const est = estimateBodyTextTokens(body, "openai");
    expect(est).toBeGreaterThanOrEqual(50000);
  });

  it("evaluates prewarm eligibility: rejects non-SSE, small body, missing session", () => {
    const smallBody = makeBody(100);
    const largeBody = makeBody(250000);

    // Non-SSE
    expect(shouldAttemptPrewarm({ enabled: true, isSSE: false, sessionId, body: largeBody, endpoint }).eligible).toBe(false);
    // Missing session
    expect(shouldAttemptPrewarm({ enabled: true, isSSE: true, sessionId: null, body: largeBody, endpoint }).eligible).toBe(false);
    // Below token threshold
    expect(shouldAttemptPrewarm({ enabled: true, isSSE: true, sessionId, body: smallBody, endpoint }).eligible).toBe(false);
    // Eligible
    const decision = shouldAttemptPrewarm({ enabled: true, isSSE: true, sessionId, body: largeBody, endpoint });
    expect(decision.eligible).toBe(true);
    expect(decision.key).toBe(buildWarmupKey({ endpoint, sessionId, format: "openai" }));
  });

  it("deduplicates multiple concurrent calls for the same session", () => {
    const largeBody = makeBody(250000);
    const callGatewayFn = vi.fn().mockImplementation(() => new Promise(() => {})); // hung promise

    const enqueued1 = enqueuePrewarmJob({
      endpoint,
      model: "claude",
      format: "openai",
      body: largeBody,
      sessionId,
      callGatewayFn,
    });
    expect(enqueued1).toBe(true);

    const state = getSessionWarmupState(buildWarmupKey({ endpoint, sessionId, format: "openai" }));
    expect(["QUEUED", "WARMING"]).toContain(state.state);

    // Turn 2 comes in while still in flight -> should be skipped from queueing again
    const decision2 = shouldAttemptPrewarm({ enabled: true, isSSE: true, sessionId, body: largeBody, endpoint });
    expect(decision2.eligible).toBe(false);
    expect(decision2.reason).toBe("warmup_in_flight");
  });

  it("records success and updates state to READY with unit information", () => {
    const key = buildWarmupKey({ endpoint, sessionId, format: "openai" });
    recordWarmupSuccess(key, { fingerprint: "fp1", frozenCount: 24, unit: "messages" });

    const state = getSessionWarmupState(key);
    expect(state.state).toBe("READY");
    expect(state.frozenCount).toBe(24);
    expect(state.unit).toBe("messages");
  });

  it("records failure with backoff and moves to COOLDOWN or UNKNOWN_TIMEOUT", () => {
    const key = buildWarmupKey({ endpoint, sessionId, format: "openai" });
    recordWarmupFailure(key, "gateway_timeout");

    const stateTimeout = getSessionWarmupState(key);
    expect(stateTimeout.state).toBe("UNKNOWN_TIMEOUT");
    expect(stateTimeout.failureCount).toBe(1);

    recordWarmupFailure(key, "gateway_http_500");
    const state500 = getSessionWarmupState(key);
    expect(state500.state).toBe("COOLDOWN");
    expect(state500.failureCount).toBe(2);
  });

  it("tracks runtime snapshot metrics accurately", () => {
    const snap = getWarmupRuntimeSnapshot();
    expect(snap.queueLength).toBe(0);
    expect(snap.queuedBytes).toBe(0);
    expect(snap.runningCount).toBe(0);
    expect(snap.metrics.queuedTotal).toBe(0);
  });
});
