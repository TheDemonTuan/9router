import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  weekly: vi.fn(),
  proxy: vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => url.includes("loadCodeAssist")
      ? { cloudaicompanionProject: "project-1", paidTier: { id: "pro" } }
      : { models: {} },
  })),
}));

vi.mock("../../open-sse/services/usage/antigravity-weekly.js", () => ({
  fetchAntigravityWeeklyQuota: mocks.weekly,
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxy }));

const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

describe("Antigravity usage abort propagation", () => {
  it("rethrows an aborted weekly refresh through the Google wrapper", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.weekly.mockRejectedValueOnce(abortError);
    const controller = new AbortController();
    controller.abort(abortError);

    await expect(getAntigravityUsage("token", {}, null, { signal: controller.signal }))
      .rejects.toBe(abortError);
  });
});
