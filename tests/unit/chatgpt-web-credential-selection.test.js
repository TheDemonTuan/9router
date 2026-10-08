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
  requestChatGptWebRuntime: fixture.nativeRuntime,
}));
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
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
