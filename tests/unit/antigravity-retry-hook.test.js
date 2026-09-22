import { describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Request cannot be served",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "QUOTA_EXHAUSTED",
      metadata: { quotaResetTimeStamp: "2026-09-24T02:26:46Z" },
    }],
  },
});

describe("Antigravity executor hard quota", () => {
  it("makes one generation call, preserves the response body, and skips retry delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
    proxyAwareFetch.mockReset().mockResolvedValueOnce(new Response(QUOTA_BODY, { status: 429 }));
    const executor = new AntigravityExecutor();

    try {
      const result = await executor.execute({
        model: "gemini-3.8-flash-high",
        body: { request: { contents: [] } },
        stream: false,
        credentials: { accessToken: "token", projectId: "project" },
      });
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
      expect(result.response.status).toBe(429);
      await expect(result.response.text()).resolves.toBe(QUOTA_BODY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers timestamp, then RetryInfo, metadata delay, and text reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
    const executor = new AntigravityExecutor();
    const body = (metadata, retryDelay, message = "Request cannot be served") => JSON.stringify({ error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message,
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", metadata },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    } });
    try {
      const withTimestamp = executor.parseError(new Response(body({ quotaResetTimeStamp: "2026-09-24T02:26:46Z", quotaResetDelay: "48h" }, "142353.125s"), { status: 429 }), body({ quotaResetTimeStamp: "2026-09-24T02:26:46Z", quotaResetDelay: "48h" }, "142353.125s"));
      expect(withTimestamp.resetsAtMs).toBe(Date.parse("2026-09-24T02:26:46Z"));
      const withRetry = executor.parseError(new Response(body({ quotaResetTimeStamp: "bad", quotaResetDelay: "48h" }, "2s"), { status: 429 }), body({ quotaResetTimeStamp: "bad", quotaResetDelay: "48h" }, "2s"));
      expect(withRetry.resetsAtMs).toBe(Date.parse("2026-09-23T00:00:02Z"));
      const withDelay = executor.parseError(new Response(body({ quotaResetTimeStamp: "bad", quotaResetDelay: "48h" }, "bad"), { status: 429 }), body({ quotaResetTimeStamp: "bad", quotaResetDelay: "48h" }, "bad"));
      expect(withDelay.resetsAtMs).toBe(Date.parse("2026-09-25T00:00:00Z"));
      const withText = executor.parseError(new Response(body({ quotaResetTimeStamp: "bad", quotaResetDelay: "bad" }, "bad", "reset after 30s"), { status: 429 }), body({ quotaResetTimeStamp: "bad", quotaResetDelay: "bad" }, "bad", "reset after 30s"));
      expect(withText.resetsAtMs).toBe(Date.parse("2026-09-23T00:00:30Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not classify RESOURCE_EXHAUSTED as hard quota without ErrorInfo", () => {
    const executor = new AntigravityExecutor();
    const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Request cannot be served" } });
    const parsed = executor.parseError(new Response(body, { status: 429 }), body);
    expect(parsed.errorClass).toBeUndefined();
  });
});
