import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { responsesToGeminiBase } from "../../open-sse/translator/request/responses-to-gemini.js";

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

function directRequest(target) {
  return translateRequest(FORMATS.OPENAI_RESPONSES, target, REQUEST.model, structuredClone(REQUEST), true, { _clientSessionId: "session" });
}

function payloadFor(target) {
  const result = directRequest(target);
  return target === FORMATS.GEMINI ? result : result.request;
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
      temperature: 0.2, topP: 0.8, responseMimeType: "application/json", responseSchema: GOAL_SCHEMA,
    });
    expect(payload.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(321);
    expect(payload.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ text: "First question" }), expect.objectContaining({ inlineData: expect.any(Object) })]) }),
      expect.objectContaining({ role: "model", parts: expect.arrayContaining([expect.objectContaining({ thought: true }), expect.objectContaining({ functionCall: expect.objectContaining({ id: "call_one", args: { city: "HCM" } }) }), expect.objectContaining({ functionCall: expect.objectContaining({ id: "call_two", args: { city: "Hue" } }) })]) }),
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ functionResponse: expect.objectContaining({ id: "call_one", response: { result: { temp: 32 } } }) }), expect.objectContaining({ functionResponse: expect.objectContaining({ id: "call_two", response: { result: { temp: 28 } } }) })]) }),
      expect.objectContaining({ role: "user", parts: expect.arrayContaining([expect.objectContaining({ text: "Compare both cities" })]) }),
    ]));
    expect(payload.tools[0].functionDeclarations).toEqual([expect.objectContaining({ name: "get_weather" })]);
    if (target !== FORMATS.GEMINI) expect(result.request).toBeDefined();
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
});
