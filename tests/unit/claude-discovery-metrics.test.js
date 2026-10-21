import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimingContext, createTimingContext } from "@/sse/utils/timingContext.js";

const mockGetProviderConnectionById = vi.fn();
vi.mock("@/models", () => ({
  getProviderConnectionById: (...args) => mockGetProviderConnectionById(...args),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(() => ({})),
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

describe("TimingContext", () => {
  it("initializes with a privacy-safe random requestId and matching correlationId", () => {
    const timing = createTimingContext(1000);
    expect(timing.requestId).toMatch(/^req_[a-zA-Z0-9]+$/);
    expect(timing.correlationId).toBe(timing.requestId);
    expect(timing.receivedAt).toBe(1000);
    expect(timing.bodyParsedAt).toBeNull();
    expect(timing.authCheckedAt).toBeNull();
    expect(timing.accountSelectedAt).toBeNull();
    expect(timing.tokenRefreshedAt).toBeNull();
  });

  it("generates distinct requestIds for consecutive contexts (no content hash)", () => {
    const timing1 = createTimingContext(1000);
    const timing2 = createTimingContext(1000);
    expect(timing1.requestId).not.toBe(timing2.requestId);
  });

  it("records stages and computes correct durations", () => {
    const timing = new TimingContext(1000);
    timing.mark("bodyParsed", 1050);
    timing.mark("authChecked", 1070);
    timing.mark("accountSelected", 1120);
    timing.mark("tokenRefreshed", 1150);

    expect(timing.bodyParsedAt).toBe(1050);
    expect(timing.authCheckedAt).toBe(1070);
    expect(timing.accountSelectedAt).toBe(1120);
    expect(timing.tokenRefreshedAt).toBe(1150);

    const durations = timing.durations;
    expect(durations.bodyMs).toBe(50);
    expect(durations.authMs).toBe(20);
    expect(durations.accountMs).toBe(50);
    expect(durations.refreshMs).toBe(30);
    expect(durations.preCoreMs).toBe(150);

    const obj = timing.toObject();
    expect(obj.requestId).toBe(timing.requestId);
    expect(obj.correlationId).toBe(timing.correlationId);
    expect(obj.receivedAt).toBe(1000);
    expect(obj.durations).toEqual(durations);
  });

  it("tracks full pipeline milestones from route receipt through dispatch, content deltas, terminal, and cancel", () => {
    const timing = new TimingContext(1000);
    timing.mark("bodyParsed", 1010);
    timing.mark("authChecked", 1020);
    timing.mark("accountSelected", 1035);
    timing.mark("tokenRefreshed", 1050);
    timing.mark("coreEntered", 1055);
    timing.mark("payloadPrepared", 1065);
    timing.mark("dispatched", 1065);
    timing.mark("headers", 1200);
    timing.mark("firstByte", 1210);
    timing.mark("firstDownstreamByte", 1211);
    timing.mark("firstReasoning", 1250);
    timing.mark("firstText", 1400);
    timing.mark("firstTool", 1550);
    timing.mark("terminal", 1800);
    timing.mark("cancelled", 1810);

    expect(timing.durations).toEqual({
      bodyMs: 10,
      authMs: 10,
      accountMs: 15,
      refreshMs: 15,
      preCoreMs: 55,
      payloadPrepMs: 10,
      dispatchMs: 65,
      headersMs: 200,
      firstByteMs: 210,
      firstDownstreamByteMs: 211,
      firstReasoningMs: 250,
      firstTextMs: 400,
      firstToolMs: 550,
      terminalMs: 800,
      cancelledMs: 810,
    });
  });
});

describe("GET /api/providers/[id]/models cancellation and error handling", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("returns 499 without 500 when client signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    mockGetProviderConnectionById.mockResolvedValue({
      id: "claude-conn-1",
      provider: "claude",
      apiKey: "sk-ant-test-key",
    });

    const request = new Request("http://localhost:20127/api/providers/claude-conn-1/models", {
      signal: controller.signal,
    });
    const response = await GET(request, { params: Promise.resolve({ id: "claude-conn-1" }) });

    expect(response.status).toBe(499);
    const data = await response.json();
    expect(data.error).toBe("Request cancelled");
    expect(data.code).toBe("request_cancelled");
  });

  it("returns 499 without 500 when fetch throws AbortError during Anthropic/Claude discovery", async () => {
    const controller = new AbortController();

    mockGetProviderConnectionById.mockResolvedValue({
      id: "claude-conn-2",
      provider: "claude",
      apiKey: "sk-ant-test-key",
    });

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    global.fetch.mockRejectedValue(abortError);

    const request = new Request("http://localhost:20127/api/providers/claude-conn-2/models", {
      signal: controller.signal,
    });
    const response = await GET(request, { params: Promise.resolve({ id: "claude-conn-2" }) });

    expect(response.status).toBe(499);
    const data = await response.json();
    expect(data.error).toBe("Request cancelled");
    expect(data.code).toBe("request_cancelled");
  });

  it("surfaces genuine upstream error detail and passes through status code", async () => {
    mockGetProviderConnectionById.mockResolvedValue({
      id: "claude-conn-3",
      provider: "claude",
      apiKey: "sk-ant-invalid-key-123456",
    });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: {
          type: "authentication_error",
          message: "invalid x-api-key provided",
        },
      }),
    });

    const request = new Request("http://localhost:20127/api/providers/claude-conn-3/models");
    const response = await GET(request, { params: Promise.resolve({ id: "claude-conn-3" }) });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("401");
    expect(data.error).toContain("invalid x-api-key provided");
  });

  it("sanitizes sensitive API keys and tokens in upstream error details", async () => {
    mockGetProviderConnectionById.mockResolvedValue({
      id: "claude-conn-4",
      provider: "claude",
      apiKey: "sk-ant-secret-key-abcdef",
    });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          message: "Request failed for key sk-ant-secret-key-abcdef with token Bearer secret-token-xyz12345",
        },
      }),
    });

    const request = new Request("http://localhost:20127/api/providers/claude-conn-4/models");
    const response = await GET(request, { params: Promise.resolve({ id: "claude-conn-4" }) });

    const data = await response.json();
    expect(data.error).not.toContain("sk-ant-secret-key-abcdef");
    expect(data.error).not.toContain("secret-token-xyz12345");
    expect(data.error).toContain("sk-ant-***");
    expect(data.error).toContain("Bearer ***");
  });

  it("returns parsed models when upstream Anthropic/Claude discovery succeeds", async () => {
    mockGetProviderConnectionById.mockResolvedValue({
      id: "claude-conn-5",
      provider: "claude",
      apiKey: "sk-ant-valid-key",
    });

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" },
          { id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" },
        ],
      }),
    });

    const request = new Request("http://localhost:20127/api/providers/claude-conn-5/models");
    const response = await GET(request, { params: Promise.resolve({ id: "claude-conn-5" }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.provider).toBe("claude");
    expect(data.models).toHaveLength(2);
    expect(data.models[0].id).toBe("claude-3-5-sonnet-20241022");
  });
});
