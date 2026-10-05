import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  persistAntigravityQuota: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  persistAntigravityQuota: mocks.persistAntigravityQuota,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    getAuthType: () => "oauth",
    needsRefresh: () => false,
  })),
}));

describe("Usage API GET self-healing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("unlocks Codex connection when upstream reports limitReached is false and weekly quota remains", async () => {
    const connection = {
      id: "codex_locked",
      provider: "codex",
      authType: "oauth",
      accessToken: "token_123",
      testStatus: "unavailable",
      errorCode: 429,
      unavailabilityReason: "quota_exhausted",
      "modelLock_gpt-5.3-codex": "2026-10-12T00:00:00.000Z",
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue({
      plan: "plus",
      limitReached: false,
      quotas: {
        session: { remaining: 100 },
        weekly: { remaining: 80 },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/codex_locked?force=1"),
      { params: Promise.resolve({ connectionId: "codex_locked" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("codex_locked", { testStatus: "active" });
  });

  it("does not unlock Codex connection when upstream reports limitReached is true", async () => {
    const connection = {
      id: "codex_locked",
      provider: "codex",
      authType: "oauth",
      accessToken: "token_123",
      testStatus: "unavailable",
      errorCode: 429,
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue({
      plan: "plus",
      limitReached: true,
      quotas: {
        weekly: { remaining: 0 },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/codex_locked?force=1"),
      { params: Promise.resolve({ connectionId: "codex_locked" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not unlock Codex connection when weekly quota has 0 remaining", async () => {
    const connection = {
      id: "codex_locked",
      provider: "codex",
      authType: "oauth",
      accessToken: "token_123",
      testStatus: "unavailable",
      errorCode: 429,
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue({
      plan: "plus",
      limitReached: false,
      quotas: {
        session: { remaining: 50 },
        weekly: { remaining: 0 },
      },
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/codex_locked?force=1"),
      { params: Promise.resolve({ connectionId: "codex_locked" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
