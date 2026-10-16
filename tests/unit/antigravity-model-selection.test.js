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

  it("selects B with exact Argon even when Flash-only A has higher priority", async () => {
    mockConnections.push(
      { id: "conn-a", provider: "antigravity", priority: 1, isActive: true, accessToken: "token-a" },
      { id: "conn-b", provider: "antigravity", priority: 2, isActive: true, accessToken: "token-b" },
    );
    mockResolveAntigravityModels.mockImplementation(async connection => ({ resolved: true, models: [
      { id: "gemini-3.8-flash-high" }, ...(connection.id === "conn-b" ? [{ id: "gemini-4-argon-high" }] : []),
    ] }));
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    expect((await getProviderCredentials("antigravity", null, "gemini-4-argon-high")).connectionId).toBe("conn-b");
  });

  it("does not revive static Argon when the resolved catalog is empty", async () => {
    mockConnections.push({ id: "conn-empty", provider: "antigravity", isActive: true, accessToken: "token" });
    mockResolveAntigravityModels.mockResolvedValue({ resolved: true, models: [] });
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    expect(await getProviderCredentials("antigravity", null, "gemini-4-argon-high")).toBeNull();
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
