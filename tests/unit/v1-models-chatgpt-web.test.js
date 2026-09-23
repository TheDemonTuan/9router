import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => [
    { id: "bridge-1", provider: "chatgpt-web", isActive: true },
  ]),
  getChatGptWebCatalog: vi.fn(async () => ({
    stale: false,
    models: [{
      id: "chatgpt-web/high",
      name: "ChatGPT Web High",
      capabilities: { native_responses: true, reasoning: true, tools: true },
    }],
  })),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));
vi.mock("open-sse/services/chatgptWebBridge.js", () => ({
  getChatGptWebCatalog: mocks.getChatGptWebCatalog,
  chatGptWebModelSupportsNativeResponses: (model) => model?.capabilities?.native_responses === true,
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models ChatGPT Web namespace", () => {
  it("advertises cgw/chatgpt-web/*, matching the native request route", async () => {
    const models = await buildModelsList(["llm"]);
    const bridgeModels = models.filter((model) => model.owned_by === "cgw");

    expect(bridgeModels.map((model) => model.id)).toContain("cgw/chatgpt-web/high");
    expect(bridgeModels.map((model) => model.id)).not.toContain("cgw/high");
  });

  it("advertises generic-only live models", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/generic", capabilities: { generic_responses: true } }],
    });

    const models = await buildModelsList(["llm"]);

    expect(models.map((model) => model.id)).toContain("cgw/chatgpt-web/generic");
  });

  it("merges fresh capability evidence across active bridge connections", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "bridge-1", provider: "chatgpt-web", isActive: true },
      { id: "bridge-2", provider: "chatgpt-web", isActive: true },
    ]);
    mocks.getChatGptWebCatalog
      .mockResolvedValueOnce({
        stale: false,
        models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true, reasoning: true } }],
      })
      .mockResolvedValueOnce({
        stale: false,
        models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true, tools: true, vision: true } }],
      });

    const models = await buildModelsList(["llm"]);
    const model = models.find((entry) => entry.id === "cgw/chatgpt-web/high");

    expect(model?.capabilities).toEqual({ tools: true });
    expect(model?.input_modalities).toEqual(["text", "image"]);
  });
});
