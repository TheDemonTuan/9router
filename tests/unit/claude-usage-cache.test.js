import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe("Claude usage cache expiry", () => {
  it("keeps stale fallback at its original expiry after a soft failure", async () => {
    const token = "claude-stale-expiry";
    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" },
      }),
    });

    const first = await getClaudeUsage(token);
    vi.advanceTimersByTime(600_001);
    mocks.proxyAwareFetch.mockRejectedValue(new Error("temporary outage"));

    await expect(getClaudeUsage(token, null, { force: true })).resolves.toEqual(first);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);

    // The stale result's original TTL is already expired; it must not be
    // republished as a fresh cache hit after the soft failure.
    await getClaudeUsage(token);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(3);
  });
});
