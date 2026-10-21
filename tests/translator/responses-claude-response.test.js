import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { claudeToResponsesResponse, convertClaudeResponseToResponses, failClaudeResponses } from "../../open-sse/translator/response/claude-to-responses.js";
import { unsealClaudeReasoning } from "../../open-sse/translator/concerns/claudeContinuation.js";
import { ClaudeCustomInputDecoder } from "../../open-sse/translator/concerns/claudeCustomInput.js";

const CONTEXT = { provider: "anthropic", model: "model-fixture" };
const CREDENTIALS = { apiKey: "fixture-secret", connectionId: "fixture-account", _responsesClaudeContext: CONTEXT };
const START = { type: "message_start", message: { id: "msg_fixture", model: CONTEXT.model, content: [], usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 1 } } };
const blockStart = (index, content_block) => ({ type: "content_block_start", index, content_block });
const text = (index, value) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
const args = (index, value) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: value } });
const stopBlock = (index) => ({ type: "content_block_stop", index });
const finish = (reason = "end_turn") => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 11 } }, { type: "message_stop" }];

function run(chunks, options = {}) {
  const state = { ...initState(FORMATS.OPENAI_RESPONSES), credentials: CREDENTIALS, ...CONTEXT, ...options };
  const events = chunks.flatMap((chunk) => translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, chunk, state));
  return { state, events, response: events.filter((event) => event.data.response).at(-1)?.data.response };
}
const types = (events) => events.map((event) => event.event);
const terminals = (events) => events.filter((event) => ["response.completed", "response.incomplete", "response.failed"].includes(event.event));

