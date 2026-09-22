import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  getChatGptWebHealth: vi.fn(),
  getChatGptWebCatalog: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("open-sse/services/chatgptWebBridge.js", () => ({
  chatGptWebModelSupportsNativeResponses: (model) => model?.capabilities?.native_responses === true,
  getChatGptWebHealth: mocks.getChatGptWebHealth,
  getChatGptWebCatalog: mocks.getChatGptWebCatalog,
}));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

const connection = {
  id: "bridge-1",
  provider: "chatgpt-web",
  authType: "bridge",
  providerSpecificData: { bridgeId: "personal" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue(connection);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("ChatGPT Web connection test", () => {
  it("rejects stale catalogs and only reports usable native models", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: true,
      models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
    });

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: false, stale: true, models: [] });
    expect(result.error).toBe("Bridge catalog is stale");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("bridge-1", expect.objectContaining({
      testStatus: "error",
      lastError: "Bridge catalog is stale",
    }));
  });

  it("accepts a fresh catalog with generic-only model evidence", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/generic", capabilities: { generic_responses: true } }],
    });

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: true, stale: false, models: [{ id: "chatgpt-web/generic" }] });
  });

  it("rejects a fresh catalog without native or generic model evidence", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { reasoning: true } }],
    });

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: false, stale: false, models: [] });
    expect(result.error).toBe("Bridge has no usable models");
  });
});
