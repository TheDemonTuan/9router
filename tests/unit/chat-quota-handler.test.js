import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
  clearAntigravityStrikes: mocks.clearAntigravityStrikes,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), maskKey: vi.fn(),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

const RESET_AT = "2026-09-24T07:38:55.000Z";
const RESET_AT_SECONDS = Math.floor(Date.parse(RESET_AT) / 1000);

function request() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antigravity/gemini-3.8-flash-high",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-3.8-flash-high" });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1 });
  mocks.clearAccountError.mockResolvedValue(undefined);
  mocks.handleAntigravityQuotaError.mockResolvedValue(null);
});

describe("chat credential exhaustion", () => {
  it("returns terminal quota JSON before starting the stream", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      unavailabilityReason: "quota_exhausted",
      retryAfter: RESET_AT,
      retryAfterHuman: "reset after 4d 8h",
      lastError: "All accounts have exhausted their usage quota",
    });

    const response = await handleChat(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-9router-error-code")).toBe("provider_quota_exhausted");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "usage_limit_reached",
        code: "insufficient_quota",
        param: null,
        resets_at: RESET_AT_SECONDS,
      },
    });
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("keeps transient exhaustion retryable", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      unavailabilityReason: "transient_provider_failure",
      retryAfter: RESET_AT,
      retryAfterHuman: "reset after 4d 8h",
      lastError: "Provider unavailable",
      lastErrorCode: 503,
    });

    const response = await handleChat(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBeNull();
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("falls back to the next account after normalized hard quota", async () => {
    const first = { connectionId: "ag-a", connectionName: "a", accessToken: "a", providerSpecificData: {} };
    const second = { connectionId: "ag-b", connectionName: "b", accessToken: "b", providerSpecificData: {} };
    mocks.getProviderCredentials.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mocks.handleChatCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Request cannot be served",
        errorClass: "quota_exhausted",
        retryable: false,
        resetsAtMs: Date.parse(RESET_AT),
        response: new Response("quota", { status: 429 }),
      })
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200 }) });

    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "ag-a", 429, "Request cannot be served", "antigravity", "gemini-3.8-flash-high", Date.parse(RESET_AT), "quota_exhausted",
    );
    expect(mocks.handleAntigravityQuotaError).not.toHaveBeenCalled();
  });

  it("does not select another account when durable lock write fails", async () => {
    const first = { connectionId: "ag-a", connectionName: "a", accessToken: "a", providerSpecificData: {} };
    mocks.getProviderCredentials.mockResolvedValueOnce(first);
    mocks.handleChatCore.mockResolvedValueOnce({
      success: false,
      status: 429,
      error: "quota",
      errorClass: "quota_exhausted",
      response: new Response("quota", { status: 429 }),
    });
    mocks.markAccountUnavailable.mockRejectedValueOnce(new Error("db write failed"));

    await expect(handleChat(request())).rejects.toThrow("db write failed");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });
});
