import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => [{
    id: "codex-account-a",
    provider: "codex",
    isActive: true,
    accessToken: "token",
  }]),
  resolveCodexModels: vi.fn(async () => ({
    resolved: true,
    source: "live",
    access: "observed",
    stale: false,
    models: [{
      id: "gpt-6-sol",
      name: "GPT-6-Sol",
      kind: "llm",
      description: "Sol",
      contextLength: 272000,
      maxOutputTokens: 128000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      capabilities: { reasoning: true, vision: true, tools: true, contextWindow: 272000, maxOutput: 128000 },
    }],
  })),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("open-sse/services/codexModels.js", () => ({
  resolveCodexModels: mocks.resolveCodexModels,
  mergeCodexModelLists: (lists) => lists.flat(),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models Codex live catalog", () => {
  beforeEach(() => mocks.resolveCodexModels.mockClear());

  it("uses the account catalog and exposes live reasoning metadata", async () => {
    const models = await buildModelsList(["llm"]);
    const model = models.find((entry) => entry.id === "cx/gpt-6-sol");

    expect(model).toMatchObject({
      owned_by: "cx",
      context_length: 272000,
      max_completion_tokens: 128000,
      capabilities: { reasoning: true, vision: true },
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(mocks.resolveCodexModels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex-account-a" }),
      expect.any(Object),
    );
    expect(models.some((entry) => entry.id === "cx/gpt-5.5")).toBe(false);
  });

  it("keeps static image discovery separate from the chat catalog", async () => {
    const imageModels = await buildModelsList(["image"]);
    expect(imageModels.some((entry) => entry.id === "cx/gpt-image-2.5")).toBe(true);
    expect(mocks.resolveCodexModels).not.toHaveBeenCalled();
  });
});
