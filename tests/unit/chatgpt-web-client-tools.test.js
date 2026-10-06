import { expect, it } from "vitest";
import "../translator/registerAll.js";
import { validateBrowserChatRequest, validateBrowserResponsesRequest } from "../../services/chatgpt-web-runtime/browser-request.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { bridgeToResponsesSSE } from "../../services/chatgpt-web-runtime/src/bridge.ts";
import { parseRequest } from "../../services/chatgpt-web-runtime/src/responses/parser.ts";
import { createBrowserClientToolProtocol } from "../../services/chatgpt-web-runtime/src/adapters/chatgpt-web/browser-client-tools.ts";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

it("browser conversion preserves function schemas, long correlated IDs and named policy", () => {
  const ids = ["x".repeat(64) + "a", "x".repeat(64) + "b"];
  const argumentsText = JSON.stringify({ text: 'héllo "world"' });
  const schema = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };
  const chat = validateBrowserChatRequest({ model: "chatgpt-web/gpt-5.6-sol", tools: [{ type: "function", function: { name: "Read", parameters: schema, strict: true } }],
    tool_choice: { type: "function", function: { name: "Read" } }, parallel_tool_calls: false,
    messages: [{ role: "system", content: "system" }, { role: "developer", content: "developer" }, { role: "user", content: "read" },
      { role: "assistant", tool_calls: ids.map(id => ({ id, type: "function", function: { name: "Read", arguments: argumentsText } })) },
      ...ids.toReversed().map(tool_call_id => ({ role: "tool", tool_call_id, content: 'résult "quoted"' }))] });
  const converted = validateBrowserResponsesRequest(openaiToOpenAIResponsesRequest(chat.model, chat, true, { chatGptWebRequestMode: "browser" }));
  expect(converted.input.filter(item => item.type === "function_call")).toEqual(ids.map(call_id => ({ type: "function_call", call_id, name: "Read", arguments: argumentsText })));
  expect(converted.input.filter(item => item.type === "function_call_output").map(item => item.call_id)).toEqual(ids.toReversed());
  expect(converted.input.slice(0, 2).map(item => item.role)).toEqual(["system", "developer"]);
  expect(converted.tools[0].parameters).toBe(schema);
  expect(converted.tools[0].strict).toBe(true);
  expect(converted.tool_choice).toEqual({ type: "function", name: "Read" });
  expect(converted.parallel_tool_calls).toBe(false);
});

it("validated parallel calls survive Responses bridge and Chat SSE mapping", async () => {
  const model = "chatgpt-web/gpt-5.6-sol";
  const parsed = parseRequest(validateBrowserResponsesRequest({ model, input: "read", tools: ["Read", "Edit"].map(name => ({ type: "function", name })) }));
  const decision = createBrowserClientToolProtocol(parsed).parse(JSON.stringify({ content: "checking", tool_calls: [{ name: "Read", arguments: { text: 'héllo "world"' } }, { name: "Edit", arguments: { text: "改行\nnext" } }] }));
  async function* events() {
    yield { type: "text_delta", text: decision.content };
    for (const call of decision.calls) {
      yield { type: "tool_call_start", id: call.callId, name: call.wireName };
      yield { type: "tool_call_delta", arguments: JSON.stringify(call.arguments) };
      yield { type: "tool_call_end" };
    }
    yield { type: "done", stopReason: "tool_use", endTurn: false };
  }
  const wire = await new Response(bridgeToResponsesSSE(events(), model)).text();
  const frames = wire.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
  const terminal = frames.filter(frame => frame.type === "response.completed");
  expect(terminal).toHaveLength(1);
  expect(terminal[0].response.end_turn).toBe(false);
  const output = terminal[0].response.output;
  const calls = output.filter(item => item.type === "function_call");
  expect(calls.map(call => [call.call_id, call.name, JSON.parse(call.arguments)])).toEqual(decision.calls.map(call => [call.callId, call.wireName, call.arguments]));
  expect(frames.filter(frame => frame.type === "response.function_call_arguments.done").map(frame => JSON.parse(frame.arguments))).toEqual(decision.calls.map(call => call.arguments));
  const state = {}, reconstructed = new Map(); let finish;
  for (const frame of frames) {
    const chunk = openaiResponsesToOpenAIResponse(frame, state);
    if (chunk?.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    for (const call of chunk?.choices?.[0]?.delta?.tool_calls || []) {
      const slot = reconstructed.get(call.index) || { id: "", name: "", arguments: "" };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      slot.arguments += call.function?.arguments || ""; reconstructed.set(call.index, slot);
    }
  }
  expect([...reconstructed.keys()]).toEqual([0, 1]);
  expect([...reconstructed.values()].map(call => [call.id, call.name, JSON.parse(call.arguments)])).toEqual(decision.calls.map(call => [call.callId, call.wireName, call.arguments]));
  expect(finish).toBe("tool_calls");
  const replay = validateBrowserResponsesRequest({ model, input: [{ role: "user", content: "read" }, ...output, ...calls.toReversed().map(call => ({ type: "function_call_output", call_id: call.call_id, output: "héllo result" }))] });
  expect(createBrowserClientToolProtocol(parseRequest(replay)).parse('{"content":"done","tool_calls":[]}')).toEqual({ content: "done", calls: [] });
});

it("invalid browser decision stays a typed failure through SSE-to-JSON accumulation", async () => {
  const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
  async function* events() { yield { type: "error", message: "Browser client function decision failed validation", status: 502, errorType: "server_error", code: "browser_tool_output_invalid", retryable: false }; }
  const result = await convertResponsesStreamToJson(bridgeToResponsesSSE(events(), "chatgpt-web/gpt-5.6-sol"));
  expect(result).toMatchObject({ status: "failed", error: { code: "browser_tool_output_invalid" }, output: [] });
});
