import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnections = [];
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => mockConnections),
  updateProviderConnection: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));

const mockResolveAntigravityModels = vi.fn();
vi.mock("open-sse/services/antigravityModels.js", () => ({
  resolveAntigravityModels: (...args) => mockResolveAntigravityModels(...args),
  isAntigravityModelAvailable: (models, id) => (models || []).some((m) => m?.id === id),
}));

describe("Antigravity account selection eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnections.length = 0;
  });

  it("selects only the account whose live catalog contains Claude 5.5", async () => {
    mockConnections.push(
      { id: "conn-a", provider: "antigravity", isActive: true, accessToken: "token-a" },
      { id: "conn-b", provider: "antigravity", isActive: true, accessToken: "token-b" }
    );

    mockResolveAntigravityModels.mockImplementation(async (connection) => {
      if (connection.id === "conn-a") {
        return { resolved: true, models: [{ id: "claude-sonnet-4-6" }] };
      }
      if (connection.id === "conn-b") {
        return { resolved: true, models: [{ id: "claude-sonnet-5-5" }] };
      }
      return null;
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const creds = await getProviderCredentials("antigravity", null, "claude-sonnet-5-5");

    expect(creds).toBeDefined();
    expect(creds.connectionId).toBe("conn-b");
  });

  it("returns null when no account has entitlement for Claude 5.5", async () => {
    mockConnections.push(
      { id: "conn-a", provider: "antigravity", isActive: true, accessToken: "token-a" }
    );

    mockResolveAntigravityModels.mockResolvedValue({
      resolved: true,
      models: [{ id: "claude-sonnet-4-6" }],
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const creds = await getProviderCredentials("antigravity", null, "claude-sonnet-5-5");

    expect(creds).toBeNull();
  });
});
