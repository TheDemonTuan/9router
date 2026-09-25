import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isLocalRequest: vi.fn(),
  getHeadroomStatus: vi.fn(),
  getSettings: vi.fn(),
  getManagedPid: vi.fn(),
  getHeadroomRuntimeSnapshot: vi.fn(),
}));

vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://localhost:8787",
  getHeadroomStatus: mocks.getHeadroomStatus,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/headroom/process", () => ({
  getManagedPid: mocks.getManagedPid,
}));

vi.mock("open-sse/rtk/headroomRuntime.js", () => ({
  getHeadroomRuntimeSnapshot: mocks.getHeadroomRuntimeSnapshot,
}));

import { GET } from "../../src/app/api/headroom/status/route.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/headroom/status", () => {
  it("denies rawDashboardAvailable and localUrl for remote callers", async () => {
    mocks.isLocalRequest.mockReturnValue(false);
    mocks.getSettings.mockResolvedValue({ headroomUrl: "http://localhost:8787" });
    mocks.getHeadroomStatus.mockResolvedValue({
      running: true,
      ready: true,
      reachable: true,
      localUrl: true,
      sidecarVersion: "0.38.0",
      gatewaySupported: true,
      extras: { code: false, ml: false },
    });
    mocks.getManagedPid.mockReturnValue(12345);
    mocks.getHeadroomRuntimeSnapshot.mockReturnValue({ circuitState: "CLOSED" });

    const req = new Request("http://localhost:20127/api/headroom/status");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.rawDashboardAvailable).toBe(false);
    expect(data.localUrl).toBe(false);
    expect(data.url).toBeUndefined();
    expect(data.managedPid).toBeUndefined();
    expect(data.running).toBe(true);
    expect(data.sidecarVersion).toBe("0.38.0");
  });

  it("permits rawDashboardAvailable only when viewer and service are both local and running", async () => {
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.getSettings.mockResolvedValue({ headroomUrl: "http://localhost:8787" });
    mocks.getHeadroomStatus.mockResolvedValue({
      running: true,
      ready: true,
      reachable: true,
      localUrl: true,
      sidecarVersion: "0.38.0",
      gatewaySupported: true,
      extras: { code: false, ml: false },
    });
    mocks.getManagedPid.mockReturnValue(12345);
    mocks.getHeadroomRuntimeSnapshot.mockReturnValue({ circuitState: "CLOSED" });

    const req = new Request("http://localhost:20127/api/headroom/status");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.rawDashboardAvailable).toBe(true);
    expect(data.localUrl).toBe(true);
    expect(data.managedPid).toBe(12345);
  });

  it("keeps rawDashboardAvailable false when viewer is local but service URL is remote docker container", async () => {
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.getSettings.mockResolvedValue({ headroomUrl: "http://headroom:8787" });
    mocks.getHeadroomStatus.mockResolvedValue({
      running: true,
      ready: true,
      reachable: true,
      localUrl: false,
      sidecarVersion: "0.38.0",
      gatewaySupported: true,
      extras: { code: false, ml: false },
    });
    mocks.getManagedPid.mockReturnValue(null);
    mocks.getHeadroomRuntimeSnapshot.mockReturnValue({ circuitState: "CLOSED" });

    const req = new Request("http://localhost:20127/api/headroom/status");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.rawDashboardAvailable).toBe(false);
    expect(data.localUrl).toBe(false);
  });
});
