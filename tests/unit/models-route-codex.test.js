import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getCustomModels: vi.fn(),
  getProviderConnections: vi.fn(),
  resolveCodexModels: vi.fn(),
  resolveEffectiveCodexCatalog: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases,
  setModelAlias: vi.fn(),
  getCustomModels: mocks.getCustomModels,
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("open-sse/services/codexModels.js", () => ({
  mergeCodexModelLists: (lists) => lists.flat(),
  resolveCodexModels: mocks.resolveCodexModels,
  resolveEffectiveCodexCatalog: mocks.resolveEffectiveCodexCatalog,
}));

const { GET } = await import("../../src/app/api/models/route.js");

describe("GET /api/models Codex catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-account-a", provider: "codex", accessToken: "token" }]
        : []
    ));
    mocks.resolveCodexModels.mockResolvedValue({
      resolved: true,
      source: "live",
      access: "observed",
      stale: false,
      models: [{
        id: "gpt-6-sol",
        name: "GPT-6-Sol",
        description: "Sol",
        contextLength: 272000,
        maxOutputTokens: 128000,
        supportedReasoningLevels: ["low", "ultra"],
        capabilities: { reasoning: true, vision: true, contextWindow: 272000, maxOutput: 128000 },
      }],
    });
    mocks.resolveEffectiveCodexCatalog.mockResolvedValue({
      resolved: true,
      source: "effective",
      access: "observed",
      stale: false,
      models: [{
        id: "gpt-6-sol",
        name: "GPT-6-Sol",
        description: "Sol",
        contextLength: 272000,
        maxOutputTokens: 128000,
        supportedReasoningLevels: ["low", "ultra"],
        capabilities: { reasoning: true, vision: true, contextWindow: 272000, maxOutput: 128000 },
      }],
    });
  });

  it("replaces static Codex chat rows with live metadata", async () => {
    const response = await GET();
    const models = (await response.json()).models;
    const model = models.find((entry) => entry.provider === "cx" && entry.model === "gpt-6-sol");

    expect(model).toMatchObject({
      provider: "cx",
      fullModel: "cx/gpt-6-sol",
      description: "Sol",
      caps: {
        reasoning: true,
        vision: true,
        contextWindow: 272000,
        maxOutput: 128000,
        supportedReasoningLevels: ["low", "ultra"],
      },
    });
    expect(models.some((entry) => entry.provider === "cx" && entry.model === "gpt-5.5")).toBe(false);
    expect(mocks.resolveEffectiveCodexCatalog).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "codex-account-a" })],
      expect.any(Object),
    );
  });
});
