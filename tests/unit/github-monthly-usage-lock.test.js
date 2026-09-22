import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  connection: null,
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.connection = {
    id: "github-a",
    provider: "github",
    name: "github-a",
    backoffLevel: 4,
  };
  dbMocks.getProviderConnections.mockResolvedValue([dbMocks.connection]);
  dbMocks.updateProviderConnection.mockImplementation(async (id, patch) => {
    if (id !== dbMocks.connection.id) return null;
    const resolved = typeof patch === "function" ? patch(dbMocks.connection) : patch;
    if (resolved !== null) Object.assign(dbMocks.connection, resolved);
    return dbMocks.connection;
  });
});

describe("GitHub monthly usage exhaustion", () => {
  it("locks the whole account until the next UTC month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "You've reached your additional usage limit for your plan. Go to GitHub settings for details.",
        "github",
        "claude-fable-5",
      );

      expect(dbMocks.connection).toMatchObject({
        modelLock___all: "2026-09-01T00:00:00.000Z",
        testStatus: "unavailable",
        errorCode: 402,
        unavailabilityReason: "quota_exhausted",
        backoffLevel: 0,
      });
      expect(dbMocks.connection.modelLock_claude_fable_5).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unrelated GitHub 402 errors model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "github-a",
        402,
        "Payment required",
        "github",
        "claude-fable-5",
      );

      expect(dbMocks.connection).toMatchObject({
        "modelLock_claude-fable-5": "2026-08-04T19:32:00.000Z",
      });
      expect(dbMocks.connection.modelLock___all).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
