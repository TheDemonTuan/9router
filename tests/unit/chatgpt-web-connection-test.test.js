import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog, runtimeHealth } from "./chatgpt-web-fixtures.js";
const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn(), resolveConnectionProxyConfig: vi.fn(), testProxyUrl: vi.fn(), getChatGptWebHealth: vi.fn(), getChatGptWebCatalog: vi.fn(), requestChatGptWebRuntime: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.getProviderConnectionById, updateProviderConnection: mocks.updateProviderConnection }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ getChatGptWebHealth: mocks.getChatGptWebHealth, getChatGptWebCatalog: mocks.getChatGptWebCatalog, requestChatGptWebRuntime: mocks.requestChatGptWebRuntime }));
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", authType: "bridge", providerSpecificData: { profileId: "personal" } });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getChatGptWebHealth.mockResolvedValue(runtimeHealth);
  mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog());
  mocks.requestChatGptWebRuntime.mockResolvedValue(new Response("{}"));
});
describe("runtime connection test", () => {
  it("marks a ready profile active and retains exact model metadata", async () => {
    expect(await testSingleConnection("one")).toMatchObject({ valid: true, stale: false, models: [webModel()] });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", expect.objectContaining({ testStatus: "active", lastError: null }));
  });
  it("does not mark an alive runtime active when the profile is unready", async () => {
    mocks.requestChatGptWebRuntime.mockResolvedValue(new Response("{}", { status: 503 }));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, error: expect.any(String) });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", expect.objectContaining({ testStatus: "error", lastError: expect.any(String) }));
  });
  it("rejects stale or missing model evidence without returning stale rows", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, stale: true, models: [] });
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ capabilities: { reasoning: true } })]));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, stale: false, models: [] });
  });
  it("persists an actionable login failure without a success fallback", async () => {
    mocks.getChatGptWebCatalog.mockRejectedValue(new Error("login_required: log in to the runtime profile"));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, error: "login_required: log in to the runtime profile" });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", expect.objectContaining({ testStatus: "error", lastError: "login_required: log in to the runtime profile" }));
  });
});
