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
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore Headroom diagnostics", () => {
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

  it("logs why Headroom was skipped on chat completions", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello" }] },
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

    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("skipped: gateway_fetch_error")
    );
    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("ECONNREFUSED")
    );
    expect(log.warn).toHaveBeenCalledWith(
      "HEADROOM",
      expect.stringContaining("http://localhost:8787/v1/compress")
    );
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

    const logs = JSON.stringify(log.warn.mock.calls);
    expect(logs).toContain("https://example.com:8787/proxy/v1/compress");
    expect(logs).not.toContain("user");
    expect(logs).not.toContain("secret");
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

      const logs = JSON.stringify(log.warn.mock.calls);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://user:secret@example.com:8787/proxy/v1/compress?token=abc123",
        expect.any(Object)
      );
      expect(logs).toContain("https://example.com:8787/proxy/v1/compress");
      expect(logs).not.toContain("user");
      expect(logs).not.toContain("secret");
      expect(logs).not.toContain("abc123");
    } finally {
      delete process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN;
    }
  });

  it("sends Headroom-compressed messages to the provider executor", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const original = "very large context that should be replaced";
    const compressed = "compressed context";

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { messages: [{ role: "user", content: compressed }] },
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

  it("reports byte delta without phantom billing heuristic warnings", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const original = "x".repeat(1000);
    const nearlySame = "x".repeat(990);

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { messages: [{ role: "user", content: nearlySame }] },
          },
          tokens_before: 1000,
          tokens_after: 100,
          tokens_saved: 900,
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

    const warns = JSON.stringify(log.warn.mock.calls);
    expect(warns).not.toContain("outbound JSON shrank <5%");
    expect(log.info).toHaveBeenCalledWith("HEADROOM", expect.stringContaining("body="));
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
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { messages: [{ role: "user", content: "compressed" }] },
            turn_id: "turn_hdr_1",
            headers: {
              "anthropic-version": "2023-06-01",
              "x-anthropic-beta": "prompt-caching-2024-07-31",
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

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      customHeaders: {
        "anthropic-version": "2023-06-01",
        "x-anthropic-beta": "prompt-caching-2024-07-31",
      },
    }));
  });

  it("executes SOURCE_NATIVE pipeline compressing source format and translating to Google contents[] for Antigravity", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const originalBody = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "original text to be compressed" }],
    };

    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/v1/compress")) {
        return new Response(JSON.stringify({
          data: {
            body: { messages: [{ role: "user", content: "compressed_claude_text" }] },
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
});
