import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChatGptWebCatalog: vi.fn(),
  hasChatGptWebModel: vi.fn(() => true),
  requestChatGptWebBridge: vi.fn(),
  sanitizeChatGptWebMaxConcurrency: vi.fn((value) => Number.isInteger(value) && value > 0 ? Math.min(value, 5) : null),
  chatGptWebModelSupportsNativeResponses: vi.fn((model) => model?.capabilities?.native_responses === true),
}));

vi.mock("open-sse/services/chatgptWebBridge.js", () => mocks);

const { ChatGPTWebExecutor } = await import("../../open-sse/executors/chatgpt-web.js");

const credentials = { id: "bridge-1", providerSpecificData: { bridgeId: "personal" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasChatGptWebModel.mockReturnValue(true);
});

describe("ChatGPT Web executor capability gate", () => {
  it("parses verified reset metadata without changing terminal response policy", async () => {
    const executor = new ChatGPTWebExecutor();
    const reset = Date.now() + 60_000;
    const payload = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "busy", resets_at: reset } });
    const parsed = executor.parseError(new Response(payload, { status: 429 }), payload);

    expect(parsed).toMatchObject({ status: 429, code: "rate_limit_exceeded", resetsAtMs: reset });
  });

  it("keeps a pre-submit 429 retryable while preserving reset metadata", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
    });
    const reset = Date.now() + 60_000;
    mocks.requestChatGptWebBridge.mockResolvedValue(new Response(JSON.stringify({
      error: { code: "rate_limit_exceeded", message: "busy", resets_at: Math.floor(reset / 1000) },
    }), { status: 429, headers: { "content-type": "application/json" } }));

    const result = await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", input: [] },
      credentials,
      clientTool: "codex",
      signal: new AbortController().signal,
    });

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(result.response.headers.get("x-should-retry")).toBe("true");
    expect(result.response.headers.get("x-9router-error-code")).toBe("rate_limit_exceeded");
    expect(result.response.headers.get("x-9router-retry-at")).toBe(new Date(Math.floor(reset / 1000) * 1000).toISOString());
    expect(result.response.headers.get("retry-after")).toBeNull();
    expect(mocks.requestChatGptWebBridge).toHaveBeenCalledTimes(1);
  });

  it.each([499, 409, 413, 424, 502])("keeps %s terminal and non-retryable", async (status) => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
    });
    mocks.requestChatGptWebBridge.mockResolvedValue(new Response(JSON.stringify({
      error: { code: `status_${status}`, message: "terminal bridge error" },
    }), { status, headers: { "content-type": "application/json" } }));

    const result = await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", input: [] },
      credentials,
      clientTool: "codex",
      signal: new AbortController().signal,
    });

    expect(result.response.status).toBe(status);
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(result.response.headers.get("x-should-retry")).toBe("false");
  });

  it("preserves a bridge-supplied resolved model for diagnostics", async () => {
    const executor = new ChatGPTWebExecutor();
    const payload = JSON.stringify({ error: {
      code: "model_unavailable",
      message: "selected model unavailable",
      resolved_model: "chatgpt-web/actual",
    } });
    const parsed = executor.parseError(new Response(payload, { status: 409 }), payload);

    expect(parsed).toMatchObject({ resolvedModel: "chatgpt-web/actual", retryable: false });
  });

  it("refuses native dispatch when native_responses is unverified", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { reasoning: true } }],
    });

    const result = await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", input: [] },
      credentials,
      clientTool: "codex",
      signal: new AbortController().signal,
    });

    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mocks.requestChatGptWebBridge).not.toHaveBeenCalled();
  });

  it("forces stream mode at the stream-only bridge boundary", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
    });
    mocks.requestChatGptWebBridge.mockResolvedValue(new Response("ok", { status: 200 }));

    await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", stream: false, input: [] },
      credentials,
      clientTool: "codex",
      signal: new AbortController().signal,
    });

    const [, , init] = mocks.requestChatGptWebBridge.mock.calls[0];
    expect(JSON.parse(init.body).stream).toBe(true);
  });

  it("dispatches generic requests only with live generic_responses evidence", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { generic_responses: true } }],
    });
    mocks.requestChatGptWebBridge.mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", input: [] },
      credentials,
      clientTool: null,
      signal: new AbortController().signal,
    });

    expect(result.response.status).toBe(200);
    expect(mocks.requestChatGptWebBridge).toHaveBeenCalledTimes(1);
  });

  it("keeps generic requests closed until generic_responses is live evidence", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
    });

    const result = await new ChatGPTWebExecutor().execute({
      model: "chatgpt-web/high",
      body: { model: "chatgpt-web/high", messages: [] },
      credentials,
      clientTool: null,
      signal: new AbortController().signal,
    });

    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mocks.requestChatGptWebBridge).not.toHaveBeenCalled();
  });
});
