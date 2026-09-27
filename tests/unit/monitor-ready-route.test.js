import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
const { GET } = await import("../../src/app/api/monitor/ready/route.js");

describe("GET /api/monitor/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdapter.mockResolvedValue({ get: mocks.get });
  });

  it("reports ready only when the settings table exists", async () => {
    mocks.get.mockReturnValue({ name: "settings" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ready: true });
    expect(mocks.get).toHaveBeenCalledWith("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'");
  });

  it("reports missing schema as unavailable", async () => {
    mocks.get.mockReturnValue(undefined);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ready: false });
  });

  it("does not reveal database failures", async () => {
    mocks.getAdapter.mockRejectedValue(new Error("private database path"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe('{"ready":false}');
  });
});
