import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(),
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as getModelById } from "@/app/api/v1/models/[...model]/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";

function params(model) {
  return { params: Promise.resolve({ model }) };
}

describe("Claude /v1/models and thinking/reasoning levels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.getProviderConnections.mockResolvedValue([]);
  });

  it("advertises supported_reasoning_levels and default_reasoning_level for Claude Opus 5.5 without active connection", async () => {
    const models = await buildModelsList(["llm"]);
    const opus55 = models.find((m) => m.id === "cc/claude-opus-5-5");
    expect(opus55).toBeDefined();
    expect(opus55.name).toBe("Claude Opus 5.5");
    expect(opus55.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(opus55.default_reasoning_level).toBe("high");
    expect(opus55.context_length).toBe(1_000_000);
    expect(opus55.max_completion_tokens).toBe(128_000);
    // Opus 5.5 cannot disable thinking -> no "none" level
    expect(opus55.supported_reasoning_levels).not.toContain("none");
  });

  it("advertises switchable reasoning levels for Opus 5, Sonnet 5.5, and Sonnet 5", async () => {
    const models = await buildModelsList(["llm"]);
    for (const id of ["cc/claude-opus-5", "cc/claude-sonnet-5-5", "cc/claude-sonnet-5"]) {
      const model = models.find((m) => m.id === id);
      expect(model).toBeDefined();
      expect(model.supported_reasoning_levels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(model.default_reasoning_level).toBe("high");
    }
  });

  it("preserves reasoning levels when active connection exists", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "cc-1", provider: "claude", isActive: true, apiKey: "sk-ant-test" },
    ]);
    const models = await buildModelsList(["llm"]);
    const opus55 = models.find((m) => m.id === "cc/claude-opus-5-5");
    expect(opus55).toBeDefined();
    expect(opus55.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(opus55.default_reasoning_level).toBe("high");
  });

  it("serves reasoning levels from GET /v1/models/{provider}/{model}", async () => {
    const res = await getModelById(
      new Request("https://router.test/v1/models/cc/claude-opus-5-5"),
      params(["cc", "claude-opus-5-5"]),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("cc/claude-opus-5-5");
    expect(data.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(data.default_reasoning_level).toBe("high");
  });

  it("serves reasoning levels from GET /v1/models/info?id=cc/claude-opus-5-5", async () => {
    const req = new Request("https://router.test/v1/models/info?id=cc/claude-opus-5-5");
    const res = await getModelInfo(req);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.id).toBe("cc/claude-opus-5-5");
    expect(info.supportedReasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(info.defaultReasoningLevel).toBe("high");
  });
});
