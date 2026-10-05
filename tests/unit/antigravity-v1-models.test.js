import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetProviderConnections = vi.fn();
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...args) => mockGetProviderConnections(...args),
  getCombos: vi.fn().mockResolvedValue([]),
  getCustomModels: vi.fn().mockResolvedValue([]),
  getModelAliases: vi.fn().mockResolvedValue({}),
}));

const mockResolveAntigravityModels = vi.fn();
vi.mock("open-sse/services/antigravityModels.js", () => ({
  resolveAntigravityModels: (...args) => mockResolveAntigravityModels(...args),
}));

describe("GET /v1/models for Antigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advertises live Claude 5.5 when account provides it", async () => {
    mockGetProviderConnections.mockResolvedValue([
      { id: "ag-1", provider: "antigravity", isActive: true, accessToken: "token-1" },
    ]);
    mockResolveAntigravityModels.mockResolvedValue({
      resolved: true,
      models: [
        {
          id: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          contextLength: 200000,
          maxOutputTokens: 64000,
          capabilities: { vision: true, reasoning: true },
        },
      ],
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://localhost:20127/v1/models"));
    expect(response.status).toBe(200);
    const data = await response.json();
    const sonnet = data.data.find((m) => m.id === "ag/claude-sonnet-5-5");
    expect(sonnet).toBeDefined();
    expect(sonnet.context_length).toBe(200000);
    expect(sonnet.max_completion_tokens).toBe(64000);
    expect(sonnet.input_modalities).toEqual(["text", "image"]);
  });

  it("authoritative empty removes static chat models and does not invent 5.5", async () => {
    mockGetProviderConnections.mockResolvedValue([
      { id: "ag-1", provider: "antigravity", isActive: true, accessToken: "token-1" },
    ]);
    mockResolveAntigravityModels.mockResolvedValue({
      resolved: true,
      models: [],
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://localhost:20127/v1/models"));
    expect(response.status).toBe(200);
    const data = await response.json();
    const agModels = data.data.filter((m) => m.id.startsWith("ag/"));
    expect(agModels).toEqual([]);
  });
});
