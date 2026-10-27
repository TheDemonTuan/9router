import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  getProxyPoolById: vi.fn(),
}));
vi.mock("@/models", () => mocks);
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
const { GET, POST } = await import("../../src/app/api/providers/route.js");
const request = (body) => new Request("http://localhost/api/providers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "cookie-account", ...data }));
});

describe("upstream ChatGPT Web cookie connections", () => {
  it("stores the supplied cookie through the standard provider flow without provisioning a runtime", async () => {
    const response = await POST(request({
      provider: "chatgpt-web", name: "Cookie account", apiKey: "synthetic-cookie",
      providerSpecificData: { browserProfileId: "upstream-profile" },
    }));
    expect(response.status).toBe(201);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "chatgpt-web", authType: "cookie", apiKey: "synthetic-cookie",
      providerSpecificData: expect.objectContaining({ browserProfileId: "upstream-profile" }),
    }));
    const body = await response.json();
    expect(body.connection.authType).toBe("cookie");
    expect(body.connection).not.toHaveProperty("apiKey");
  });

  it("requires a real cookie rather than treating a legacy runtime selector as authentication", async () => {
    const response = await POST(request({
      provider: "chatgpt-web", name: "Legacy account", providerSpecificData: { profileId: "old-runtime" },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Cookie value is required" });
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("redacts nested credential data while retaining non-secret upstream browser metadata", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "cookie-account", provider: "chatgpt-web", authType: "cookie", apiKey: "synthetic-cookie",
      accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: "synthetic-id",
      providerSpecificData: {
        browserProfileId: "upstream-profile", nested: { cookies: ["private"], accessToken: "private", label: "keep" },
      },
    }]);
    const { connections } = await (await GET()).json();
    expect(connections[0].providerSpecificData).toEqual({ browserProfileId: "upstream-profile", nested: { label: "keep" } });
    for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"]) expect(connections[0]).not.toHaveProperty(field);
  });

  it("does not rewrite existing runtime-profile records into cookie connections during listing", async () => {
    const legacy = { id: "legacy", provider: "chatgpt-web", authType: "bridge", providerSpecificData: { profileId: "old-runtime" } };
    mocks.getProviderConnections.mockResolvedValue([legacy]);
    const { connections } = await (await GET()).json();
    expect(connections).toEqual([legacy]);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
});
