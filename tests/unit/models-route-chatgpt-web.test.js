import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog } from "./chatgpt-web-fixtures.js";

const mocks = vi.hoisted(() => ({ getModelAliases: vi.fn(), getDisabledModels: vi.fn(), getCustomModels: vi.fn(), getProviderConnections: vi.fn(), getChatGptWebCatalog: vi.fn() }));
vi.mock("@/models", () => ({ getModelAliases: mocks.getModelAliases, getCustomModels: mocks.getCustomModels, getProviderConnections: mocks.getProviderConnections }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ getChatGptWebCatalog: mocks.getChatGptWebCatalog }));
const { GET } = await import("../../src/app/api/models/route.js");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getProviderConnections.mockImplementation(async ({ provider }) => provider === "chatgpt-web" ? [{ id: "one", provider, isActive: true }] : []);
});
const publicModels = async () => (await (await GET()).json()).models.filter(model => model.provider === "chatgpt-web");

describe("GET /api/models runtime evidence", () => {
  it("preserves dotted model IDs, reasoning, family and verified budgets", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog());
    expect(await publicModels()).toEqual([expect.objectContaining({
      model: "chatgpt-web/gpt-5.6-sol", fullModel: "chatgpt-web/gpt-5.6-sol", routedModel: "cgw/chatgpt-web/gpt-5.6-sol",
      supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "medium", model_family: "5.6", legacy: false,
      context_window: 128000, auto_compact_token_limit: 100000, max_output: 16000,
      capabilities: expect.objectContaining({ native_responses: true, tools: false }),
    })]);
  });
  it("unions discoverable efforts and capabilities but uses minimum budgets", async () => {
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => provider === "chatgpt-web" ? [{ id: "one", provider }, { id: "two", provider }] : []);
    mocks.getChatGptWebCatalog.mockResolvedValueOnce(webCatalog()).mockResolvedValueOnce(webCatalog([webModel({
      supported_reasoning_levels: ["high", "xhigh"], default_reasoning_level: "high", context_window: 96000, auto_compact_token_limit: 80000, max_output: 8000,
      capabilities: { native_responses: true, tools: true },
    })]));
    expect(await publicModels()).toEqual([expect.objectContaining({ supported_reasoning_levels: ["medium", "high", "xhigh"], context_window: 96000, auto_compact_token_limit: 80000, max_output: 8000, caps: expect.objectContaining({ reasoning: true, tools: true }) })]);
  });
  it("does not advertise stale, legacy, ultra or unsupported rows", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ legacy: true }), webModel({ supported_reasoning_levels: ["ultra"] }), webModel({ capabilities: { reasoning: true } })]));
    expect(await publicModels()).toEqual([]);
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await publicModels()).toEqual([]);
  });
  it("does not invent a max output budget missing from one profile", async () => {
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => provider === "chatgpt-web" ? [{ id: "one", provider }, { id: "two", provider }] : []);
    mocks.getChatGptWebCatalog.mockResolvedValueOnce(webCatalog()).mockResolvedValueOnce(webCatalog([webModel({ max_output: undefined })]));
    expect((await publicModels())[0]).not.toHaveProperty("max_output");
  });
});
