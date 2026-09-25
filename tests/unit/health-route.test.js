import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveRequests: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => ({
  getActiveRequests: mocks.getActiveRequests,
}));

const { GET, OPTIONS } = await import("../../src/app/api/health/route.js");

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("identifies blue and green without treating the bind HOSTNAME as an instance or slot", async () => {
    mocks.getActiveRequests.mockResolvedValue({ activeRequestsKnown: true, liveActiveRequests: [] });
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    vi.stubEnv("DEPLOY_SLOT", "blue");
    const blue = await GET();
    expect(blue.headers.get("Cache-Control")).toBe("no-store");
    expect(blue.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(blue.json()).resolves.toMatchObject({
      ok: true,
      instance_id: `${os.hostname()}-${process.pid}`,
      deployment_slot: "blue",
    });

    process.env.DEPLOY_SLOT = "green";
    await expect((await GET()).json()).resolves.toMatchObject({ deployment_slot: "green" });

    delete process.env.DEPLOY_SLOT;
    await expect((await GET()).json()).resolves.toMatchObject({ deployment_slot: null });
  });

  it("keeps preflight OPTIONS at 204 with CORS", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("reports the non-expiring live count used by deployment drain", async () => {
    mocks.getActiveRequests.mockResolvedValue({
      activeRequests: [],
      activeRequestsKnown: true,
      liveActiveRequests: [{ model: "chatgpt-web/high", provider: "chatgpt-web", count: 2 }],
      activeStreams: 1,
      activeNonStream: 1,
      oldestActiveMs: 42000,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_requests: 2,
      active_requests_known: true,
      active_streams: 1,
      active_non_stream: 1,
      oldest_active_ms: 42000,
    });
  });

  it("reports zeros and null oldest when idle", async () => {
    mocks.getActiveRequests.mockResolvedValue({
      activeRequests: [],
      activeRequestsKnown: true,
      liveActiveRequests: [],
      activeStreams: 0,
      activeNonStream: 0,
      oldestActiveMs: null,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_requests: 0,
      active_requests_known: true,
      active_streams: 0,
      active_non_stream: 0,
      oldest_active_ms: null,
    });
  });

  it("fails closed when the live count is unknown", async () => {
    mocks.getActiveRequests.mockRejectedValue(new Error("usage unavailable"));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_requests: null,
      active_requests_known: false,
      active_streams: null,
      active_non_stream: null,
      oldest_active_ms: null,
    });
  });
});
