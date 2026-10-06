import { expect, test } from "bun:test";
import { validateBrowserResponsesRequest } from "../browser-request.js";
import { parseRequest } from "../src/responses/parser";
import { createBrowserClientToolProtocol } from "../src/adapters/chatgpt-web/browser-client-tools";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const model = "chatgpt-web/gpt-5.6-sol";
const tools = ["Read", "Edit"].map(name => ({ type: "function", name, parameters: { $id: "same-id", type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } } }));
const parsed = (extra = {}) => parseRequest(validateBrowserResponsesRequest({ model, input: "read", tools, ...extra }));
const envelope = (tool_calls: unknown[], content: string | null = null) => JSON.stringify({ content, tool_calls });
test("validates a whole batch before assigning independent public IDs", () => {
  const protocol = createBrowserClientToolProtocol(parsed())!;
  const calls = [{ name: "Read", arguments: { text: 'héllo "world"' } }, { name: "Edit", arguments: { text: "edit" } }];
  const result = protocol.parse(envelope(calls, "checking"));
  expect(result.content).toBe("checking");
  expect(result.calls.map(call => [call.wireName, call.arguments])).toEqual(calls.map(call => [call.name, call.arguments]));
  expect(new Set(result.calls.map(call => call.callId)).size).toBe(2);
  expect(result.calls.every(call => /^call_[a-f0-9]{32}$/.test(call.callId))).toBe(true);
  expect(protocol.parse("```json\n" + envelope([], "done") + "\n```")).toEqual({ content: "done", calls: [] });
});
test("fails closed on malformed transport, schema, names and choice policies", () => {
  for (const [policy, answer] of [
    [{}, "prose " + envelope([], "done")], [{}, envelope([], null)], [{}, envelope([{ name: "Unknown", arguments: {} }])],
    [{}, envelope([{ name: "Read", arguments: { text: 3 } }])], [{}, envelope([{ name: "Read", arguments: { text: "ok" } }, { name: "Edit", arguments: {} }])],
    [{ tool_choice: "none" }, envelope([{ name: "Read", arguments: { text: "ok" } }])], [{ tool_choice: "required" }, envelope([], "done")],
    [{ tool_choice: { type: "function", name: "Read" } }, envelope([{ name: "Edit", arguments: { text: "ok" } }])],
    [{ parallel_tool_calls: false }, envelope([{ name: "Read", arguments: { text: "ok" } }, { name: "Edit", arguments: { text: "ok" } }])],
  ] as const) {
    try { createBrowserClientToolProtocol(parsed(policy))!.parse(answer); throw new Error("accepted invalid output"); }
    catch (error) { expect(error).toMatchObject({ status: 502, code: "browser_tool_output_invalid", retryable: false }); }
  }
});
test("withdrawn declarations allow a text final but never a historical function", () => {
  const request = parseRequest(validateBrowserResponsesRequest({ model, input: [{ role: "user", content: "read" }, { type: "function_call", call_id: "old", name: "Read", arguments: "{}" }, { type: "function_call_output", call_id: "old", output: "ok" }] }));
  const protocol = createBrowserClientToolProtocol(request)!;
  expect(protocol.parse(envelope([], "done"))).toEqual({ content: "done", calls: [] });
  expect(() => protocol.parse(envelope([{ name: "Read", arguments: {} }]))).toThrow();
});
test("invalid and external-ref schemas fail before browser execution", () => {
  for (const parameters of [{ type: "invalid" }, { $ref: "https://invalid.example/schema" }, { $schema: "https://invalid.example/dialect" }]) {
    expect(() => createBrowserClientToolProtocol(parsed({ tools: [{ type: "function", name: "Read", parameters }] }))).toThrow();
  }
});
test("input usage compiles the same complete client protocol context", () => {
  const request = parsed();
  request.modelId = CHATGPT_WEB_MODEL_ID;
  request.options.reasoning = "high";
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const options = { preserveCompleteHistory: true, clientTools: createBrowserClientToolProtocol(request) };
  const compiled = compileChatGptWebPrompt(request, capabilities, undefined, options);
  expect(estimateChatGptWebInputTokens(request, capabilities, options)).toBe(estimateCompiledChatGptWebInputTokens(compiled, request.modelId));
  expect(estimateChatGptWebUsage(request, { answer: envelope([], "done") }, capabilities, false, false, options).inputTokens).toBe(estimateChatGptWebInputTokens(request, capabilities, options));
});
