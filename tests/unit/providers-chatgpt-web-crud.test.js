import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  getProxyPoolById: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  createProviderConnection: mocks.createProviderConnection,
  getProviderNodeById: mocks.getProviderNodeById,
  getProviderNodes: mocks.getProviderNodes,
  getProxyPoolById: mocks.getProxyPoolById,
}));

const { POST } = await import("../../src/app/api/providers/route.js");

describe("POST /api/providers ChatGPT Web connection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores only a validated bridge ID with bridge auth", async () => {
    mocks.createProviderConnection.mockResolvedValue({
      id: "bridge-1",
      provider: "chatgpt-web",
      authType: "bridge",
      name: "Personal Web",
      apiKey: "",
      providerSpecificData: { bridgeId: "personal" },
    });

    const response = await POST(new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", name: "Personal Web", bridgeId: " personal " }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "chatgpt-web",
      authType: "bridge",
      apiKey: "",
      providerSpecificData: expect.objectContaining({ bridgeId: "personal" }),
    }));
  });

  it("masks nested provider credentials in GET responses", async () => {
    const { GET } = await import("../../src/app/api/providers/route.js");
    mocks.getProviderConnections.mockResolvedValue([{
      id: "bridge-1",
      provider: "chatgpt-web",
      providerSpecificData: { bridgeId: "personal", nested: { accessToken: "secret", label: "ok" } },
      accessToken: "secret",
    }]);
    mocks.getProviderNodes.mockResolvedValue([]);

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.connections[0].accessToken).toBeUndefined();
    expect(body.connections[0].providerSpecificData).toEqual({ bridgeId: "personal", nested: { label: "ok" } });
  });

  it("rejects malformed bridge data before persistence", async () => {
    const response = await POST(new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", name: "Invalid", providerSpecificData: { bridgeId: 7 } }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
});
