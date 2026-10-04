import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProviderConnections: vi.fn(), createProviderConnection: vi.fn(), getProviderConnectionById: vi.fn(), getProviderNodeById: vi.fn(), getProviderNodes: vi.fn(), getProxyPoolById: vi.fn(), updateProviderConnection: vi.fn(), deleteProviderConnection: vi.fn(), invalidateChatGptWebCatalog: vi.fn(), requestChatGptWebRuntimeAdmin: vi.fn(), authorizeChatGptWebRuntimeAdmin: vi.fn() }));
vi.mock("@/models", () => mocks);
vi.mock("@/dashboardGuard", () => ({ authorizeChatGptWebRuntimeAdmin: mocks.authorizeChatGptWebRuntimeAdmin }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({
  invalidateChatGptWebCatalog: mocks.invalidateChatGptWebCatalog,
  requestChatGptWebRuntimeAdmin: mocks.requestChatGptWebRuntimeAdmin,
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
  mocks.getProviderConnections.mockResolvedValue([]);
  mocks.authorizeChatGptWebRuntimeAdmin.mockResolvedValue(true);
  mocks.requestChatGptWebRuntimeAdmin.mockImplementation(async (path, init) => Response.json(path === "/admin/profiles" && init?.method === "POST" ? { ...JSON.parse(init.body), state: "login_required" } : { profiles: [] }));
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
  it("automatically creates distinct private profiles and persists login_required, never caller-supplied ready", async () => {
    const first = await POST(request({ provider: "chatgpt-web", name: "First", testStatus: "ready" }));
    const second = await POST(request({ provider: "chatgpt-web", name: "Second" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = (await first.json()).connection;
    const b = (await second.json()).connection;
    expect(a.providerSpecificData.profileId).toMatch(/^cgw-[a-f0-9-]{36}$/);
    expect(b.providerSpecificData.profileId).not.toBe(a.providerSpecificData.profileId);
    expect(a.testStatus).toBe("login_required");
    expect(b.testStatus).toBe("login_required");
    const creations = mocks.requestChatGptWebRuntimeAdmin.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(creations.map(([, init]) => JSON.parse(init.body))).toEqual([{ profileId: a.providerSpecificData.profileId }, { profileId: b.providerSpecificData.profileId }]);
  });
  it("provisions an explicit missing profile before saving its connection", async () => {
    const response = await POST(request({ provider: "chatgpt-web", name: "Existing selector", providerSpecificData: { profileId: "personal" } }));
    expect(response.status).toBe(201);
    expect(mocks.requestChatGptWebRuntimeAdmin).toHaveBeenCalledWith("/admin/profiles", expect.objectContaining({ method: "POST", body: JSON.stringify({ profileId: "personal" }) }), expect.anything());
    expect(mocks.requestChatGptWebRuntimeAdmin.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.createProviderConnection.mock.invocationCallOrder[0]);
  });
  it("links an existing profile without replacing settings, revision, or epoch", async () => {
    const profile = { profileId: "personal", state: "ready", revision: 9, profile_epoch: "epoch", settings: { mode: "full", useSavedChats: true } };
    mocks.requestChatGptWebRuntimeAdmin.mockResolvedValue(Response.json({ profiles: [profile] }));
    const response = await POST(request({ provider: "chatgpt-web", name: "Existing", profileId: "personal" }));
    expect(response.status).toBe(201);
    expect(mocks.requestChatGptWebRuntimeAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.requestChatGptWebRuntimeAdmin.mock.calls[0][1]).not.toHaveProperty("method", "POST");
    expect(await response.json()).toMatchObject({ connection: { testStatus: "login_required", providerSpecificData: { profileId: "personal" } } });
    expect(profile).toMatchObject({ revision: 9, profile_epoch: "epoch", settings: { mode: "full", useSavedChats: true } });
  });
  it.each(["unavailable", "rejected", "invalid_response"])("does not save a partial connection when provisioning is %s", async failure => {
    mocks.requestChatGptWebRuntimeAdmin.mockImplementation(async (path, init) => {
      if (failure === "unavailable") throw new Error("operator secret must not leak");
      if (init?.method !== "POST") return Response.json({ profiles: [] });
      return failure === "rejected" ? Response.json({ error: { code: "runtime_draining" } }, { status: 503 }) : Response.json({ profileId: "wrong" });
    });
    const response = await POST(request({ provider: "chatgpt-web", name: "Failure" }));
    expect(response.status).toBe(502);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("operator secret");
  });
  it("rejects a duplicate connection name before allocating a runtime profile", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "existing", name: "Personal" }]);
    const response = await POST(request({ provider: "chatgpt-web", name: "Personal" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: "existing" });
    expect(mocks.requestChatGptWebRuntimeAdmin).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
  it.each([{}, { profileId: "personal" }])("requires strict runtime dashboard authorization before provisioning %j", async selector => {
    mocks.authorizeChatGptWebRuntimeAdmin.mockResolvedValue(false);
    const response = await POST(request({ provider: "chatgpt-web", name: "Unauthorized", ...selector }));
    expect(response.status).toBe(401);
    expect(mocks.authorizeChatGptWebRuntimeAdmin).toHaveBeenCalledOnce();
    expect(mocks.requestChatGptWebRuntimeAdmin).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
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
    const response = await PUT(request({ profileId: "other", testStatus: "ready" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { providerSpecificData: { profileId: "other" } } });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", { providerSpecificData: { profileId: "other" }, testStatus: "login_required" });
    expect(mocks.requestChatGptWebRuntimeAdmin).toHaveBeenCalledWith("/admin/profiles", expect.objectContaining({ method: "POST", body: JSON.stringify({ profileId: "other" }) }), expect.anything());
  });
  it("requires strict runtime admin authentication before changing profiles", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", testStatus: "ready", providerSpecificData: { profileId: "personal" } });
    mocks.authorizeChatGptWebRuntimeAdmin.mockResolvedValue(false);
    const response = await PUT(request({ profileId: "other" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(401);
    expect(mocks.requestChatGptWebRuntimeAdmin).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
  it("leaves the old connection unchanged when the replacement profile cannot be provisioned", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal" } });
    mocks.requestChatGptWebRuntimeAdmin.mockRejectedValue(new Error("unavailable"));
    const response = await PUT(request({ profileId: "other" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(502);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.invalidateChatGptWebCatalog).not.toHaveBeenCalled();
  });
  it("does not mutate an existing replacement profile's settings or epoch", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal" } });
    mocks.requestChatGptWebRuntimeAdmin.mockResolvedValue(Response.json({ profiles: [{ profileId: "other", settings: { mode: "full" }, profile_epoch: "preserved", revision: 12 }] }));
    const response = await PUT(request({ profileId: "other" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(200);
    expect(mocks.requestChatGptWebRuntimeAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.requestChatGptWebRuntimeAdmin.mock.calls[0][1]).not.toHaveProperty("method", "POST");
  });
  it.each(["ready", "login_required"])("preserves same-profile %s status and does not unnecessarily provision or require runtime admin", async testStatus => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", testStatus, providerSpecificData: { profileId: "personal" } });
    mocks.authorizeChatGptWebRuntimeAdmin.mockResolvedValue(false);
    const response = await PUT(request({ name: "Renamed", profileId: "personal", testStatus: testStatus === "ready" ? "login_required" : "ready" }, "PUT"), { params: Promise.resolve({ id: "one" }) });
    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", { name: "Renamed", providerSpecificData: { profileId: "personal" } });
    expect(mocks.authorizeChatGptWebRuntimeAdmin).not.toHaveBeenCalled();
    expect(mocks.requestChatGptWebRuntimeAdmin).not.toHaveBeenCalled();
  });
  it("rejects credentials on update before persistence", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal" } });
    expect((await PUT(request({ cookie: "secret" }, "PUT"), { params: Promise.resolve({ id: "one" }) })).status).toBe(400);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
