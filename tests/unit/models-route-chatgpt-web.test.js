import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getCustomModels: vi.fn(),
  getProviderConnections: vi.fn(),
  getChatGptWebCatalog: vi.fn(),
}));

vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases,
  getDisabledModels: mocks.getDisabledModels,
  getCustomModels: mocks.getCustomModels,
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));
vi.mock("open-sse/services/chatgptWebBridge.js", () => ({
  getChatGptWebCatalog: mocks.getChatGptWebCatalog,
  chatGptWebModelSupportsNativeResponses: (model) => model?.capabilities?.native_responses === true,
}));

const { GET } = await import("../../src/app/api/models/route.js");

describe("GET /api/models ChatGPT Web catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getProviderConnections.mockResolvedValue([{ id: "bridge-1", provider: "chatgpt-web", isActive: true }]);
  });

  it("keeps the canonical chatgpt-web model namespace without duplicating its prefix", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", name: "High", capabilities: { native_responses: true, reasoning: true, tools: true } }],
    });

    const response = await GET();
    const model = (await response.json()).models.find((entry) => entry.provider === "chatgpt-web");

    expect(model).toMatchObject({
      model: "chatgpt-web/high",
      fullModel: "chatgpt-web/high",
      routedModel: "cgw/chatgpt-web/high",
      caps: { reasoning: true, tools: true },
    });
  });

  it("keeps capability evidence available when another active bridge reports it", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "bridge-1", provider: "chatgpt-web", isActive: true },
      { id: "bridge-2", provider: "chatgpt-web", isActive: true },
    ]);
    mocks.getChatGptWebCatalog
      .mockResolvedValueOnce({ stale: false, models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true, reasoning: true } }] })
      .mockResolvedValueOnce({ stale: false, models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true, tools: true } }] });

    const response = await GET();
    const model = (await response.json()).models.find((entry) => entry.provider === "chatgpt-web");

    expect(model.caps).toMatchObject({ reasoning: true, tools: true });
  });

  it("advertises generic-only live models", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/generic", name: "Generic", capabilities: { generic_responses: true } }],
    });

    const response = await GET();
    const model = (await response.json()).models.find((entry) => entry.model === "chatgpt-web/generic");

    expect(model).toMatchObject({ fullModel: "chatgpt-web/generic", routedModel: "cgw/chatgpt-web/generic" });
  });

  it("does not infer capability support when a live row omits capability evidence", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", name: "High" }],
    });

    const response = await GET();
    const model = (await response.json()).models.find((entry) => entry.provider === "chatgpt-web");

    expect(model).toBeUndefined();
  });
});
