import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveRequests: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => ({
  getActiveRequests: mocks.getActiveRequests,
}));

const { GET } = await import("../../src/app/api/health/route.js");

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the non-expiring live count used by deployment drain", async () => {
    mocks.getActiveRequests.mockResolvedValue({
      activeRequests: [],
      activeRequestsKnown: true,
      liveActiveRequests: [{ model: "chatgpt-web/high", provider: "chatgpt-web", count: 2 }],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_requests: 2,
      active_requests_known: true,
    });
  });

  it("fails closed when the live count is unknown", async () => {
    mocks.getActiveRequests.mockRejectedValue(new Error("usage unavailable"));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_requests: null,
      active_requests_known: false,
    });
  });
});
