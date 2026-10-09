import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ connections: [], catalogs: new Map(), nativeRuntime: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => fixture.connections),
  updateProviderConnection: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", async importOriginal => ({
  ...await importOriginal(),
  getChatGptWebCatalog: vi.fn(async connection => fixture.catalogs.get(connection.id)),
  prepareChatGptWebProfile: vi.fn(async connection => fixture.catalogs.get(connection.id)),
  requestChatGptWebRuntime: fixture.nativeRuntime,
}));
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { prepareChatGptWebProfile, getChatGptWebCatalog } = await import("../../open-sse/services/chatgptWebRuntimeClient.js");
const model = "chatgpt-web/gpt-5.6-sol";
beforeEach(() => {
  vi.clearAllMocks(); fixture.connections.length = 0; fixture.catalogs.clear();
  for (const [id, capabilities] of [
    ["native-only", { text: true, tools: true, native_responses: true, generic_responses: false, generic_tools: false }],
    ["browser-only", { text: true, tools: false, native_responses: true, generic_responses: true, generic_tools: false }],
    ["generic-full", { text: true, tools: true, native_responses: true, generic_responses: true, generic_tools: true }],
  ]) {
    fixture.connections.push({ id, provider: "chatgpt-web", authType: "bridge", isActive: true, priority: fixture.connections.length + 1, providerSpecificData: { profileId: id } });
    fixture.catalogs.set(id, { profileId: id, profileEpoch: `epoch-${id}`, stale: false,
      models: [{ id: model, supported_reasoning_levels: ["high"], default_reasoning_level: "high", capabilities }] });
  }
});
it("generic tools skip native-only and text-only accounts without minting native authority", async () => {
  const selected = await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", requiredCapabilities: new Set(["tools"]), chatGptWebReasoning: "high" });
  expect(selected).toMatchObject({ connectionId: "generic-full", chatGptWebRequestMode: "agent", chatGptWebProfileEpoch: "epoch-generic-full" });
  expect(selected).not.toHaveProperty("chatGptWebAuthority");
  expect(fixture.nativeRuntime).not.toHaveBeenCalled();
});
it("missing generic handoff does not fall back to a native-only Full account", async () => {
  fixture.catalogs.get("generic-full").models[0].capabilities.generic_tools = false;
  expect(await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", requiredCapabilities: new Set(["tools"]) })).toBeNull();
  expect(fixture.nativeRuntime).not.toHaveBeenCalled();
});
it("explicit native-only account pin fails instead of selecting another generic account", async () => {
  expect(await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", requiredCapabilities: new Set(["tools"]), pinConnectionId: "native-only" })).toMatchObject({ pinnedConnectionUnavailable: true, connectionId: "native-only" });
});
it("ordinary text still selects the verified browser-only route", async () => {
  const selected = await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_responses" });
  expect(selected).toMatchObject({ connectionId: "browser-only", chatGptWebRequestMode: "browser" });
  expect(fixture.nativeRuntime).not.toHaveBeenCalled();
});
it("prepares only the selected eligible profile and stops before other accounts", async () => {
  const selected = await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", preferredConnectionId: "generic-full" });
  expect(selected.connectionId).toBe("generic-full");
  expect(prepareChatGptWebProfile).toHaveBeenCalledTimes(1);
  expect(prepareChatGptWebProfile.mock.calls[0][0].id).toBe("generic-full");
  expect(getChatGptWebCatalog).not.toHaveBeenCalled();
});
it("prepares candidates serially, retaining explicit pin and caller cancellation", async () => {
  const controller = new AbortController();
  let active = 0, peak = 0;
  prepareChatGptWebProfile.mockImplementation(async connection => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--;
    return fixture.catalogs.get(connection.id);
  });
  await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", signal: controller.signal });
  expect(peak).toBe(1);
  expect(prepareChatGptWebProfile.mock.calls.map(([connection]) => connection.id)).toEqual(["native-only", "browser-only", "generic-full"]);
  for (const [, options] of prepareChatGptWebProfile.mock.calls) expect(options.signal).toBe(controller.signal);
  prepareChatGptWebProfile.mockClear();
  await getProviderCredentials("chatgpt-web", null, model, { bridgeCapability: "generic_tools", pinConnectionId: "native-only" });
  expect(prepareChatGptWebProfile.mock.calls.map(([connection]) => connection.id)).toEqual(["native-only"]);
});
it("does not rotate after admission failure or swallow caller abort", async () => {
  const denied = Response.json({ error: { code: "runtime_capacity_exceeded" } }, { status: 503 });
  prepareChatGptWebProfile.mockRejectedValueOnce(Object.assign(new Error("busy"), { response: denied }));
  expect((await getProviderCredentials("chatgpt-web", null, model)).chatGptWebBindingError).toBe(denied);
  expect(prepareChatGptWebProfile).toHaveBeenCalledTimes(1);
  prepareChatGptWebProfile.mockClear();
  const controller = new AbortController(); controller.abort();
  await expect(getProviderCredentials("chatgpt-web", null, model, { signal: controller.signal })).rejects.toThrow();
  expect(prepareChatGptWebProfile).not.toHaveBeenCalled();
});
it("resolves native retained ownership before preparing only its bound profile", async () => {
  fixture.nativeRuntime.mockResolvedValueOnce(Response.json({ profileId: "generic-full", profileEpoch: "epoch-generic-full" }));
  const selected = await getProviderCredentials("chatgpt-web", null, model, { chatGptWebAuthority: { clientId: "client", threadId: "thread", turnId: "turn" } });
  expect(selected.connectionId).toBe("generic-full");
  expect(prepareChatGptWebProfile).toHaveBeenCalledTimes(1);
  expect(prepareChatGptWebProfile.mock.calls[0][0]).toMatchObject({ id: "generic-full", chatGptWebProfileEpoch: "epoch-generic-full" });
  expect(fixture.nativeRuntime.mock.invocationCallOrder[0]).toBeLessThan(prepareChatGptWebProfile.mock.invocationCallOrder[0]);
});
