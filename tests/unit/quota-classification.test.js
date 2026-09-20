import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async ({ provider }) => mocks.connections.filter((connection) => connection.provider === provider)),
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (provider) => provider }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { parseUpstreamError, quotaExhaustedResponse, credentialUnavailableResponse } = await import("../../open-sse/utils/error.js");
const { getProviderCredentials, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const MODEL = "gpt-5.6";
const RESET = "2026-09-21T00:00:00.000Z";

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00.000Z"));
  mocks.connections = [];
  mocks.getSettings.mockResolvedValue({});
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
    Object.assign(mocks.connections.find((connection) => connection.id === id), patch);
  });
});

describe("upstream quota classification", () => {
  it("classifies explicit quota evidence and preserves the Codex reset", async () => {
    const parsed = await parseUpstreamError(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", code: "insufficient_quota", message: "limit reached" } }), { status: 429 }),
      { parseError: () => ({ status: 429, message: "limit reached", resetsAtMs: Date.parse(RESET), type: "usage_limit_reached" }) },
    );
    expect(parsed).toMatchObject({ errorClass: "quota_exhausted", retryable: false, resetsAtMs: Date.parse(RESET) });
  });

  it("classifies GitHub monthly 402 as terminal quota exhaustion through account selection", async () => {
    mocks.connections = [{ id: "github-spent", provider: "github", email: "spent@example.com", isActive: true }];
    const parsed = await parseUpstreamError(new Response("You've reached your additional usage limit for your plan.", { status: 402 }));

    expect(parsed).toMatchObject({ errorClass: "quota_exhausted", retryable: false });
    await markAccountUnavailable("github-spent", parsed.statusCode, parsed.message, "github", MODEL, parsed.resetsAtMs, parsed.errorClass);
    const exhausted = await getProviderCredentials("github", null, MODEL);
    const response = credentialUnavailableResponse(503, exhausted.lastError, exhausted);

    expect(exhausted).toMatchObject({ allRateLimited: true, unavailabilityReason: "quota_exhausted", retryAfter: "2026-10-01T00:00:00.000Z" });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
  });

  it("keeps unrelated 402 errors as request failures", async () => {
    await expect(parseUpstreamError(new Response("Payment required", { status: 402 })))
      .resolves.toMatchObject({ errorClass: "request_error", retryable: false });
  });

  it("locks quota-exhausted pairs until their real reset, skips them, and uses a healthy fallback", async () => {
    mocks.connections = [
      { id: "spent", provider: "codex", email: "spent@example.com", isActive: true },
      { id: "healthy", provider: "codex", email: "healthy@example.com", isActive: true },
    ];
    await markAccountUnavailable("spent", 429, "insufficient_quota", "codex", MODEL, Date.parse(RESET), "quota_exhausted");
    expect(mocks.connections[0][`modelLock_${MODEL}`]).toBe(RESET);
    await expect(getProviderCredentials("codex", null, MODEL)).resolves.toMatchObject({ connectionId: "healthy" });

    await markAccountUnavailable("healthy", 429, "insufficient_quota", "codex", MODEL, Date.parse(RESET), "quota_exhausted");
    await expect(getProviderCredentials("codex", null, MODEL)).resolves.toMatchObject({
      allRateLimited: true, unavailabilityReason: "quota_exhausted", retryAfter: RESET,
    });
  });

  it("returns the terminal quota contract without Retry-After", async () => {
    const response = quotaExhaustedResponse("quota exhausted", RESET, "reset tomorrow");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-9router-error-code")).toBe("provider_quota_exhausted");
    expect(response.headers.get("x-9router-retry-at")).toBe(RESET);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: { type: "usage_limit_reached", code: "insufficient_quota", resets_at: Date.parse(RESET) / 1000 } });
  });

  it("keeps transient 429 retryable and does not mislabel auth or request failures", async () => {
    await expect(parseUpstreamError(new Response("too many requests", { status: 429 }))).resolves.toMatchObject({ errorClass: "rate_limited", retryable: true });
    await expect(parseUpstreamError(new Response("bad token", { status: 401 }))).resolves.toMatchObject({ errorClass: "auth_failed", retryable: false });
    await expect(parseUpstreamError(new Response("bad schema", { status: 400 }))).resolves.toMatchObject({ errorClass: "request_error", retryable: false });
    const response = credentialUnavailableResponse(503, "busy", { retryAfter: "2026-09-20T00:00:05.000Z", retryAfterHuman: "reset after 5s", unavailabilityReason: "rate_limited" });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});
