import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";

const { executeMock, forcedSSEToJsonMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  forcedSSEToJsonMock: vi.fn(),
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

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: forcedSSEToJsonMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

let lastDispatchedBody = null;

beforeEach(() => {
  lastDispatchedBody = null;
  executeMock.mockReset();
  forcedSSEToJsonMock.mockReset();

  executeMock.mockImplementation((params) => {
    lastDispatchedBody = structuredClone(params.body);
    const isClaude = params.body && Array.isArray(params.body.messages) && params.body.system !== undefined;
    const jsonBody = isClaude
      ? {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        }
      : {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1234567890,
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
    return {
      response: new Response(
        JSON.stringify(jsonBody),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      ),
      url: "https://example.test/v1/chat/completions",
      headers: {},
      transformedBody: params.body,
    };
  });

  forcedSSEToJsonMock.mockResolvedValue({
    success: true,
    response: new Response("{}", { status: 200 }),
  });
});

async function runCore({
  body,
  modelInfo,
  credentials = { apiKey: "test-key", providerSpecificData: {} },
  cavemanEnabled = false,
  cavemanLevel = "full",
  ponytailEnabled = false,
  ponytailLevel = "full",
  sourceFormatOverride,
  headers = {},
  endpoint = "/v1/chat/completions",
}) {
  const callerBodyBefore = structuredClone(body);
  const result = await handleChatCore({
    body,
    modelInfo,
    credentials,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled,
    cavemanLevel,
    ponytailEnabled,
    ponytailLevel,
    pxpipeEnabled: false,
    sourceFormatOverride,
    clientRawRequest: {
      endpoint,
      body,
      headers: {
        accept: "application/json",
        ...headers,
      },
    },
  });
  expect(result?.success).toBe(true);
  return { result, dispatched: lastDispatchedBody, callerBodyBefore };
}

describe("token saver router policy across dispatch boundaries", () => {
  it("injects both caveman and ponytail prompts in SEP order when both enabled", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched, callerBodyBefore } = await runCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });

    const segments = dispatched.messages[0].content.split("\n\n");
    expect(segments).toEqual(["base", CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full]);
    expect(dispatched.messages[1].content).toBe("hello");
    expect(body).toEqual(callerBodyBefore);
  });

  it("injects only caveman when ponytail is off", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: false,
    });

    const segments = dispatched.messages[0].content.split("\n\n");
    expect(segments).toEqual(["base", CAVEMAN_PROMPTS.full]);
  });

  it("injects only ponytail when caveman is off", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: false,
      ponytailEnabled: true,
      ponytailLevel: "full",
    });

    const segments = dispatched.messages[0].content.split("\n\n");
    expect(segments).toEqual(["base", PONYTAIL_PROMPTS.full]);
  });

  for (const [headerName, headerValue] of [
    ["x-9router-token-saver", "OFF"],
    ["x-9r-token-saver", "off"],
  ]) {
    it(`bypasses injection with client opt-out header ${headerName}: ${headerValue}`, async () => {
      const makeBody = () => ({
        model: "gpt-4o-mini",
        stream: false,
        messages: [
          { role: "system", content: "base" },
          { role: "user", content: "hello" },
        ],
      });

      const { dispatched: baseline } = await runCore({
        body: makeBody(),
        modelInfo: { provider: "openai", model: "gpt-4o-mini" },
        cavemanEnabled: false,
        ponytailEnabled: false,
      });

      const body = makeBody();
      const { dispatched, callerBodyBefore } = await runCore({
        body,
        modelInfo: { provider: "openai", model: "gpt-4o-mini" },
        cavemanEnabled: true,
        cavemanLevel: "full",
        ponytailEnabled: true,
        ponytailLevel: "full",
        headers: { [headerName]: headerValue },
      });

      expect(dispatched).toEqual(baseline);
      expect(body).toEqual(callerBodyBefore);
    });
  }

  it("bypasses injection on chat response_format json_schema", async () => {
    const makeBody = () => ({
      model: "gpt-4o-mini",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    });

    const { dispatched: baseline } = await runCore({
      body: makeBody(),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: false,
      ponytailEnabled: false,
    });

    const body = makeBody();
    const { dispatched, callerBodyBefore } = await runCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });

    expect(dispatched).toEqual(baseline);
    expect(body).toEqual(callerBodyBefore);
  });

  it("bypasses injection on chat response_format json_object", async () => {
    const makeBody = () => ({
      model: "gpt-4o-mini",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
      response_format: { type: "json_object" },
    });

    const { dispatched: baseline } = await runCore({
      body: makeBody(),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: false,
      ponytailEnabled: false,
    });

    const body = makeBody();
    const { dispatched, callerBodyBefore } = await runCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });

    expect(dispatched).toEqual(baseline);
    expect(body).toEqual(callerBodyBefore);
  });

  it("bypasses injection on responses text format json_schema and injects when text format absent", async () => {
    const makeBody = (withSchema) => ({
      model: "gpt-4o-mini",
      stream: false,
      instructions: "base",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
      ...(withSchema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "answer",
                strict: true,
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                  additionalProperties: false,
                },
              },
            },
          }
        : {}),
    });

    const { dispatched: baseline } = await runCore({
      body: makeBody(true),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: false,
      ponytailEnabled: false,
      sourceFormatOverride: "openai-responses",
      headers: { "user-agent": "test-client" },
      endpoint: "/v1/responses",
    });

    const bodyWithSchema = makeBody(true);
    const { dispatched: dispatchedWithSchema, callerBodyBefore } = await runCore({
      body: bodyWithSchema,
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      sourceFormatOverride: "openai-responses",
      headers: { "user-agent": "test-client" },
      endpoint: "/v1/responses",
    });

    expect(dispatchedWithSchema).toEqual(baseline);
    expect(bodyWithSchema).toEqual(callerBodyBefore);

    const { dispatched: positiveDispatched } = await runCore({
      body: makeBody(false),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      sourceFormatOverride: "openai-responses",
      headers: { "user-agent": "test-client" },
      endpoint: "/v1/responses",
    });

    const segments = positiveDispatched.messages[0].content.split("\n\n");
    expect(segments).toEqual(["base", CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full]);
  });

  it("bypasses injection on native codex passthrough", async () => {
    const makeBody = () => ({
      model: "gpt-5.6-sol",
      stream: false,
      instructions: "base",
      input: "hello",
      reasoning: { effort: "low", summary: "detailed" },
    });

    const { dispatched: baseline } = await runCore({
      body: makeBody(),
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      cavemanEnabled: false,
      ponytailEnabled: false,
      sourceFormatOverride: "openai-responses",
      headers: { "user-agent": "codex-cli/0.144.1" },
      endpoint: "/v1/responses",
    });

    const body = makeBody();
    const { dispatched, callerBodyBefore } = await runCore({
      body,
      modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      sourceFormatOverride: "openai-responses",
      headers: { "user-agent": "codex-cli/0.144.1" },
      endpoint: "/v1/responses",
    });

    expect(dispatched.instructions).toBe("base");
    expect(dispatched.input).toBe("hello");
    expect(dispatched.reasoning).toEqual({ effort: "low", summary: "detailed" });
    expect(dispatched).toEqual(baseline);
    expect(body).toEqual(callerBodyBefore);
  });

  it("bypasses injection on native claude passthrough", async () => {
    const makeBody = () => ({
      model: "claude-sonnet-5",
      stream: false,
      system: [{ type: "text", text: "base", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
    });

    const { dispatched: baseline } = await runCore({
      body: makeBody(),
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      cavemanEnabled: false,
      ponytailEnabled: false,
      headers: { "user-agent": "claude-code" },
      endpoint: "/v1/messages",
    });

    const body = makeBody();
    const { dispatched, callerBodyBefore } = await runCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      headers: { "user-agent": "claude-code" },
      endpoint: "/v1/messages",
    });

    expect(dispatched).toEqual(baseline);
    expect(dispatched.system).toHaveLength(1);
    expect(dispatched.system[0].text).toBe("base");
    expect(dispatched.system[0].cache_control.type).toBe("ephemeral");
    expect(body).toEqual(callerBodyBefore);
  });

  it("injects token savers on Cursor provider", async () => {
    const body = {
      model: "cu/default",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "cursor", model: "default" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });
    const blob = JSON.stringify(dispatched.messages);
    expect(blob).toContain(CAVEMAN_PROMPTS.full);
    expect(blob).toContain(PONYTAIL_PROMPTS.full);
  });

  it("injects token savers on Gemini provider", async () => {
    const body = {
      model: "gemini-2.5-flash",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "gemini", model: "gemini-2.5-flash" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });
    const blob = JSON.stringify(dispatched.systemInstruction || dispatched);
    expect(blob).toContain(CAVEMAN_PROMPTS.full);
    expect(blob).toContain(PONYTAIL_PROMPTS.full);
  });

  it("injects token savers on Antigravity provider", async () => {
    const body = {
      model: "gemini-2.5-flash",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "antigravity", model: "gemini-2.5-flash" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });
    const blob = JSON.stringify(dispatched.request?.systemInstruction || dispatched);
    expect(blob).toContain(CAVEMAN_PROMPTS.full);
    expect(blob).toContain(PONYTAIL_PROMPTS.full);
  });

  it("injects token savers on Kiro provider", async () => {
    const body = {
      model: "kr/claude-sonnet-4.6",
      stream: false,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
      ],
    };
    const { dispatched } = await runCore({
      body,
      modelInfo: { provider: "kiro", model: "claude-sonnet-4.6" },
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
    });
    const blob = JSON.stringify(dispatched.conversationState || dispatched);
    expect(blob).toContain(CAVEMAN_PROMPTS.full);
    expect(blob).toContain(PONYTAIL_PROMPTS.full);
  });
});
