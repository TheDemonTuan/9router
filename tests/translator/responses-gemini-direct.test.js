import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { responsesToGeminiBase } from "../../open-sse/translator/request/responses-to-gemini.js";
import { storeGeminiThoughtSignature } from "../../open-sse/services/thoughtSignatureStore.js";

const GOAL_SCHEMA = {
  type: "object",
  properties: {
    decision: {}, evidence: {}, next_step: {}, blocker_key: {},
  },
  required: ["decision", "evidence", "next_step", "blocker_key"],
  additionalProperties: false,
};

const REQUEST = {
  model: "gemini-3.8-pro",
  instructions: "Return a grounded result.",
  reasoning: { effort: "high" },
  temperature: 0.2,
  top_p: 0.8,
  max_output_tokens: 321,
  text: { format: { type: "json_schema", name: "goal_evaluator", strict: true, schema: GOAL_SCHEMA } },
  tools: [{
    type: "function", name: "get_weather", description: "Read weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
  }],
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "First question" }, { type: "input_image", image_url: "data:image/png;base64,aW1n" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Need weather first" }] },
    { type: "function_call", call_id: "call_one", name: "get_weather", arguments: "{\"city\":\"HCM\"}" },
    { type: "function_call", call_id: "call_two", name: "get_weather", arguments: "{\"city\":\"Hue\"}" },
    { type: "function_call_output", call_id: "call_one", output: "{\"temp\":32}" },
    { type: "function_call_output", call_id: "call_two", output: "{\"temp\":28}" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Compare both cities" }] },
  ],
};

function directRequest(target, body = REQUEST, model = body.model) {
  return translateRequest(FORMATS.OPENAI_RESPONSES, target, model, structuredClone(body), true, { _clientSessionId: "session" });
}

function payloadFor(target, body = REQUEST, model = body.model) {
  const result = directRequest(target, body, model);
  return target === FORMATS.GEMINI || target === FORMATS.VERTEX ? result : result.request;
}

function toolRequest(tool_choice, parallel_tool_calls = undefined) {
  return {
    model: "gemini-3.8-pro",
    tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: {} } }],
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    ...(parallel_tool_calls !== undefined ? { parallel_tool_calls } : {}),
    input: [{ role: "user", content: "weather" }],
  };
}

