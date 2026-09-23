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

  it("reports transport and oldest-request diagnostics without request details", async () => {
    globalThis.__ninerouterDrainResponses = {
      active: 1,
      known: true,
      entries: new Map([["opaque", { id: "opaque", startedAt: Date.now() - 2000 }]]),
    };
    mocks.getActiveRequests.mockResolvedValue({
      activeRequests: [],
      activeRequestsKnown: true,
      liveActiveRequests: [{ model: "model", provider: "provider", count: 1 }],
      oldestActiveRequestMs: 2000,
      activeRequestDetails: [{ requestId: "request-id", model: "model", startedAt: Date.now() - 2000 }],
    });

    const response = await GET(new Request("http://localhost/api/health"));
    const body = await response.json();
    expect(body).toMatchObject({
      drain_contract_version: 2,
      active_responses: 1,
      active_responses_known: true,
    });
    expect(body.oldest_active_request_ms).toBeGreaterThanOrEqual(1900);
    expect(body.oldest_active_request_ms).toBeLessThan(5000);
    expect(body.active_requests_details).toBeUndefined();
  });

  it("rejects remote health details", async () => {
    const response = await GET(new Request("https://api.example/api/health?details=1"));
    expect(response.status).toBe(403);
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
