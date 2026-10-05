import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../open-sse/utils/usageTracking.js", async (importOriginal) => ({
  ...await importOriginal(),
  logUsage: vi.fn(),
}));

import "../translator/registerAll.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { logUsage } from "../../open-sse/utils/usageTracking.js";

const usage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  total_tokens: 999,
  prompt_tokens_details: { cached_tokens: 40 },
  completion_tokens_details: { reasoning_tokens: 10 },
};
const expectedUsage = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens_details: { reasoning_tokens: 10 },
};
const text = (content) => ({ id: "chatcmpl-fixture", choices: [{ index: 0, delta: { content } }] });
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const terminal = (events) => events.filter((event) => event.event === "response.completed");

async function consume(chunks, tail = "\n\n") {
  const encoder = new TextEncoder();
  const onStreamComplete = vi.fn();
  const releasePending = vi.fn();
  const input = new ReadableStream({
    start(controller) {
      const frames = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + tail;
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  const output = input.pipeThrough(createSSEStream({
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    provider: "fixture-provider",
    model: "fixture-model",
    onStreamComplete,
    releasePending,
  }));
  const result = await new Response(output).text();
  const events = result.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => ({ event: JSON.parse(line.slice(6)).type, data: JSON.parse(line.slice(6)) }));
  return { events, onStreamComplete, releasePending };
}

describe("canonical Responses completion with deferred usage", () => {
  it("preserves the separate logging usage state while accepting a usage-only trailer", () => {
    const loggingUsage = { prompt_tokens: 17, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 8 } };
    const state = { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI, usage: loggingUsage };
    openaiToOpenAIResponsesResponse(text("hello"), state);
    expect(terminal(openaiToOpenAIResponsesResponse(finish, state))).toEqual([]);
    expect(state.completionPending).toBe(true);
    const completed = terminal(openaiToOpenAIResponsesResponse({ choices: [], usage }, state));
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.usage).toEqual(expectedUsage);
    expect(state.usage).toBe(loggingUsage);
    expect(state.completionPending).toBe(false);
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
    expect(openaiToOpenAIResponsesResponse(text("late text"), state)).toEqual([]);
  });

  it("keeps reasoning, text, and parallel tool IDs at their canonical output indices", () => {
    const state = { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI };
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: "think" } }] },
      text("answer"),
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "call_fixture_a", function: { name: "lookup_a", arguments: "{}" } },
        { index: 1, id: "call_fixture_b", function: { name: "lookup_b", arguments: '{"key":1}' } },
      ] } }] },
      finish,
      { choices: [], usage },
    ];
    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.filter((event) => event.event === "response.output_item.added");
    const done = events.filter((event) => event.event === "response.output_item.done");
    expect(added.map((event) => event.data.output_index)).toEqual([0, 1, 2, 3]);
    expect(done.map((event) => event.data.output_index)).toEqual([0, 1, 2, 3]);
    const response = terminal(events)[0].data.response;
    expect(response.output).toEqual(done.map((event) => event.data.item));
    expect(response.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call", "function_call"]);
    expect(response.output.slice(2).map((item) => item.call_id)).toEqual(["call_fixture_a", "call_fixture_b"]);
    expect(response).toMatchObject({
      object: "response", status: "completed", error: null, incomplete_details: null,
      tool_choice: "auto", tools: [], metadata: {}, usage: expectedUsage,
    });
    expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index + 1));
  });

  it.each(["\n\n", ""])("accepts an empty-choices usage trailer with EOF framing %j", async (tail) => {
    vi.mocked(logUsage).mockClear();
    const { events, onStreamComplete, releasePending } = await consume([
      { ...text("hello"), usage: { prompt_tokens: 0, completion_tokens: 0 } },
      { ...finish, usage: { prompt_tokens: 0, completion_tokens: 0 } },
      { choices: [], usage },
    ], tail);
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0].data.response.usage).toEqual(expectedUsage);
    expect(events.at(-1).event).toBe("response.completed");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][1]).toMatchObject({
      prompt_tokens: 120, completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage.mock.calls[0][1]).toEqual(onStreamComplete.mock.calls[0][1]);
    expect(releasePending).toHaveBeenCalledTimes(1);
  });

  it("completes immediately when the finish chunk carries real usage", async () => {
    const { events, onStreamComplete } = await consume([text("hello"), { ...finish, usage }]);
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0].data.response.usage).toEqual(expectedUsage);
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });
});
