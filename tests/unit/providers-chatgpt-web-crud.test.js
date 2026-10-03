import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProviderConnections: vi.fn(), createProviderConnection: vi.fn(), getProviderConnectionById: vi.fn(), getProviderNodeById: vi.fn(), getProviderNodes: vi.fn(), getProxyPoolById: vi.fn(), updateProviderConnection: vi.fn(), deleteProviderConnection: vi.fn(), invalidateChatGptWebCatalog: vi.fn() }));
vi.mock("@/models", () => mocks);
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({
  invalidateChatGptWebCatalog: mocks.invalidateChatGptWebCatalog,
  validateChatGptWebProfileId: value => {
    if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) throw new Error("Invalid profileId");
    return value;
  },
}));
const { POST, GET } = await import("../../src/app/api/providers/route.js");
const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
const request = (body, method = "POST") => new Request("http://localhost/api/providers", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.createProviderConnection.mockImplementation(async data => ({ id: "one", ...data }));
  mocks.updateProviderConnection.mockImplementation(async (id, data) => ({ id, provider: "chatgpt-web", ...data }));
});
describe("profile CRUD", () => {
  it("stores only the canonical profile selector with bridge auth", async () => {
    const response = await POST(request({ provider: "chatgpt-web", name: "Personal Web", profileId: " personal " }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ connection: { authType: "bridge", providerSpecificData: { profileId: "personal" } } });
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "", providerSpecificData: { profileId: "personal" } }));
  });
  it("redacts stored legacy settings and nested credentials from GET", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal", nested: { accessToken: "secret", label: "old" }, mode: "full" }, accessToken: "secret" }]);
    const body = await (await GET()).json();
    expect(body.connections[0].accessToken).toBeUndefined();
    expect(body.connections[0].providerSpecificData).toEqual({ profileId: "personal" });
  });
  it.each([{ profileId: 7 }, { profileId: "../escape" }, { profileId: "Upper" }])("rejects invalid selectors %j before persistence", async providerSpecificData => {
    expect((await POST(request({ provider: "chatgpt-web", name: "Invalid", providerSpecificData }))).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
  it.each([{ runtimeUrl: "http://other" }, { token: "secret" }, { cookie: "secret" }, { apiKey: "secret" }, { providerSpecificData: { profileId: "personal", autoApproveToolCalls: true } }])("rejects runtime configuration and credentials %j", async extra => {
    expect((await POST(request({ provider: "chatgpt-web", name: "Invalid", profileId: "personal", ...extra }))).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
  it("rejects conflicting top-level and nested selectors without guessing", async () => {
    expect((await POST(request({ provider: "chatgpt-web", name: "Invalid", profileId: "personal", providerSpecificData: { profileId: "other" } }))).status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
  it("replaces rather than merges old provider settings on an update", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal", mode: "full", cookie: "old" } });
    const response = await PUT(request({ name: "Renamed" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", { name: "Renamed", providerSpecificData: { profileId: "personal" } });
    expect(await response.json()).toMatchObject({ connection: { providerSpecificData: { profileId: "personal" } } });
  });
  it("accepts a new selector on update without retaining obsolete settings", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal", mode: "full" } });
    const response = await PUT(request({ profileId: "other" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { providerSpecificData: { profileId: "other" } } });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", { providerSpecificData: { profileId: "other" } });
  });
  it("rejects credentials on update before persistence", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal" } });
    expect((await PUT(request({ cookie: "secret" }, "PUT"), { params: Promise.resolve({ id: "one" }) })).status).toBe(400);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
