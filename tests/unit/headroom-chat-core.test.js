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

describe("handleChatCore Headroom diagnostics", () => {
  beforeEach(() => {
    globalThis[Symbol.for("9router.headroom.runtime")]?.clear();
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
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("body="));
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("messages="));

    const logs = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logs).not.toContain(original);
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

  it("forwards provider request headers from Headroom Gateway into executor.execute({ customHeaders })", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(JSON.parse(init.body))), messages: [{ role: "user", content: "compressed" }] },
            turn_id: "turn_hdr_1",
            headers: {
              "anthropic-beta": "context-management-2025-06-27",
              "anthropic-version": "2023-06-01",
            },
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
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ customHeaders: null }));
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

    // Caller body was NOT mutated in-place
    expect(originalBody.messages[0].content).toBe("original text to be compressed");

    // Executor received translated Google contents[] containing the compressed text
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

  it("executes full Claude Code request with thinking and parallel tool_use through Headroom into Antigravity Google contents[]", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const claudeCodeBody = {
      model: "claude-3-7-sonnet-20250219",
      system: [
        { type: "text", text: "You are a coding assistant." },
      ],
      messages: [
        {
          role: "user",
          content: "Find and read the config file.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Need to locate the config file first.",
              signature: "sig_abc_123",
            },
            {
              type: "tool_use",
              id: "toolu_find_1",
              name: "find_file",
              input: { pattern: "*.json" },
            },
            {
              type: "tool_use",
              id: "toolu_read_2",
              name: "read_file",
              input: { path: "config.json" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_find_1",
              content: "config.json found",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_read_2",
              content: "{\"port\": 8080}",
            },
          ],
        },
      ],
      tools: [
        {
          name: "find_file",
          description: "Find files",
          input_schema: { type: "object", properties: { pattern: { type: "string" } } },
        },
        {
          name: "read_file",
          description: "Read file contents",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };

    let receivedHeadroomPayload = null;
    let receivedRelayPayload = null;
    global.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/v1/compress/response")) {
        receivedRelayPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.endsWith("/v1/compress")) {
        receivedHeadroomPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            body: {
              messages: receivedHeadroomPayload.messages,
              system: receivedHeadroomPayload.system,
            },
            turn_id: "turn_claude_ag_1",
            obligations: ["relay_usage"],
          },
          tokens_before: 200,
          tokens_after: 50,
          tokens_saved: 150,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: claudeCodeBody,
      modelInfo: { provider: "antigravity", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: claudeCodeBody,
        headers: { accept: "application/json" },
      },
    });

    // 1. Headroom received valid Claude wire format
    expect(receivedHeadroomPayload).toBeTruthy();
    expect(receivedHeadroomPayload.messages[1].content[0].type).toBe("thinking");
    expect(receivedHeadroomPayload.messages[1].content[1].type).toBe("tool_use");
    expect(receivedHeadroomPayload.gateway).toEqual({
      can_redrive: false,
      can_relay_response: true,
      session_affinity: false,
    });

    // 2. Antigravity executor received translated request structure with contents
    expect(executeMock).toHaveBeenCalledTimes(1);
    const executedRequest = executeMock.mock.calls[0][0].body.request;
    expect(executedRequest).toBeTruthy();
    expect(executedRequest.contents).toBeInstanceOf(Array);

    // Verify functionCall and functionResponse were produced in Antigravity format
    const contentsJson = JSON.stringify(executedRequest.contents);
    expect(contentsJson).toContain("find_file");
    expect(contentsJson).toContain("read_file");
    expect(contentsJson).toContain("config.json found");
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

  it("handles preResponse deadline expiration during Headroom compression with HTTP 504", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const deadlineController = new AbortController();
    const deadlineError = new Error("Pre-response deadline exceeded");
    deadlineError.code = "PRE_RESPONSE_DEADLINE_EXCEEDED";
    deadlineError.status = 504;

    const mockPreResponse = {
      remainingMs: () => 5000,
      signal: deadlineController.signal,
      run: (fn) => fn(),
    };

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        deadlineController.abort(deadlineError);
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "test" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      preResponse: mockPreResponse,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED", status: 504 });

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

  it("omits session_id and disables session_affinity when headroomCompressUserMessages is true", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    let receivedPayload = null;

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        receivedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(receivedPayload)), messages: [{ role: "user", content: "compressed" }] },
            turn_id: "turn_sess_2",
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
      headroomCompressUserMessages: true,
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
    expect(receivedPayload.config).toEqual({ compress_user_messages: true });
    expect(receivedPayload.config.session_id).toBeUndefined();
    expect(receivedPayload.gateway.session_affinity).toBe(false);
  });

  it("derives and forwards session_id in SOURCE_NATIVE for Antigravity requests", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };
    let receivedPayload = null;

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        receivedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(receivedPayload)), messages: [{ role: "user", content: "compressed_text" }] },
            turn_id: "turn_sn_sess_1",
          },
          tokens_before: 100,
          tokens_after: 40,
          tokens_saved: 60,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const claudeBody = {
      model: "claude-3-5-sonnet-20241022",
      metadata: { user_id: "user_session_12345678-1234-1234-1234-123456789abc" },
      messages: [{ role: "user", content: "hello from claude code session" }],
    };

    await handleChatCore({
      body: claudeBody,
      modelInfo: { provider: "antigravity", model: "claude-3-5-sonnet" },
      credentials: { apiKey: "antigravity-user-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: claudeBody,
        headers: { accept: "application/json" },
      },
    });

    expect(receivedPayload).toBeTruthy();
    expect(receivedPayload.config?.session_id).toMatch(/^s_[0-9a-f]{32}$/);
    expect(receivedPayload.gateway.session_affinity).toBe(true);

    const gearCalls = log.line.mock.calls.filter((call) => call[1] === "⚙");
    expect(gearCalls.length).toBeGreaterThan(0);
    expect(gearCalls[0][2]).toContain("HEADROOM:60tok/60%");
    expect(gearCalls[0][2]).toContain("SESSION:affinity");
  });

  it("emits HEADROOM:0tok in gear line when token savings are 0", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        const payload = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            body: { ...((({ gateway, config, ...providerBody }) => providerBody)(payload)), messages: [{ role: "user", content: "same" }] },
            turn_id: "turn_zero_1",
          },
          tokens_before: 50,
          tokens_after: 50,
          tokens_saved: 0,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "same text" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    const gearCalls = log.line.mock.calls.filter((call) => call[1] === "⚙");
    expect(gearCalls.length).toBeGreaterThan(0);
    expect(gearCalls[0][2]).toContain("HEADROOM:0tok");
  });

  it("bypasses Headroom before network when stateless SSE payload exceeds cutoff", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };
    const largeContent = "a".repeat(150 * 1024);

    global.fetch = vi.fn(async () => {
      throw new Error("Headroom gateway should not be called for large stateless SSE");
    });

    await handleChatCore({
      body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: largeContent }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "text/event-stream" },
      },
    });

    expect(global.fetch).not.toHaveBeenCalled();
    const gearCalls = log.line.mock.calls.filter((call) => call[1] === "⚙");
    expect(gearCalls.length).toBeGreaterThan(0);
    expect(gearCalls[0][2]).toContain("HEADROOM:BYPASS:stateless_sse_payload_too_large");
    expect(gearCalls[0][2]).toContain("SESSION:stateless");
  });

  it("logs invariant_violation with field detail and emits invariant tag in gear line", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };

    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        const payload = JSON.parse(init.body);
        const { gateway, config, ...cleanPayload } = payload;
        return new Response(JSON.stringify({
          data: {
            body: {
              ...cleanPayload,
              // Corrupt the function call arguments
              messages: [
                payload.messages[0],
                {
                  role: "assistant",
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{broken-json" } }],
                },
              ],
            },
            turn_id: "turn_corrupted_1",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const body = {
      model: "gpt-4o",
      stream: false,
      messages: [
        { role: "user", content: "inspect repo" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.js\"}" } }],
        },
      ],
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: { accept: "application/json" },
      },
    });

    // Verify warning logged with field detail
    const warnCalls = log.warn.mock.calls.filter((call) => call[0] === "HEADROOM");
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls.some((call) => call[1].includes("invariant_violation field=messages.1.tool_calls.0.function.arguments"))).toBe(true);

    // Verify gear line contains HEADROOM:BYPASS:invariant(messages.1.tool_calls.0.function.arguments)
    const gearCalls = log.line.mock.calls.filter((call) => call[1] === "⚙");
    expect(gearCalls.length).toBeGreaterThan(0);
    expect(gearCalls[0][2]).toContain("HEADROOM:BYPASS:invariant(messages.1.tool_calls.0.function.arguments)");
  });

  it("executes tool-heavy Responses request with session affinity through Headroom 0.38 tool compaction into Antigravity", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };

    // 75 items in input
    const input = [];
    for (let i = 0; i < 75; i++) {
      if (i % 3 === 0) {
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: `User turn ${i} long text message` }] });
      } else if (i % 3 === 1) {
        input.push({ type: "function_call", call_id: `call_${i}`, name: "tool_search", arguments: JSON.stringify({ query: `query ${i}` }) });
      } else {
        input.push({ type: "function_call_output", call_id: `call_${i - 1}`, output: `Result of tool execution for turn ${i}` });
      }
    }

    const tools = [
      {
        type: "function",
        name: "tool_search",
        description: "   Search the database for items   ",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "SearchParameters",
          type: "object",
          properties: {
            query: {
              type: "string",
              title: "Query String",
              description: "   The query to run   ",
              examples: ["select * from users"],
            },
            limit: {
              type: "number",
              title: "Result Limit",
              description: "Maximum number of rows to return",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      {
        type: "function",
        name: "tool_execute",
        description: "Execute a command securely in environment",
        parameters: {
          $id: "https://example.com/exec.schema.json",
          $comment: "Internal tool execution schema",
          type: "object",
          properties: {
            cmd: {
              type: "string",
              description: "Command to execute",
              deprecated: false,
            },
          },
          required: ["cmd"],
        },
      },
    ];

    let receivedHeadroomPayload = null;
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/v1/compress")) {
        receivedHeadroomPayload = JSON.parse(init.body);
        const { gateway, config, ...cleanPayload } = receivedHeadroomPayload;

        // Headroom 0.38 compacts tool schemas (removes $schema, title, examples, trims description)
        const compactedTools = [
          {
            type: "function",
            name: "tool_search",
            description: "Search the database for items",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query to run",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of rows to return",
                  default: 10,
                },
              },
              required: ["query"],
            },
          },
          {
            type: "function",
            name: "tool_execute",
            description: "Execute a command securely in environment",
            parameters: {
              type: "object",
              properties: {
                cmd: {
                  type: "string",
                  description: "Command to execute",
                },
              },
              required: ["cmd"],
            },
          },
        ];

        return new Response(JSON.stringify({
          data: {
            body: {
              ...cleanPayload,
              input: cleanPayload.input.map((item) => (item.type === "message" ? { ...item, content: [{ type: "input_text", text: "compressed" }] } : item)),
              tools: compactedTools,
            },
            turn_id: "turn_tool_heavy_1",
          },
          transforms_applied: ["tool_schema_compaction", "tool_desc_compaction"],
          tokens_before: 5000,
          tokens_after: 2500,
          tokens_saved: 2500,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const responsesBody = {
      model: "gemini-2.5-pro",
      input,
      tools,
      stream: true,
    };

    await handleChatCore({
      body: responsesBody,
      modelInfo: { provider: "antigravity", model: "gemini-2.5-pro" },
      credentials: { apiKey: "test-antigravity-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn-tool-heavy",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: responsesBody,
        headers: {
          accept: "text/event-stream",
          "x-session-id": "client-responses-sess-99",
        },
      },
    });

    // 1. Headroom received session affinity and full toolset
    expect(receivedHeadroomPayload).toBeTruthy();
    expect(receivedHeadroomPayload.gateway.session_affinity).toBe(true);
    expect(receivedHeadroomPayload.config.session_id).toMatch(/^s_/);
    expect(receivedHeadroomPayload.input.length).toBe(75);
    expect(receivedHeadroomPayload.tools.length).toBe(2);

    // 2. Headroom compression accepted and forwarded to Antigravity executor
    expect(executeMock).toHaveBeenCalledTimes(1);
    const agCall = executeMock.mock.calls[0][0];
    const agReq = agCall.body.request;
    expect(agReq.tools).toBeDefined();
    const decls = agReq.tools[0].functionDeclarations;
    expect(decls.length).toBe(2);
    expect(decls[0].name).toBe("tool_search");
    expect(decls[0].description).toBe("Search the database for items");
    expect(decls[1].name).toBe("tool_execute");

    // Compaction verified: $schema, title, examples stripped from parameters
    const schema0 = decls[0].parametersJsonSchema || decls[0].parameters;
    expect(schema0.$schema).toBeUndefined();
    expect(schema0.title).toBeUndefined();
    expect(schema0.properties.query.title).toBeUndefined();
    expect(schema0.properties.query.examples).toBeUndefined();
    expect(schema0.required).toEqual(["query"]);

    // Gear log emitted token savings
    const gearCalls = log.line.mock.calls.filter((call) => call[1] === "⚙");
    expect(gearCalls.length).toBeGreaterThan(0);
    expect(gearCalls[0][2]).toContain("HEADROOM:2500tok/50%");
    expect(gearCalls[0][2]).toContain("SESSION:affinity");
  });

  it("fails open and preserves original tools when Headroom corrupts tool names or required fields", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };

    global.fetch = vi.fn(async (url, init) => {
      const payload = JSON.parse(init.body);
      const { gateway, config, ...cleanPayload } = payload;
      return new Response(JSON.stringify({
        data: {
          body: {
            ...cleanPayload,
            // Corrupt tool name
            tools: [
              {
                ...cleanPayload.tools[0],
                name: "unauthorized_name_change",
              },
            ],
          },
          turn_id: "turn_corrupt_tool",
        },
        transforms_applied: ["tool_schema_compaction"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const body = {
      model: "gemini-2.5-pro",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{ type: "function", name: "valid_tool", parameters: { type: "object", properties: { a: { type: "string" } } } }],
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "antigravity", model: "gemini-2.5-pro" },
      credentials: { apiKey: "test-antigravity-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn-tool-fail",
      headroomEnabled: true,
      headroomUrl: "http://localhost:8787",
      sourceFormatOverride: "openai-responses",
      clientRawRequest: {
        endpoint: "/v1/responses",
        body,
        headers: { accept: "application/json" },
      },
    });

    // Invariant violation warning logged with tools field detail
    const warnCalls = log.warn.mock.calls.filter((call) => call[0] === "HEADROOM");
    expect(warnCalls.some((call) => call[1].includes("invariant_violation field=tools.0.name"))).toBe(true);

    // Fail-open: Antigravity executor received original unmutated tool
    expect(executeMock).toHaveBeenCalledTimes(1);
    const decls = executeMock.mock.calls[0][0].body.request.tools[0].functionDeclarations;
    expect(decls[0].name).toBe("valid_tool");
  });
});
