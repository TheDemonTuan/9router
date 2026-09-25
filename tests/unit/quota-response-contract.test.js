import { describe, expect, it, vi } from "vitest";

import { quotaExhaustedResponse } from "../../open-sse/utils/error.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const RESET_AT = "2026-09-24T07:38:55.000Z";
const RESET_AT_SECONDS = Math.floor(Date.parse(RESET_AT) / 1000);

describe("quotaExhaustedResponse", () => {
  it("does not advance combo models on terminal Headroom session failure", async () => {
    const attempt = vi.fn().mockResolvedValue(new Response("session unavailable", {
      status: 503, headers: { "x-9router-no-fallback": "true", "x-should-retry": "true" },
    }));
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/first", "provider/second"],
      handleSingleModel: attempt,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "headroom-combo", comboStrategy: "fallback",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("true");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("returns the terminal OpenAI-compatible quota contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T00:00:00.000Z"));

    try {
      const response = quotaExhaustedResponse("Provider quota exhausted", RESET_AT, "reset after 4d 8h");

      expect(response.status).toBe(429);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.get("x-9router-error-code")).toBe("provider_quota_exhausted");
      expect(response.headers.get("x-9router-retry-at")).toBe(RESET_AT);
      expect(response.headers.get("Retry-After")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: {
          message: "Provider quota exhausted (reset after 4d 8h)",
          type: "usage_limit_reached",
          code: "insufficient_quota",
          param: null,
          resets_at: RESET_AT_SECONDS,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits timestamp-derived fields when the reset is invalid", async () => {
    const response = quotaExhaustedResponse("Provider quota exhausted", "not-a-date");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(response.headers.get("x-9router-retry-at")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Provider quota exhausted",
        type: "usage_limit_reached",
        code: "insufficient_quota",
        param: null,
      },
    });
  });

  it("preserves the earliest terminal quota response after every combo model fails", async () => {
    const later = quotaExhaustedResponse("late", "2026-09-25T00:00:00.000Z", "reset after 5d");
    const earlier = quotaExhaustedResponse("early", RESET_AT, "reset after 4d");
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/late", "provider/early"],
      handleSingleModel: vi.fn()
        .mockResolvedValueOnce(later)
        .mockResolvedValueOnce(earlier),
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "quota-combo",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-9router-retry-at")).toBe(RESET_AT);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "insufficient_quota" },
    });
  });
});
