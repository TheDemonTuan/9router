import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { buildTransformStream } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { detectClientTool, getResponsesDialect } from "../../open-sse/utils/clientDetector.js";

const encoder = new TextEncoder();

function sse(events) {
  return events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("");
}

async function text(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function eventsFrom(output) {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map(record => {
    const event = record.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(record.match(/^data: (.+)$/m)?.[1] || "null");
    return { event, data };
  }).filter(event => event.data);
}

function grokContract(output) {
  const terminal = eventsFrom(output).find(({ data }) => data.type === "response.completed")?.data.response;
  const visible = terminal?.output?.some(item => item.type === "message" && item.content?.some(part => part.type === "output_text" && part.text)) || false;
  const toolCalls = terminal?.output?.filter(item => item.type === "function_call").length || 0;
  return { terminal, empty: !visible && toolCalls === 0 };
}

function compatibleTransform(input) {
  return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(input)); controller.close(); } }).pipeThrough(buildTransformStream({
    provider: "codex", model: "gpt-5.6-sol", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    responsesClientDialect: "grok-build", responsesProviderDialect: "codex-native",
  }));
}

describe("Grok Build Responses compatibility", () => {
  it.each([
    [{ "user-agent": "grok-shell/1" }], [{ "user-agent": "grok-tui/1" }], [{ "user-agent": "grok-cli/1" }], [{ "x-grok-client-identifier": "Grok Build" }],
  ])("detects Grok Build headers", (headers) => {
    expect(detectClientTool(headers)).toBe("grok-build");
    expect(getResponsesDialect(detectClientTool(headers))).toBe("grok-build");
  });

  it("keeps native Codex bytes unchanged", async () => {
    const input = sse([{ event: "response.future", data: { type: "response.future", opaque: 1 } }, { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", status: "completed" } } }]);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(input)); controller.close(); } }).pipeThrough(buildTransformStream({
      provider: "codex", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
      responsesClientDialect: "codex-native", responsesProviderDialect: "codex-native",
    }));
    expect(await text(stream)).toBe(input);
  });

  it("reconstructs Grok terminal text without changing unknown records", async () => {
    const input = sse([
      { event: "response.future", data: { type: "response.future", opaque: { version: 1 } } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } } },
      { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", model: "gpt-5.6-sol", usage: { input_tokens: 2, output_tokens: 1 } } } },
    ]);
    const output = await text(compatibleTransform(input));
    expect(output).toContain('"type":"response.future"');
    expect(grokContract(output)).toMatchObject({ empty: false, terminal: { id: "resp_1", status: "completed" } });
    expect(grokContract(output).terminal.output[0].content[0].text).toBe("hello");
  });

  it("recovers delta-only text, parallel calls, preserves upstream output, and leaves reasoning-only empty", async () => {
    const deltaOnly = sse([
      { data: { type: "response.output_text.delta", output_index: 0, delta: "hello" } },
      { data: { type: "response.completed", response: { id: "resp_delta", status: "completed", output: [] } } },
    ]);
    expect(grokContract(await text(compatibleTransform(deltaOnly))).empty).toBe(false);

    const calls = sse([
      { data: { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "one", arguments: "" } } },
      { data: { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" } },
      { data: { type: "response.output_item.added", output_index: 1, item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "two", arguments: "" } } },
      { data: { type: "response.function_call_arguments.done", output_index: 1, arguments: "{\"x\":1}" } },
      { data: { type: "response.completed", response: { id: "resp_calls", status: "completed" } } },
    ]);
    const callsTerminal = grokContract(await text(compatibleTransform(calls))).terminal;
    expect(callsTerminal.output.map(item => item.name)).toEqual(["one", "two"]);
    expect(callsTerminal.output.map(item => item.arguments)).toEqual(["{}", '{"x":1}']);

    const upstreamOutput = sse([{ data: { type: "response.completed", response: { id: "resp_authoritative", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "upstream" }] }] } } }]);
    expect(grokContract(await text(compatibleTransform(upstreamOutput))).terminal.output[0].content[0].text).toBe("upstream");

    const incompleteItem = sse([
      { data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_complete", type: "message", role: "assistant", content: [{ type: "output_text", text: "complete" }] } } },
      { data: { type: "response.completed", response: { id: "resp_canonical", status: "completed", output: [] } } },
    ]);
    const normalized = grokContract(await text(compatibleTransform(incompleteItem))).terminal.output[0];
    expect(normalized).toMatchObject({ id: "msg_complete", type: "message", role: "assistant", status: "completed" });
    expect(normalized.content[0]).toEqual({ type: "output_text", text: "complete", annotations: [] });

    const reasoningOnly = sse([{ data: { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] } } }, { data: { type: "response.completed", response: { id: "resp_reasoning", status: "completed" } } }]);
    expect(grokContract(await text(compatibleTransform(reasoningOnly))).empty).toBe(true);
  });

  it("reports content-free compatibility diagnostics", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const input = sse([
      { data: { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "never log this" }] } } },
      { data: { type: "response.completed", response: { id: "resp_log", status: "completed", output: [] } } },
    ]);
    await text(compatibleTransform(input));
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.find(line => line.startsWith("[RESP]"))).toMatch(/events=2 .*doneItems=1 .*terminalOutputBefore=0 .*terminalOutputAfter=1/);
    expect(lines.find(line => line.startsWith("[RESP_EMPTY]"))).toMatch(/reasoningItems=1/);
    expect(lines.join("\n")).not.toContain("never log this");
    log.mockRestore();
  });

  it("uses identical recovery for forced non-streaming JSON", async () => {
    const input = sse([
      { data: { type: "response.output_text.delta", output_index: 0, delta: "json text" } },
      { data: { type: "response.completed", response: { id: "resp_json", model: "gpt-5.6-sol", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } } },
    ]);
    const json = await convertResponsesStreamToJson(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(input)); controller.close(); } }));
    expect(json).toMatchObject({ id: "resp_json", model: "gpt-5.6-sol", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } });
    expect(json.output[0].content[0].text).toBe("json text");

    const completedItem = sse([
      { data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_json", type: "message", role: "assistant", content: [{ type: "output_text", text: "json complete" }] } } },
      { data: { type: "response.completed", response: { id: "resp_json_item", status: "completed", output: [] } } },
    ]);
    const jsonItem = await convertResponsesStreamToJson(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(completedItem)); controller.close(); } }));
    expect(jsonItem.output[0].content[0]).toEqual({ type: "output_text", text: "json complete", annotations: [] });
  });

  it("keeps failed and incomplete terminals terminal without fabricating output", async () => {
    for (const type of ["response.failed", "response.incomplete"]) {
      const input = sse([{ data: { type, response: { id: `resp_${type}`, status: type.slice(9), output: [] } } }]);
      const json = await convertResponsesStreamToJson(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(input)); controller.close(); } }));
      expect(json).toMatchObject({ id: `resp_${type}`, status: type.slice(9), output: [] });
      expect(json.error).toBeNull();
    }
  });

  it("keeps Chat Completions token limits through the real Chat-to-Responses-to-Codex path", () => {
    for (const request of [{ max_tokens: 123 }, { max_completion_tokens: 456 }]) {
      const translated = openaiToOpenAIResponsesRequest("gpt-5.6-sol", {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        ...request,
      }, true);
      expect(translated.max_output_tokens).toBe(Object.values(request)[0]);
      expect(() => new CodexExecutor().transformRequest(translated.model, translated, true, { providerSpecificData: {} })).not.toThrow();
      expect(translated.max_output_tokens).toBeUndefined();
    }
  });

  it("merges include, retains structured output, rejects semantic loss, and reconstructs requested tool calls", () => {
    const executor = new CodexExecutor();
    const request = { model: "gpt-5.6-sol", input: "hi", include: ["foo"], max_output_tokens: 789, text: { format: { type: "json_schema", name: "goal", schema: { type: "object" } } }, stream_tool_calls: true };
    const body = convertResponsesApiFormat(request);
    expect(body).toMatchObject({ include: ["foo"], max_output_tokens: 789, text: request.text, stream_tool_calls: true });
    executor.transformRequest(body.model, body, true, { providerSpecificData: {} });
    expect(body.include).toEqual(["foo", "reasoning.encrypted_content"]);
    expect(body.text.format.name).toBe("goal");
    expect(body.stream_tool_calls).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    try {
      executor.transformRequest("gpt-5.6-sol", convertResponsesApiFormat({ model: "gpt-5.6-sol", input: "hi", previous_response_id: "resp_old" }), true, { providerSpecificData: {} });
      expect.unreachable("semantic loss must reject");
    } catch (error) {
      expect(error.code).toBe("unsupported_feature");
    }
  });
});
