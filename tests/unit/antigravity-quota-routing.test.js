import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getAntigravityUsage: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(async (id, patch) => {
    const connection = mocks.connections.find(entry => entry.id === id);
    if (!connection) return null;
    const resolved = typeof patch === "function" ? patch(connection) : patch;
    if (resolved !== null) Object.assign(connection, resolved);
    return connection;
  }),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: provider => ({ ag: "antigravity", cx: "codex" }[provider] || provider),
}));
vi.mock("open-sse/services/usage/google.js", () => ({ getAntigravityUsage: mocks.getAntigravityUsage }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  persistAntigravityQuota,
  refreshAntigravityQuota,
  handleAntigravityQuotaError,
  clearAntigravityStrikes,
} = await import("@/sse/services/antigravityQuota.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const MODEL = "gemini-3.8-flash-high";
const OTHER_MODEL = "gemini-3.8-flash-medium";
const NOW = Date.parse("2026-08-26T00:00:00.000Z");
const FUTURE_RESET = "2026-09-01T00:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.connections = [];
  mocks.getSettings.mockResolvedValue({});
  mocks.getProviderConnections.mockImplementation(async ({ provider } = {}) =>
    mocks.connections.filter(connection => (!provider || connection.provider === provider) && connection.isActive !== false));
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
});

afterEach(() => vi.useRealTimers());

describe("Antigravity durable quota routing", () => {
  it("persists only exact model zero rows with future reset", async () => {
    mocks.connections = [{ id: "ag-a", provider: "antigravity", isActive: true }];
    await persistAntigravityQuota("ag-a", {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
      [OTHER_MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
      unknown: { remainingPercentage: 0, resetAt: FUTURE_RESET },
      gemini_weekly: { remainingPercentage: 0, resetAt: FUTURE_RESET },
      bad: { remainingPercentage: "0", resetAt: FUTURE_RESET },
    });

    expect(mocks.connections[0]).toMatchObject({
      [`modelLock_${MODEL}`]: FUTURE_RESET,
      [`modelLockReason_${MODEL}`]: "quota_exhausted",
      [`modelLockErrorCode_${MODEL}`]: 429,
    });
    expect(mocks.connections[0][`modelLock_${OTHER_MODEL}`]).toBeUndefined();
  });

  it("does not block another provider behind selection; aliases serialize", async () => {
    vi.useRealTimers();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mocks.connections = [{ id: "ag-a", provider: "antigravity", isActive: true }, { id: "cx-a", provider: "codex", isActive: true }];
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => {
      if (provider === "antigravity") await gate;
      return mocks.connections.filter(connection => connection.provider === provider);
    });
    const pending = getProviderCredentials("ag");
    const alias = getProviderCredentials("antigravity");
    const other = getProviderCredentials("cx");
    await expect(Promise.race([other, new Promise((_, reject) => setTimeout(() => reject(new Error("cross-provider lock")), 100))])).resolves.toMatchObject({ connectionId: "cx-a" });
    expect(mocks.getProviderConnections.mock.calls.filter(([args]) => args?.provider === "antigravity")).toHaveLength(1);
    release();
    await pending;
    await alias;
    mocks.getProviderConnections.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(getProviderCredentials("ag")).rejects.toThrow("lookup failed");
    await expect(getProviderCredentials("antigravity")).resolves.toMatchObject({ connectionId: "ag-a" });
  });

  it("selects the healthy account from persisted quota locks", async () => {
    mocks.connections = [
      {
        id: "ag-a", provider: "antigravity", email: "a@example.com", isActive: true,
        [`modelLock_${MODEL}`]: FUTURE_RESET,
        [`modelLockReason_${MODEL}`]: "quota_exhausted",
        [`modelLockErrorCode_${MODEL}`]: 429,
      },
      { id: "ag-b", provider: "antigravity", email: "b@example.com", isActive: true },
    ];

    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
      connectionId: "ag-b",
      connectionName: "b@example.com",
    });
  });

  it("returns durable quota terminal classification when every account is locked", async () => {
    mocks.connections = [{
      id: "ag-a", provider: "antigravity", isActive: true,
      [`modelLock_${MODEL}`]: FUTURE_RESET,
      [`modelLockReason_${MODEL}`]: "quota_exhausted",
      [`modelLockErrorCode_${MODEL}`]: 429,
    }];
    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({
      allRateLimited: true,
      unavailabilityReason: "quota_exhausted",
      retryAfter: FUTURE_RESET,
    });
  });

  it("refreshes usage once and persists the raw snapshot", async () => {
    mocks.connections = [{ id: "ag-refresh", provider: "antigravity", isActive: true }];
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
      [OTHER_MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });

    await expect(refreshAntigravityQuota("ag-refresh", "token", {})).resolves.toMatchObject({ [MODEL]: { remainingPercentage: 0 } });
    expect(mocks.getAntigravityUsage).toHaveBeenCalledTimes(1);
    expect(mocks.connections[0][`modelLock_${MODEL}`]).toBe(FUTURE_RESET);
    await refreshAntigravityQuota("ag-refresh", "token", {});
    expect(mocks.getAntigravityUsage).toHaveBeenCalledTimes(1);
  });

  it("rejects refresh when durable quota persistence fails", async () => {
    mocks.connections = [{ id: "ag-db-error", provider: "antigravity", isActive: true }];
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    } });
    const update = (await import("@/lib/localDb")).updateProviderConnection;
    update.mockRejectedValueOnce(new Error("db write failed"));
    await expect(refreshAntigravityQuota("ag-db-error", "token", {})).rejects.toThrow("db write failed");
  });

  it("returns exact hard-quota evidence and clears strikes", async () => {
    mocks.connections = [{ id: "ag-hard", provider: "antigravity", isActive: true }];
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET },
    } });
    await expect(handleAntigravityQuotaError("ag-hard", 429, MODEL, "token", {})).resolves.toEqual({
      resetsAtMs: Date.parse(FUTURE_RESET),
      errorClass: "quota_exhausted",
    });
  });

  it("opens a persisted rate-limited breaker after three optimistic results", async () => {
    mocks.connections = [{ id: "ag-breaker", provider: "antigravity", isActive: true }];
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {
      [MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET },
    } });
    await expect(handleAntigravityQuotaError("ag-breaker", 429, MODEL, "token", {})).resolves.toBeNull();
    vi.advanceTimersByTime(3_000);
    await expect(handleAntigravityQuotaError("ag-breaker", 409, MODEL, "token", {})).resolves.toBeNull();
    vi.advanceTimersByTime(3_000);
    const evidence = await handleAntigravityQuotaError("ag-breaker", 429, MODEL, "token", {});
    expect(evidence).toEqual({ resetsAtMs: NOW + 6_000 + 15 * 60_000, errorClass: "rate_limited" });
    clearAntigravityStrikes("ag-breaker", MODEL);
  });

  it("releases a persisted lock after its deadline without quota refresh", async () => {
    mocks.connections = [{
      id: "ag-expired", provider: "antigravity", email: "expired@example.com", isActive: true,
      [`modelLock_${MODEL}`]: FUTURE_RESET,
      [`modelLockReason_${MODEL}`]: "quota_exhausted",
    }];
    vi.setSystemTime(Date.parse(FUTURE_RESET));
    await expect(getProviderCredentials("antigravity", null, MODEL)).resolves.toMatchObject({ connectionId: "ag-expired" });
    expect(mocks.getAntigravityUsage).not.toHaveBeenCalled();
  });
});