describe("Responses <-> Gemini direct translators", () => {
  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("maps Responses requests directly to %s", (target) => {
    const result = directRequest(target);
    const payload = payloadFor(target);

    expect(JSON.stringify(result)).not.toContain('"messages"');
    expect(JSON.stringify(result)).not.toContain('"response_format"');
    expect(payload.systemInstruction.parts).toEqual([{ text: "Return a grounded result." }]);
    expect(responsesToGeminiBase(REQUEST.model, REQUEST, "sig").generationConfig.maxOutputTokens).toBe(321);
    expect(payload.generationConfig).toMatchObject({
      temperature: 0.2, topP: 0.8, responseMimeType: "application/json",
      [target === FORMATS.GEMINI ? "responseJsonSchema" : "responseSchema"]: GOAL_SCHEMA,
    });
    expect(payload.generationConfig[target === FORMATS.GEMINI ? "responseSchema" : "responseJsonSchema"]).toBeUndefined();
    expect(payload.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(321);
    expect(payload.safetySettings).toEqual(expect.any(Array));
    expect(payload.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ text: "First question" }), expect.objectContaining({ inlineData: expect.any(Object) })]) }),
      expect.objectContaining({ role: "model", parts: expect.arrayContaining([expect.objectContaining({ thought: true }), expect.objectContaining({ functionCall: expect.objectContaining({ id: "call_one", args: { city: "HCM" } }) }), expect.objectContaining({ functionCall: expect.objectContaining({ id: "call_two", args: { city: "Hue" } }) })]) }),
      expect.objectContaining({
        role: "user",
        parts: expect.arrayContaining([
          expect.objectContaining({ functionResponse: expect.objectContaining({ id: "call_one", response: { result: { temp: 32 } } }) }),
          expect.objectContaining({ functionResponse: expect.objectContaining({ id: "call_two", response: { result: { temp: 28 } } }) }),
        ]),
      }),
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ text: "Compare both cities" })]) }),
    ]));
    expect(payload.tools[0].functionDeclarations).toEqual([expect.objectContaining({ name: "get_weather" })]);
    expect(payload.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    if (target !== FORMATS.GEMINI) expect(result.request).toBeDefined();
  });

  it.each([FORMATS.GEMINI, FORMATS.VERTEX])("preserves anyOf and nullable unions for public Responses -> %s", (target) => {
    const schema = {
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
        maybe: { type: ["string", "null"] },
      },
    };
    const payload = payloadFor(target, {
      model: "gemini-3.8-pro",
      input: [{ type: "message", role: "user", content: "Choose" }],
      text: { format: { type: "json_schema", schema } },
    });

    expect(payload.generationConfig.responseJsonSchema).toEqual(schema);
    expect(payload.generationConfig.responseSchema).toBeUndefined();
  });

  it.each([FORMATS.GEMINI, FORMATS.VERTEX])("preserves multi-branch oneOf for public Responses -> %s", (target) => {
    const schema = {
      type: "object",
      properties: { value: { oneOf: [{ type: "string" }, { type: "object", properties: {} }] } },
    };
    const payload = payloadFor(target, {
      model: "gemini-3.8-pro",
      input: [{ type: "message", role: "user", content: "Choose" }],
      text: { format: { type: "json_schema", schema } },
    });

    expect(payload.generationConfig.responseJsonSchema.properties.value.oneOf).toEqual(schema.properties.value.oneOf);
    expect(payload.generationConfig.responseSchema).toBeUndefined();
  });

  it("falls back to schema instructions for internal Responses multi-branch output", () => {
    const result = directRequest(FORMATS.ANTIGRAVITY, {
      model: "gemini-3.8-pro",
      input: [{ type: "message", role: "user", content: "Choose" }],
      text: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "object" }] } } },
        },
      },
    });

    expect(result.request.generationConfig.responseSchema).toBeUndefined();
    expect(result.request.systemInstruction.parts[0].text).toContain("JSON Schema");
    expect(result.request.systemInstruction.parts[0].text).toContain("oneOf");
  });

  it("uses the Claude-compatible Antigravity path for Claude models", () => {
    const result = directRequest(FORMATS.ANTIGRAVITY, { ...REQUEST, model: "claude-sonnet-4-6" }, "claude-sonnet-4-6");

    expect(result.requestType).toBe("agent");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.request.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ text: "First question" })]) }),
    ]));
    expect(result.request.contents.flatMap((content) => content.parts).some((part) => part.functionCall)).toBe(true);
  });

  it("replays the compatible stored Gemini thought signature", () => {
    storeGeminiThoughtSignature("call_signed", "real-signature", "session", "gemini-3.8-pro");
    const request = responsesToGeminiBase("gemini-3.8-pro", {
      input: [{ type: "function_call", call_id: "call_signed", name: "get_weather", arguments: "{}" }],
    }, "fallback-signature", "session");

    expect(request.contents.flatMap((content) => content.parts).find((part) => part.functionCall)?.thoughtSignature)
      .toBe("real-signature");
  });

  it.each([
    ["none", { mode: "NONE" }],
    ["auto", { mode: "AUTO" }],
    ["required", { mode: "ANY" }],
    [{ type: "function", name: "get_weather" }, { mode: "ANY", allowedFunctionNames: ["get_weather"] }],
  ])("maps tool_choice %j", (choice, expected) => {
    expect(responsesToGeminiBase("gemini-3.8-pro", toolRequest(choice), "signature").toolConfig)
      .toEqual({ functionCallingConfig: expected });
  });

  it("rejects unsupported direct tool semantics instead of changing them", () => {
    expect(() => responsesToGeminiBase("gemini-3.8-pro", toolRequest("auto", false), "signature"))
      .toThrow(/parallel_tool_calls=false/);
    expect(() => responsesToGeminiBase("gemini-3.8-pro", {
      input: [{ type: "custom_tool_call", call_id: "custom", name: "shell", input: "pwd" }],
    }, "signature")).toThrow(/Unsupported Responses input item/);
    expect(() => responsesToGeminiBase("gemini-3.8-pro", {
      tools: [{ type: "web_search" }], input: [{ role: "user", content: "search" }],
    }, "signature")).toThrow(/Unsupported Responses tool/);
  });

  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])("emits canonical Responses events directly from %s", (target) => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = [
      ...translateResponse(target, FORMATS.OPENAI_RESPONSES, {
        response: {
          responseId: "gemini-response", modelVersion: "gemini-3.8-pro",
          candidates: [{ content: { parts: [{ thought: true, text: "Check evidence. " }, { text: "Answer: " }] } }],
        },
      }, state),
      ...translateResponse(target, FORMATS.OPENAI_RESPONSES, {
        candidates: [{
          content: { parts: [
            { text: "sunny" },
            { inlineData: { mimeType: "image/png", data: "aW1n" } },
            { functionCall: { id: "call_one", name: "get_weather", args: { city: "HCM" } } },
            { functionCall: { id: "call_two", name: "get_weather", args: { city: "Hue" } } },
          ] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 15 },
      }, state),
    ];

    const names = events.map((event) => event.event);
    expect(names).toContain("response.created");
    expect(names.indexOf("response.output_text.delta")).toBeLessThan(names.indexOf("response.output_text.done"));
    expect(names.indexOf("response.reasoning_summary_text.delta")).toBeLessThan(names.indexOf("response.reasoning_summary_text.done"));
    const calls = events.filter((event) => event.event === "response.output_item.done" && event.data.item.type === "function_call");
    expect(calls.map((event) => event.data.item.call_id)).toEqual(["call_one", "call_two"]);
    expect(calls.map((event) => event.data.item.arguments)).toEqual(["{\"city\":\"HCM\"}", "{\"city\":\"Hue\"}"]);
    expect(events.some((event) => event.data.part?.type === "output_image")).toBe(true);
    const completed = events.find((event) => event.event === "response.completed").data.response;
    expect(completed.output).toHaveLength(4);
    expect(completed.usage).toMatchObject({
      input_tokens: 10, output_tokens: 5,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it.each([
    ["STOP", "response.completed", "completed", null],
    ["MAX_TOKENS", "response.incomplete", "incomplete", "max_output_tokens"],
    ["SAFETY", "response.incomplete", "incomplete", "content_filter"],
    ["RECITATION", "response.incomplete", "incomplete", "content_filter"],
    ["BLOCKLIST", "response.incomplete", "incomplete", "content_filter"],
    ["PROHIBITED_CONTENT", "response.incomplete", "incomplete", "content_filter"],
    ["SPII", "response.incomplete", "incomplete", "content_filter"],
    ["IMAGE_SAFETY", "response.incomplete", "incomplete", "content_filter"],
  ])("maps Gemini %s terminal semantics", (finishReason, eventName, status, reason) => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: `terminal-${finishReason}`,
      candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason }],
    }, state);
    const terminal = events.find((event) => event.event === eventName);

    expect(terminal.data.response.status).toBe(status);
    expect(terminal.data.response.incomplete_details).toEqual(reason ? { reason } : null);
    expect(events.some((event) => event.event === "response.completed")).toBe(finishReason === "STOP");
  });

  it.each(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER", "UNKNOWN_REASON"])("maps Gemini %s to provider failure instead of content filtering", (finishReason) => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: `failed-${finishReason}`,
      candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason }],
    }, state);
    const terminal = events.find((event) => event.event === "response.failed");

    expect(terminal.data.response).toMatchObject({
      status: "failed",
      error: { type: "server_error", code: "provider_error" },
    });
    expect(events.some((event) => event.event === "response.completed" || event.event === "response.incomplete")).toBe(false);
  });

  it("fails an empty Gemini candidate list instead of dropping it", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: "empty-candidates",
      candidates: [],
    }, state);
    const terminal = events.find((event) => event.event === "response.failed");

    expect(terminal.data.response).toMatchObject({
      status: "failed",
      error: { type: "server_error", code: "provider_error" },
    });
    expect(events.some((event) => event.event === "response.created")).toBe(true);
    expect(translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, null, state)).toEqual([]);
  });

  it("reports a direct Gemini EOF without a finish reason as stream_disconnected", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: "unexpected-eof",
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
    }, state);
    const events = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, null, state);
    const terminal = events.find((event) => event.event === "response.failed");

    expect(terminal.data.response).toMatchObject({
      status: "failed",
      error: { type: "stream_error", code: "stream_disconnected" },
    });
    expect(events.some((event) => event.event === "response.completed")).toBe(false);
  });

  it("closes text, function, and later text as separate Responses items", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: "interleaved",
      candidates: [{ content: { parts: [
        { text: "before" },
        { functionCall: { id: "call_interleaved", name: "get_weather", args: {} } },
        { text: "after" },
      ] }, finishReason: "STOP" }],
    }, state);
    const done = events.filter((event) => event.event === "response.output_item.done").map((event) => event.data.item);

    expect(done.map((item) => item.type)).toEqual(["message", "function_call", "message"]);
    expect(done.filter((item) => item.type === "message").map((item) => item.content[0].text)).toEqual(["before", "after"]);
  });

  it("stores a streamed Gemini signature for the next direct function replay", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.sessionId = "session-from-response";
    translateResponse(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, {
      responseId: "signature-response",
      modelVersion: "gemini-3.8-pro",
      candidates: [{ content: { parts: [{ thoughtSignature: "upstream-signature" }, { functionCall: { id: "call_replay", name: "get_weather", args: {} } }] }, finishReason: "STOP" }],
    }, state);

    const replay = responsesToGeminiBase("gemini-3.8-pro", {
      input: [{ type: "function_call", call_id: "call_replay", name: "get_weather", arguments: "{}" }],
    }, "fallback-signature", "session-from-response");
    expect(replay.contents.flatMap((content) => content.parts).find((part) => part.functionCall)?.thoughtSignature)
      .toBe("upstream-signature");
  });
});
