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

  it("retains second account models when first account has a restrictive enabledModels list", async () => {
    mockGetProviderConnections.mockResolvedValue([
      {
        id: "ag-a",
        provider: "antigravity",
        isActive: true,
        accessToken: "token-a",
        providerSpecificData: {
          enabledModels: ["gemini-2.5-pro"],
        },
      },
      {
        id: "ag-b",
        provider: "antigravity",
        isActive: true,
        accessToken: "token-b",
        providerSpecificData: {
          enabledModels: ["claude-sonnet-5-5"],
        },
      },
    ]);

    mockResolveAntigravityModels.mockImplementation(async (connection) => {
      if (connection.id === "ag-a") {
        return {
          resolved: true,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
        };
      }
      if (connection.id === "ag-b") {
        return {
          resolved: true,
          models: [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }],
        };
      }
      return null;
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://localhost:20127/v1/models"));
    expect(response.status).toBe(200);
    const data = await response.json();

    const gemini = data.data.find((m) => m.id === "ag/gemini-2.5-pro");
    const sonnet = data.data.find((m) => m.id === "ag/claude-sonnet-5-5");
    expect(gemini).toBeDefined();
    expect(sonnet).toBeDefined();
  });

  it("does not mix static models into union when one account succeeds and one fails", async () => {
    mockGetProviderConnections.mockResolvedValue([
      { id: "ag-success", provider: "antigravity", isActive: true, accessToken: "token-s" },
      { id: "ag-fail", provider: "antigravity", isActive: true, accessToken: "token-f" },
    ]);

    mockResolveAntigravityModels.mockImplementation(async (connection) => {
      if (connection.id === "ag-success") {
        return {
          resolved: true,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
        };
      }
      return null; // failed connection
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://localhost:20127/v1/models"));
    expect(response.status).toBe(200);
    const data = await response.json();

    const agModels = data.data.filter((m) => m.id.startsWith("ag/"));
    expect(agModels.map((m) => m.id)).toEqual(["ag/gemini-2.5-pro"]);
    // Static models like claude-sonnet-4-6 must NOT be present
    expect(agModels.some((m) => m.id.includes("claude-sonnet-4-6"))).toBe(false);
  });
});
