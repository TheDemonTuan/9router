import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
  invalidateUsageCache: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  consumeClaudeResetGrant: mocks.consumeClaudeResetGrant,
  invalidateUsageCache: mocks.invalidateUsageCache,
}));

describe("Claude reset route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("POST resets connection health state and clears cache when grant is consumed", async () => {
    const connection = {
      id: "claude_1",
      provider: "claude",
      authType: "oauth",
      accessToken: "token-1",
      providerSpecificData: {},
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection });
    mocks.consumeClaudeResetGrant.mockResolvedValue({ ok: true, result: "success" });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const response = await POST(
      new Request("http://localhost/api/usage/claude_1/claude-reset", {
        method: "POST",
        body: JSON.stringify({ grantId: "grant_1" }),
      }),
      { params: Promise.resolve({ connectionId: "claude_1" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: "success" });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("claude_1", { testStatus: "active" });
    expect(mocks.invalidateUsageCache).toHaveBeenCalledWith("claude_1");
  });

  it("POST does not reactivate connection when consume fails", async () => {
    const connection = {
      id: "claude_1",
      provider: "claude",
      authType: "oauth",
      accessToken: "token-1",
      providerSpecificData: {},
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection });
    mocks.consumeClaudeResetGrant.mockResolvedValue({ ok: false, status: 409, message: "No grants" });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/claude-reset/route.js");
    const response = await POST(
      new Request("http://localhost/api/usage/claude_1/claude-reset", {
        method: "POST",
        body: JSON.stringify({ grantId: "grant_1" }),
      }),
      { params: Promise.resolve({ connectionId: "claude_1" }) }
    );

    expect(response.status).toBe(409);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.invalidateUsageCache).not.toHaveBeenCalled();
  });
});
