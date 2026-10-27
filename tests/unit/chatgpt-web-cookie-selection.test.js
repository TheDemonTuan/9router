import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("open-sse/services/antigravityModels.js", () => ({
  resolveAntigravityModels: vi.fn(),
  isAntigravityModelAvailable: vi.fn(),
}));

import { getProviderCredentials } from "../../src/sse/services/auth.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  db.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
});

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT Web cookie account eligibility", () => {
  it("skips preserved bridge records and empty cookies, selecting only an upstream cookie account", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "legacy", authType: "bridge", providerSpecificData: { profileId: "legacy-profile" } },
      { id: "legacy-with-key", authType: "bridge", apiKey: "not-a-cookie-account" },
      { id: "blank", authType: "cookie", apiKey: "   " },
      { id: "cookie", authType: "cookie", apiKey: "__Secure-next-auth.session-token=test-cookie" },
    ]);
    const result = await getProviderCredentials("chatgpt-web", null, "gpt-5-6");
    expect(result.connectionId).toBe("cookie");
    expect(result.authType).toBe("cookie");
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("leaves old bridge-only account data unchanged and reports no usable credentials", async () => {
    const legacy = { id: "legacy", authType: "bridge", providerSpecificData: { profileId: "keep-user-data" } };
    db.getProviderConnections.mockResolvedValue([legacy]);
    expect(await getProviderCredentials("chatgpt-web", null, "gpt-5-6")).toBeNull();
    expect(legacy).toEqual({ id: "legacy", authType: "bridge", providerSpecificData: { profileId: "keep-user-data" } });
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports a pinned legacy account unavailable rather than substituting a cookie account", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "legacy", authType: "bridge", providerSpecificData: { profileId: "legacy-profile" } },
      { id: "cookie", authType: "cookie", apiKey: "__Secure-next-auth.session-token=test-cookie" },
    ]);
    expect(await getProviderCredentials("chatgpt-web", null, "gpt-5-6", { pinConnectionId: "legacy" }))
      .toEqual({ pinnedConnectionUnavailable: true, connectionId: "legacy" });
    expect(fetch).not.toHaveBeenCalled();
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });
});
