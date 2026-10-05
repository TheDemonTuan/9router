import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetProviderConnectionById = vi.fn();
vi.mock("@/models", () => ({
  getProviderConnectionById: (...args) => mockGetProviderConnectionById(...args),
}));

const mockResolveAntigravityModels = vi.fn();
vi.mock("open-sse/services/antigravityModels.js", () => ({
  resolveAntigravityModels: (...args) => mockResolveAntigravityModels(...args),
}));

describe("GET /api/providers/[id]/models for Antigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns live models when discovery succeeds, including Claude 5.5", async () => {
    mockGetProviderConnectionById.mockResolvedValue({
      id: "ag-conn-1",
      provider: "antigravity",
      accessToken: "token-1",
    });
    mockResolveAntigravityModels.mockResolvedValue({
      resolved: true,
      models: [
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
        { id: "claude-opus-5-5-thinking", name: "Claude Opus 5.5 (Thinking)" },
      ],
      source: "live",
      fetchedAt: 12345678,
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const request = new Request("http://localhost:20127/api/providers/ag-conn-1/models");
    const response = await GET(request, { params: Promise.resolve({ id: "ag-conn-1" }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.resolved).toBe(true);
    expect(data.models).toEqual([
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-opus-5-5-thinking", name: "Claude Opus 5.5 (Thinking)" },
    ]);
  });

  it("falls back to legacy static models on discovery failure with a warning", async () => {
    mockGetProviderConnectionById.mockResolvedValue({
      id: "ag-conn-1",
      provider: "antigravity",
      accessToken: "token-1",
    });
    mockResolveAntigravityModels.mockResolvedValue(null);

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const request = new Request("http://localhost:20127/api/providers/ag-conn-1/models");
    const response = await GET(request, { params: Promise.resolve({ id: "ag-conn-1" }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.resolved).toBe(false);
    expect(data.warning).toContain("Antigravity live model catalog unavailable");
    expect(data.models.map((m) => m.id)).not.toContain("claude-sonnet-5-5");
  });
});
