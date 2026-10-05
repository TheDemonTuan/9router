import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog, runtimeHealth } from "./chatgpt-web-fixtures.js";
const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn(), resolveConnectionProxyConfig: vi.fn(), testProxyUrl: vi.fn(), getChatGptWebHealth: vi.fn(), getChatGptWebCatalog: vi.fn(), requestChatGptWebRuntime: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.getProviderConnectionById, updateProviderConnection: mocks.updateProviderConnection }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ getChatGptWebHealth: mocks.getChatGptWebHealth, getChatGptWebCatalog: mocks.getChatGptWebCatalog, requestChatGptWebRuntime: mocks.requestChatGptWebRuntime, requestChatGptWebRuntimeAdmin: mocks.admin }));
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const saved = () => ({ id: "one", provider: "chatgpt-web", authType: "bridge", providerSpecificData: { profileId: "personal" }, updatedAt: "2026-01-01T00:00:00.000Z", testStatus: "login_required", modelLock_any: "2099-01-01T00:00:00.000Z" });
const profile = (overrides = {}) => ({ profileId: "personal", state: "ready", settings: { mode: "browser-only" }, models: [webModel()], lastError: null, ...overrides });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue(saved());
  mocks.updateProviderConnection.mockImplementation(async (id, updater) => ({ ...saved(), ...updater(saved()) }));
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getChatGptWebHealth.mockResolvedValue(runtimeHealth);
  mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog());
  mocks.admin.mockImplementation(async () => Response.json({ protocolVersion: 1, profiles: [profile()] }));
});
describe("runtime connection test", () => {
  it("marks a ready profile active and retains exact catalog metadata with zero inference or session probes", async () => {
    expect(await testSingleConnection("one")).toMatchObject({ valid: true, stale: false, models: [webModel()] });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("one", expect.any(Function), { resetHealth: false });
    const patch = mocks.updateProviderConnection.mock.calls[0][1](saved());
    expect(patch).toEqual({ testStatus: "active", lastError: null, lastErrorAt: null });
    expect(patch).not.toHaveProperty("modelLock_any");
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith("/admin/profiles", { signal: undefined }, { timeoutMs: 3000 });
    expect(mocks.requestChatGptWebRuntime).not.toHaveBeenCalled();
    expect(mocks.testProxyUrl).not.toHaveBeenCalled();
  });
  it("does not let a different unready profile invalidate the selected ready profile", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ protocolVersion: 1, profiles: [profile(), profile({ profileId: "other", state: "login_required", models: [] })] }));
    expect(await testSingleConnection("one")).toMatchObject({ valid: true });
  });
  it("persists actionable login_required rather than a generic error and never sends or probes", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ protocolVersion: 1, profiles: [profile({ state: "login_required", models: [] })] }));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, code: "login_required", models: [] });
    expect(mocks.updateProviderConnection.mock.calls[0][1](saved())).toMatchObject({ testStatus: "login_required" });
    expect(mocks.getChatGptWebCatalog).not.toHaveBeenCalled();
    expect(mocks.requestChatGptWebRuntime).not.toHaveBeenCalled();
  });
  it("rejects stale or missing model evidence without returning stale rows", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, code: "model_version_unavailable", stale: true, models: [] });
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ capabilities: { reasoning: true } })]));
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, code: "model_version_unavailable", stale: false, models: [] });
  });
  it("maps an offline runtime to safe unavailability, not login expiration or raw transport errors", async () => {
    mocks.admin.mockRejectedValue(new Error("Bearer private-token /operator/private/path"));
    const result = await testSingleConnection("one");
    expect(result).toMatchObject({ valid: false, code: "runtime_unavailable", error: "Runtime unavailable. Refresh connections after the runtime recovers." });
    expect(JSON.stringify(result)).not.toMatch(/private-token|operator\/private/);
  });
  it("keeps draining distinct from ready and preserves quota locks", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ ...runtimeHealth, draining: true });
    expect(await testSingleConnection("one")).toMatchObject({ valid: false, code: "runtime_draining", models: [] });
    expect(mocks.updateProviderConnection.mock.calls[0][1](saved())).toMatchObject({ testStatus: "draining" });
  });
  it("skips saving a readiness result if the selector or updatedAt changed during the read", async () => {
    await testSingleConnection("one");
    const updater = mocks.updateProviderConnection.mock.calls[0][1];
    expect(updater({ ...saved(), providerSpecificData: { profileId: "other" } })).toBeNull();
    expect(updater({ ...saved(), updatedAt: "newer" })).toBeNull();
    expect(updater(null)).toBeNull();
  });
});
