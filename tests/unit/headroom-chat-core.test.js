import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore Headroom diagnostics & session terminalNoFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("scrubs credentials and query strings from Headroom fetch errors", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    global.fetch = vi.fn(async () => {
      throw new Error("failed to fetch https://user:secret@example.com:8787/proxy/v1/compress?token=abc123");
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "https://user:secret@example.com:8787/proxy?token=abc123",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    const logs = JSON.stringify(log.debug.mock.calls);
    expect(logs).not.toContain("user:secret");
    expect(logs).not.toContain("abc123");
  });

  it("masks credentials and query strings in Headroom endpoint diagnostics", async () => {
    process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN = "1";
    try {
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

      await handleChatCore({
        body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
        modelInfo: { provider: "openai", model: "gpt-4o" },
        credentials: { apiKey: "test-key", providerSpecificData: {} },
        log,
        connectionId: "test-conn",
        headroomEnabled: true,
        headroomUrl: "https://user:secret@example.com:8787/proxy?token=abc123",
        headroomCompressUserMessages: false,
        rtkEnabled: false,
        cavemanEnabled: false,
        ponytailEnabled: false,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: {},
          headers: { accept: "application/json" },
        },
      });

      const logs = JSON.stringify(log.debug.mock.calls);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://user:secret@example.com:8787/proxy/v1/compress?token=abc123",
        expect.any(Object)
      );
      expect(logs).not.toContain("user:secret");
      expect(logs).not.toContain("abc123");
    } finally {
      delete process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN;
    }
  });

  it("sends Headroom-compressed messages to the provider executor", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const original = "very large context that should be replaced";
    const compressed = "compressed context";

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(JSON.parse(init.body))), messages: [{ role: "user", content: compressed }] },
            turn_id: "turn_123",
          },
          tokens_before: 100,
          tokens_after: 10,
          tokens_saved: 90,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: original }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        messages: [{ role: "user", content: compressed }],
      }),
    }));
    expect(JSON.stringify(executeMock.mock.calls[0][0].body)).not.toContain(original);
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("reported token delta=90 before=100 after=10"));
  });

  it("bypasses token savers when requested by the client", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const pxpipeTransform = vi.fn();
    const messages = [{ role: "user", content: "Write polished prose." }];

    global.fetch = vi.fn(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: true,
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      pxpipeEnabled: true,
      pxpipeTransform,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: {
          accept: "application/json",
          "x-9router-token-saver": "off",
        },
      },
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(pxpipeTransform).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        messages: [{ role: "user", content: "Write polished prose." }],
      }),
    }));
  });

  it("executes SOURCE_NATIVE pipeline compressing source format and translating to Google contents[] for Antigravity", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const originalBody = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "original text to be compressed" }],
    };

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(JSON.parse(init.body))), messages: [{ role: "user", content: "compressed_claude_text" }] },
            turn_id: "turn_sn_1",
          },
          tokens_before: 100,
          tokens_after: 20,
          tokens_saved: 80,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: originalBody,
      modelInfo: { provider: "antigravity", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: originalBody,
        headers: { accept: "application/json" },
      },
    });

    expect(originalBody.messages[0].content).toBe("original text to be compressed");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe("claude-3-5-sonnet-20241022");
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        request: expect.objectContaining({
          contents: expect.arrayContaining([
            expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({ text: "compressed_claude_text" }),
              ]),
            }),
          ]),
        }),
      }),
    }));
  });

  it("handles client cancellation during Headroom compression with HTTP 499", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const clientController = new AbortController();

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        clientController.abort();
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "test" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      clientSignal: clientController.signal,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(result.status).toBe(499);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("derives and forwards headroomSessionId in TARGET_NATIVE when conversation identity exists", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    let receivedPayload = null;

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        receivedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(receivedPayload)), messages: [{ role: "user", content: "compressed" }] },
            turn_id: "turn_sess_1",
          },
          tokens_before: 50,
          tokens_after: 20,
          tokens_saved: 30,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "original" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "secret-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: {
          accept: "application/json",
          "x-session-id": "client-thread-42",
        },
      },
    });

    expect(receivedPayload).toBeTruthy();
    expect(receivedPayload.config).toBeDefined();
    expect(receivedPayload.config.session_id).toMatch(/^s_[0-9a-f]{32}$/);
    expect(receivedPayload.config.session_id).not.toContain("secret-key");
    expect(receivedPayload.gateway.session_affinity).toBe(true);
  });

  it("preserves the provider wire model after TARGET_NATIVE compression", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse(init.body);
      return Response.json({ body: { model: sent.model, messages: sent.messages } });
    });
    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o", upstreamModel: "gpt-4o(high)" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-wire-model", headroomEnabled: true, headroomUrl: "http://localhost:8787",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
    });
    expect(result.response.status).toBe(200);
    expect(executeMock).toHaveBeenCalled();
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe("gpt-4o");
  });

  it("keeps client cancellation terminal when a session fetch fails", async () => {
    const clientController = new AbortController();
    global.fetch = vi.fn(async () => {
      clientController.abort();
      throw new Error("connection lost");
    });
    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-session-cancel", headroomEnabled: true, headroomUrl: "http://localhost:8787",
      clientSignal: clientController.signal,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json", "x-session-id": "session-cancel" } },
    });
    expect(result.status).toBe(499);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("session failure in TARGET_NATIVE returns terminalNoFallback and provider calls zero", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          error: { type: "session_busy" },
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-session-fail-target",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: {
          accept: "application/json",
          "x-session-id": "session-fail-target-1",
        },
      },
    });

    expect(result.terminalNoFallback).toBe(true);
    expect(result.status).toBe(503);
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(result.response.headers.get("x-9router-error-code")).toBe("session_busy");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("session failure in SOURCE_NATIVE returns terminalNoFallback and provider calls zero", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { code: "ECONNREFUSED" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleChatCore({
      body: { model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "antigravity", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-session-fail-source",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "claude",
      headroomCompressUserMessages: false,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: {
          accept: "application/json",
          "x-session-id": "session-fail-source-1",
        },
      },
    });

    expect(result.terminalNoFallback).toBe(true);
    expect(result.status).toBe(503);
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("session invalid response returns terminalNoFallback 502 and provider calls zero", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response("{not-valid-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-session-fail-invalid",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: {
          accept: "application/json",
          "x-session-id": "session-fail-invalid-1",
        },
      },
    });

    expect(result.terminalNoFallback).toBe(true);
    expect(result.status).toBe(502);
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(executeMock).not.toHaveBeenCalled();
  });
});
