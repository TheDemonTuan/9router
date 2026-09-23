import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  codex: vi.fn(),
  antigravity: vi.fn(),
}));

vi.mock("../../open-sse/services/usage/codex.js", () => ({
  getCodexUsage: mocks.codex,
  consumeCodexRateLimitResetCredit: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
}));
vi.mock("../../open-sse/services/usage/google.js", () => ({
  getGeminiUsage: vi.fn(),
  getAntigravityUsage: mocks.antigravity,
}));
vi.mock("../../open-sse/services/usage/claude.js", () => ({ getClaudeUsage: vi.fn() }));

const load = () => import("../../open-sse/services/usage.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codex.mockResolvedValue({ quotas: { primary: { remainingPercentage: 50 } } });
  mocks.antigravity.mockResolvedValue({ quotas: { model: { remainingPercentage: 50 } } });
});

describe("usage cache identity and payload contract", () => {
  it("invalidates Codex cache when effective inputs change, but ignores Antigravity top-level projectId", async () => {
    const { getUsageForProvider } = await load();
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://one", strictProxy: false };
    const codex = {
      id: "fingerprint-codex",
      provider: "codex",
      accessToken: "token-1",
      apiKey: "key-1",
      providerSpecificData: { accountId: "account-1" },
      projectId: "project-1",
    };

    await getUsageForProvider(codex, proxy);
    await getUsageForProvider({ ...codex, providerSpecificData: { accountId: "account-2" } }, proxy);
    await getUsageForProvider({ ...codex, apiKey: "key-2" }, proxy);
    await getUsageForProvider({ ...codex, accessToken: "token-2" }, proxy);
    await getUsageForProvider({ ...codex, projectId: "project-2" }, { ...proxy, connectionProxyUrl: "http://two" });
    expect(mocks.codex).toHaveBeenCalledTimes(5);

    const antigravity = {
      id: "fingerprint-antigravity",
      provider: "antigravity",
      accessToken: "token-ag",
      providerSpecificData: { region: "global" },
      projectId: "project-1",
    };
    await getUsageForProvider(antigravity, proxy);
    await getUsageForProvider({ ...antigravity, projectId: "project-2" }, proxy);
    expect(mocks.antigravity).toHaveBeenCalledTimes(1);
  });

  it("does not cache provider payloads without a quotas object", async () => {
    const { getUsageForProvider } = await load();
    mocks.codex
      .mockResolvedValueOnce({ plan: "unknown" })
      .mockResolvedValueOnce({ plan: "unknown" });
    const connection = { id: "no-quota", provider: "codex", accessToken: "token" };
    await getUsageForProvider(connection);
    await getUsageForProvider(connection);
    expect(mocks.codex).toHaveBeenCalledTimes(2);

    mocks.codex.mockResolvedValue({ message: "temporary" });
    const messageConnection = { id: "message-only", provider: "codex", accessToken: "token" };
    await getUsageForProvider(messageConnection);
    await getUsageForProvider(messageConnection);
    expect(mocks.codex).toHaveBeenCalledTimes(4);
  });
});
