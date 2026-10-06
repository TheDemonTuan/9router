import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog } from "./chatgpt-web-fixtures.js";
const mocks = vi.hoisted(() => ({ getProviderConnections: vi.fn(), getChatGptWebCatalog: vi.fn(), getCustomModels: vi.fn(), getModelAliases: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.getProviderConnections, getCombos: vi.fn(async () => []), getCustomModels: mocks.getCustomModels, getModelAliases: mocks.getModelAliases }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ getChatGptWebCatalog: mocks.getChatGptWebCatalog }));
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderConnections.mockResolvedValue([{ id: "one", provider: "chatgpt-web", isActive: true, providerSpecificData: { profileId: "personal" } }]);
  mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog());
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
});
const publicModels = async () => (await buildModelsList(["llm"])).filter(model => model.owned_by === "cgw");
describe("/v1/models runtime catalog", () => {
  it("retains the canonical dotted namespace and native reasoning contract", async () => {
    expect(await publicModels()).toEqual([expect.objectContaining({ id: "cgw/chatgpt-web/gpt-5.6-sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "medium", model_family: "5.6", legacy: false, context_window: 128000, context_length: 128000, auto_compact_token_limit: 100000, max_output: 16000, max_completion_tokens: 16000, capabilities: expect.objectContaining({ native_responses: true, generic_responses: false, computer_use: false }) })]);
  });
  it("unions efforts without overstating cross-profile budgets", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "one", provider: "chatgpt-web", isActive: true }, { id: "two", provider: "chatgpt-web", isActive: true }]);
    mocks.getChatGptWebCatalog.mockResolvedValueOnce(webCatalog()).mockResolvedValueOnce(webCatalog([webModel({ supported_reasoning_levels: ["high", "xhigh"], default_reasoning_level: "high", context_window: 64000, auto_compact_token_limit: 50000, max_output: 8000, capabilities: { native_responses: true, tools: true, subagents: true } })]));
    expect(await publicModels()).toEqual([expect.objectContaining({ supported_reasoning_levels: ["medium", "high", "xhigh"], context_length: 64000, auto_compact_token_limit: 50000, max_completion_tokens: 8000, capabilities: expect.objectContaining({ tools: true, subagents: true }) })]);
  });
  it("advertises client functions on a public copy without native authority", async () => {
    const catalog = webCatalog([webModel({ capabilities: { text: true, generic_responses: true, generic_tools: true, tools: false, exec: false, mcp_tools: false } })]);
    mocks.getChatGptWebCatalog.mockResolvedValue(catalog);
    expect(await publicModels()).toEqual([expect.objectContaining({ capabilities: expect.objectContaining({ tools: true, generic_tools: true, exec: false, mcp_tools: false }) })]);
    expect(catalog.models[0].capabilities.tools).toBe(false);
  });
  it("does not advertise unverified custom IDs or aliases when all probes fail", async () => {
    mocks.getChatGptWebCatalog.mockRejectedValue(new Error("login_required"));
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "cgw", id: "chatgpt-web/unverified" }]);
    mocks.getModelAliases.mockResolvedValue({ alias: "cgw/chatgpt-web/unverified" });
    expect(await publicModels()).toEqual([]);
  });
  it("excludes stale and unsupported model evidence", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ capabilities: { reasoning: true } })]));
    expect(await publicModels()).toEqual([]);
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await publicModels()).toEqual([]);
  });
});