describe("direct Claude to Responses response translation", () => {
  it("uses the direct registry route with stable indexes, IDs and ordered text lifecycle", () => {
    const { events, response, state } = run([START, blockStart(4, { type: "text", text: "initial" }), text(4, " delta"), stopBlock(4), ...finish(), null, ...finish()]);
    expect(types(events)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done",
      "response.output_item.done", "response.completed",
    ]);
    expect(response).toMatchObject({ id: "resp_msg_fixture", object: "response", status: "completed", model: CONTEXT.model,
      usage: { input_tokens: 15, output_tokens: 11, total_tokens: 26, input_tokens_details: { cached_tokens: 7 } },
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "initial delta" }] }] });
    const itemEvents = events.filter((event) => event.data.output_index !== undefined);
    expect(new Set(itemEvents.map((event) => event.data.output_index))).toEqual(new Set([0]));
    const id = response.output[0].id;
    expect(itemEvents.every((event) => (event.data.item_id || event.data.item.id) === id)).toBe(true);
    expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index + 1));
    expect(state.claudeResponsesTerminalStatus).toBe("completed");
    expect(terminals(events)).toHaveLength(1);
  });

  it("keeps parallel interleaved function and custom calls separate", () => {
    const { events, response } = run([
      START,
      blockStart(5, { type: "tool_use", id: "call_one", name: "lookup", input: {} }),
      blockStart(9, { type: "tool_use", id: "call_two", name: "script", input: {} }),
      args(5, '{"city":'), args(9, '{"input":"line\\n'), args(5, '"HCM"}'), args(9, 'quote\\" \\uD83D'),
      args(9, '\\uDE00\\t\\\\end"}'), stopBlock(9), stopBlock(5), ...finish("tool_use"),
    ], { customToolNames: new Set(["script"]) });
    expect(response.status).toBe("completed");
    expect(response.output).toMatchObject([
      { type: "function_call", name: "lookup", call_id: "call_one", arguments: '{"city":"HCM"}', status: "completed" },
      { type: "custom_tool_call", name: "script", call_id: "call_two", input: 'line\nquote" 😀\t\\end', status: "completed" },
    ]);
    const deltas = events.filter((event) => event.event === "response.custom_tool_call_input.delta");
    expect(deltas.map((event) => event.data.delta).join("")).toBe(response.output[1].input);
    expect(deltas.every((event) => event.data.output_index === 1 && event.data.item_id === response.output[1].id)).toBe(true);
    expect(events.findIndex((event) => event.event === "response.function_call_arguments.done")).toBeGreaterThan(events.findIndex((event) => event.event === "response.custom_tool_call_input.delta"));
  });

  it("preserves populated initial tool input and valid empty object input", () => {
    const { response } = run([START,
      blockStart(0, { type: "tool_use", id: "one", name: "lookup", input: { nested: { value: 2 } } }), stopBlock(0),
      blockStart(1, { type: "tool_use", id: "two", name: "noop", input: {} }), stopBlock(1), ...finish("tool_use")]);
    expect(response.output.map((item) => item.arguments)).toEqual(['{"nested":{"value":2}}', "{}"]);
  });

  it("restores tool names before recognizing custom tools", () => {
    const { response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "script_cloaked", input: { input: "echo ok" } }), stopBlock(0), ...finish("tool_use")], {
      customToolNames: new Set(["script"]), toolNameMap: new Map([["script_cloaked", "script"]]),
    });
    expect(response.output[0]).toMatchObject({ type: "custom_tool_call", name: "script", input: "echo ok" });
  });

  it.each(["max_tokens", "model_context_window_exceeded"])("maps %s to incomplete without making a truncated tool executable", (reason) => {
    const { events, response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "lookup", input: {} }), args(0, '{"city":'), stopBlock(0), ...finish(reason)]);
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details.reason).toBe("max_output_tokens");
    expect(response.output[0].status).toBe("incomplete");
    expect(types(events)).not.toContain("response.function_call_arguments.done");
    expect(terminals(events)).toHaveLength(1);
  });

  it.each(['{"x":', '{"x":NaN}', "[]", '"text"'])("fails malformed/nonobject tool JSON %s instead of completing a runnable call", (json) => {
    const { events, response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "lookup", input: {} }), args(0, json), stopBlock(0), ...finish("tool_use")]);
    expect(response.status).toBe("failed");
    expect(response.output[0].status).toBe("incomplete");
    expect(types(events)).not.toContain("response.function_call_arguments.done");
  });

  it.each(['{"input":"unterminated', '{"input":4}', '{"input":"ok","other":true}', '{"input":"bad\\q"}'])("does not finish invalid custom input %s", (json) => {
    const { events, response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "script", input: {} }), ...Array.from(json, (char) => args(0, char)), stopBlock(0), ...finish("tool_use")], { customToolNames: new Set(["script"]) });
    expect(response.status).toBe("failed");
    expect(types(events)).not.toContain("response.custom_tool_call_input.done");
    expect(response.output[0].status).toBe("incomplete");
  });

  it("requires message_stop even after a stop reason and closed valid tool", () => {
    const { events, response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "lookup", input: { city: "HCM" } }), stopBlock(0), finish("tool_use")[0], null, null]);
    expect(response).toMatchObject({ status: "failed", error: { code: "stream_disconnected" }, output: [{ status: "incomplete" }] });
    expect(types(events)).not.toContain("response.function_call_arguments.done");
    expect(terminals(events)).toHaveLength(1);
  });

  it.each([{ prefix: [] }, { prefix: [{ type: "ping" }] }, { prefix: [START] }])("fails EOF after empty or ping-only or start-only streams", ({ prefix }) => {
    const { response, events } = run([...prefix, null]);
    expect(response.status).toBe("failed");
    expect(response.error.code).toBe("stream_disconnected");
    expect(types(events).slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
    expect(terminals(events)).toHaveLength(1);
  });

  it("surfaces native SSE errors and ignores all records after the first terminal", () => {
    const { response, events } = run([START, { type: "error", error: { type: "overloaded_error", message: "busy" } }, ...finish(), null, { type: "error", error: { message: "duplicate" } }]);
    expect(response).toMatchObject({ status: "failed", error: { code: "overloaded_error", message: "busy" } });
    expect(terminals(events)).toHaveLength(1);
  });

  it.each(["pause_turn", "unknown"])("reports unsupported native stop reason %s without claiming completion", (reason) => {
    const { response } = run([START, ...finish(reason)]);
    expect(response).toMatchObject({ status: "failed", error: { code: "provider_error" } });
  });

  it.each([{ input: undefined }, { input: null }, { input: [] }, { input: "bad" }])("never invents object arguments for an absent or nonobject initial tool input", ({ input }) => {
    const { events, response } = run([START, blockStart(0, { type: "tool_use", id: "one", name: "lookup", input }), stopBlock(0), ...finish("tool_use")]);
    expect(response.status).toBe("failed");
    expect(types(events)).not.toContain("response.function_call_arguments.done");
  });

  it.each([
    [blockStart(0, { type: "text", text: "" }), blockStart(0, { type: "text", text: "" })],
    [blockStart(0, { type: "tool_use", id: "same", name: "a", input: {} }), blockStart(1, { type: "tool_use", id: "same", name: "b", input: {} })],
    [blockStart(0, { type: "text", text: "" }), stopBlock(0), stopBlock(0)],
    [text(99, "orphan")],
    [START],
  ])("fails invalid duplicate or missing block/message records", (...records) => {
    const { response, events } = run([START, ...records, ...finish(), null]);
    expect(response.status).toBe("failed");
    expect(terminals(events)).toHaveLength(1);
  });

  it("keeps native signed and redacted thinking encrypted, scoped, and unchanged", () => {
    const { response, events } = run([START,
      blockStart(0, { type: "thinking", thinking: "initial ", signature: "" }),
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "native-" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature" } }, stopBlock(0),
      blockStart(1, { type: "redacted_thinking", data: "opaque-native-data" }), stopBlock(1), ...finish()]);
    expect(response.status).toBe("completed");
    const scope = { ...CONTEXT, credentials: CREDENTIALS };
    expect(unsealClaudeReasoning(response.output[0].encrypted_content, scope)).toEqual([{ type: "thinking", thinking: "initial thought", signature: "native-signature" }]);
    expect(unsealClaudeReasoning(response.output[1].encrypted_content, scope)).toEqual([{ type: "redacted_thinking", data: "opaque-native-data" }]);
    expect(response.output[1].summary).toEqual([]);
    expect(response.output[0]).toMatchObject({ summary: [], content: [{ type: "reasoning_text", text: "initial thought" }] });
    expect(types(events)).toContain("response.reasoning_text.delta");
    expect(() => unsealClaudeReasoning(response.output[0].encrypted_content, { ...scope, credentials: { ...CREDENTIALS, _responsesClaudeContext: { ...CONTEXT, model: "other" } } })).toThrow();
    expect(JSON.stringify(events)).not.toContain("native-signature");
    expect(JSON.stringify(events)).not.toContain("opaque-native-data");
  });

  it("never invents a signature for unsigned reasoning", () => {
    const { response } = run([START, blockStart(0, { type: "thinking", thinking: "visible thought", signature: "" }), stopBlock(0), ...finish()]);
    expect(response.output[0].encrypted_content).toBeUndefined();
  });

  it("supports same-ID transport failure with a single terminal", () => {
    const state = { ...CONTEXT, credentials: CREDENTIALS };
    const started = claudeToResponsesResponse(START, state);
    const failed = failClaudeResponses(state, "aborted", "client_aborted");
    expect(failed.at(-1).data.response.id).toBe(started[0].data.response.id);
    expect(failed.at(-1).data.response.error.code).toBe("client_aborted");
    expect(failClaudeResponses(state, "again")).toEqual([]);
  });

  it("returns a proper nonstream Response with equivalent text, custom calls, native thinking and usage", () => {
    const native = { id: "msg_fixture", type: "message", model: CONTEXT.model, stop_reason: "tool_use", usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 11 }, content: [
      { type: "thinking", thinking: "native thought", signature: "native-sig" },
      { type: "text", text: "Answer" },
      { type: "tool_use", id: "one", name: "script", input: { input: "echo \"ok\"\n" } },
    ] };
    const options = { ...CONTEXT, credentials: CREDENTIALS, customToolNames: ["script"] };
    const response = convertClaudeResponseToResponses(native, options);
    expect(response).toMatchObject({ id: "resp_msg_fixture", object: "response", status: "completed", error: null,
      output: [{ type: "reasoning" }, { type: "message", content: [{ text: "Answer" }] }, { type: "custom_tool_call", call_id: "one", input: 'echo "ok"\n', status: "completed" }],
      usage: { input_tokens: 15, output_tokens: 11, total_tokens: 26, input_tokens_details: { cached_tokens: 7 } } });
    expect(unsealClaudeReasoning(response.output[0].encrypted_content, { ...CONTEXT, credentials: CREDENTIALS })).toEqual([native.content[0]]);
    expect(native.content[0].signature).toBe("native-sig");
  });

  it.each(["max_tokens", "model_context_window_exceeded"])("uses incomplete semantics in nonstream %s", (reason) => {
    const response = convertClaudeResponseToResponses({ ...START.message, stop_reason: reason, content: [{ type: "tool_use", id: "one", name: "lookup", input: {} }] });
    expect(response.status).toBe("incomplete");
    expect(response.output[0].status).toBe("incomplete");
  });

  it("fails malformed nonstream and upstream error envelopes", () => {
    expect(convertClaudeResponseToResponses({ content: "bad" }).status).toBe("failed");
    expect(convertClaudeResponseToResponses({ type: "error", error: { type: "invalid_request_error", message: "bad request" } })).toMatchObject({ status: "failed", error: { code: "invalid_request_error", message: "bad request" } });
  });
});

describe("incremental custom input JSON decoder", () => {
  it("decodes every escape and unicode split one code unit at a time", () => {
    const decoder = new ClaudeCustomInputDecoder();
    const raw = ' { "in\\u0070ut" : "a\\n\\r\\t\\b\\f\\/\\\\\\"\\uD83D\\uDE00" } ';
    const decoded = Array.from(raw, (char) => decoder.push(char)).join("");
    expect(decoder.complete).toBe(true);
    expect(decoded).toBe(JSON.parse(raw).input);
  });

  it("handles long inputs incrementally without reparsing accumulated prefixes", () => {
    const decoder = new ClaudeCustomInputDecoder();
    const input = "abcd😀\n".repeat(2000);
    const raw = JSON.stringify({ input });
    const output = [];
    for (let index = 0; index < raw.length; index += 7) output.push(decoder.push(raw.slice(index, index + 7)));
    expect(output.join("")).toBe(input);
    expect(decoder.complete).toBe(true);
  });
});
