import { describe, expect, it } from "vitest";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import {
  buildResponseSnapshot,
  openAICompletionToResponses,
  normalizeResponsesUsage,
  buildOutputArray
} from "../../open-sse/transformer/responsesBuilder.js";
import { formatIncompleteOpenAIResponsesStreamFailure } from "../../open-sse/utils/responsesStreamHelpers.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

async function runTransformStream(chunks, options = {}) {
  const transform = createResponsesApiTransformStream(options);
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  const outputStream = readable.pipeThrough(transform);
  const reader = outputStream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  const events = [];
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed || trimmed === "data: [DONE]") continue;
    const evMatch = trimmed.match(/^event:\s*(.+)$/m);
    const dataMatch = trimmed.match(/^data:\s*(.+)$/m);
    if (evMatch && dataMatch) {
      try {
        events.push({ event: evMatch[1].trim(), data: JSON.parse(dataMatch[1].trim()) });
      } catch {}
    }
  }
  return events;
}

describe("Canonical Responses builder & transformers", () => {
  it("1. Chat upstream → Responses stream text with model and sequence numbers", async () => {
    const chunks = [
      { id: "chatcmpl-1", model: "gpt-4.5-turbo", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { id: "chatcmpl-1", model: "gpt-4.5-turbo", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { id: "chatcmpl-1", model: "gpt-4.5-turbo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
    ];

    const events = await runTransformStream(chunks, { model: "gpt-4.5-turbo" });
    const created = events.find((e) => e.event === "response.created");
    const inProgress = events.find((e) => e.event === "response.in_progress");
    const completed = events.find((e) => e.event === "response.completed");
    const itemAdded = events.find((e) => e.event === "response.output_item.added");
    const itemDone = events.find((e) => e.event === "response.output_item.done");

    expect(created).toBeDefined();
    expect(created.data.response.object).toBe("response");
    expect(created.data.response.model).toBe("gpt-4.5-turbo");
    expect(created.data.response.status).toBe("in_progress");
    expect(Array.isArray(created.data.response.output)).toBe(true);
    expect(created.data.sequence_number).toBe(1);

    expect(inProgress).toBeDefined();
    expect(inProgress.data.response.model).toBe("gpt-4.5-turbo");
    expect(inProgress.data.sequence_number).toBe(2);

    expect(itemAdded.data.item.status).toBe("in_progress");
    expect(itemDone.data.item.status).toBe("completed");

    expect(completed).toBeDefined();
    expect(completed.data.response.object).toBe("response");
    expect(completed.data.response.model).toBe("gpt-4.5-turbo");
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.output).toHaveLength(1);
    expect(completed.data.response.output[0].status).toBe("completed");
    expect(completed.data.response.output[0].content[0].text).toBe("Hello world");
    expect(completed.data.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    });
  });

  it("2. Chat upstream → Responses non-stream text", () => {
    const chatResponse = {
      id: "chatcmpl-nonstream",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Non-stream answer" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
    };

    const responsesObj = openAICompletionToResponses(chatResponse);
    expect(responsesObj.object).toBe("response");
    expect(responsesObj.model).toBe("gpt-4o");
    expect(responsesObj.status).toBe("completed");
    expect(responsesObj.output).toHaveLength(1);
    expect(responsesObj.output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Non-stream answer" }]
    });
    expect(responsesObj.usage).toEqual({
      input_tokens: 15,
      output_tokens: 5,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    });
  });

  it("3. reasoning stream emits items with status and populates completed.output", async () => {
    const chunks = [
      { id: "chatcmpl-rs", model: "o3-mini", choices: [{ index: 0, delta: { reasoning_content: "Thinking..." }, finish_reason: null }] },
      { id: "chatcmpl-rs", model: "o3-mini", choices: [{ index: 0, delta: { content: "Result" }, finish_reason: null }] },
      { id: "chatcmpl-rs", model: "o3-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ];

    const events = await runTransformStream(chunks, { model: "o3-mini" });
    const reasoningAdded = events.find((e) => e.event === "response.output_item.added" && e.data.item.type === "reasoning");
    const reasoningDone = events.find((e) => e.event === "response.output_item.done" && e.data.item.type === "reasoning");
    const completed = events.find((e) => e.event === "response.completed");

    expect(reasoningAdded.data.item.status).toBe("in_progress");
    expect(reasoningDone.data.item.status).toBe("completed");
    expect(reasoningDone.data.item.summary[0].text).toBe("Thinking...");

    expect(completed.data.response.output).toHaveLength(2);
    expect(completed.data.response.output[0].type).toBe("reasoning");
    expect(completed.data.response.output[0].status).toBe("completed");
    expect(completed.data.response.output[1].type).toBe("message");
    expect(completed.data.response.output[1].status).toBe("completed");
  });

  it("4. function_call stream with arguments and completed status", async () => {
    const chunks = [
      { id: "chatcmpl-fc", model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
      { id: "chatcmpl-fc", model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"loc\":\"Hanoi\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-fc", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ];

    const events = await runTransformStream(chunks, { model: "gpt-4o" });
    const fcAdded = events.find((e) => e.event === "response.output_item.added");
    const fcDone = events.find((e) => e.event === "response.output_item.done");
    const completed = events.find((e) => e.event === "response.completed");

    expect(fcAdded.data.item.status).toBe("in_progress");
    expect(fcDone.data.item.status).toBe("completed");
    expect(fcDone.data.item.call_id).toBe("call_abc");
    expect(fcDone.data.item.arguments).toBe("{\"loc\":\"Hanoi\"}");

    expect(completed.data.response.output).toHaveLength(1);
    expect(completed.data.response.output[0].status).toBe("completed");
    expect(completed.data.response.output[0].name).toBe("get_weather");
  });

  it("5. multiple function calls in stream", async () => {
    const chunks = [
      { id: "chatcmpl-mfc", model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "fn1", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-mfc", model: "gpt-4o", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "fn2", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-mfc", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ];

    const events = await runTransformStream(chunks, { model: "gpt-4o" });
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed.data.response.output).toHaveLength(2);
    expect(completed.data.response.output[0].name).toBe("fn1");
    expect(completed.data.response.output[1].name).toBe("fn2");
  });

  it("6. usage-only final chunk is captured into response.completed", async () => {
    const chunks = [
      { id: "chatcmpl-usage", model: "gpt-4o", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      { id: "chatcmpl-usage", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chatcmpl-usage", model: "gpt-4o", choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }
    ];

    const events = await runTransformStream(chunks, { model: "gpt-4o" });
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeDefined();
    expect(completed.data.response.usage).toEqual({
      input_tokens: 30,
      output_tokens: 10,
      total_tokens: 40,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    });
  });

  it("7. aborted / incomplete synthetic failure produces schema-compliant response", () => {
    const sse = formatIncompleteOpenAIResponsesStreamFailure("gpt-4o-mini");
    const jsonMatch = sse.match(/^data:\s*(.+)$/m);
    const data = JSON.parse(jsonMatch[1]);

    expect(data.type).toBe("response.failed");
    expect(data.response.object).toBe("response");
    expect(data.response.status).toBe("failed");
    expect(data.response.model).toBe("gpt-4o-mini");
    expect(Array.isArray(data.response.output)).toBe(true);
    expect(data.response.error).toMatchObject({
      type: "stream_error",
      code: "stream_disconnected"
    });
  });

  it("8. streamToJsonConverter parses SSE into complete Responses JSON object", async () => {
    const encoder = new TextEncoder();
    const rawSSE = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123","object":"response","created_at":1700000000,"status":"in_progress","model":"gpt-4o"}}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123","object":"response","created_at":1700000000,"status":"completed","model":"gpt-4o","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      'data: [DONE]'
    ].join("\n\n");

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(rawSSE));
        controller.close();
      }
    });

    const json = await convertResponsesStreamToJson(readable);
    expect(json.id).toBe("resp_123");
    expect(json.object).toBe("response");
    expect(json.model).toBe("gpt-4o");
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1);
    expect(json.output[0].content[0].text).toBe("hello");
    expect(json.usage).toEqual({
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    });
  });

  it("9. empty content / stop finishes cleanly without throwing", async () => {
    const chunks = [
      { id: "chatcmpl-empty", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ];

    const events = await runTransformStream(chunks, { model: "gpt-4o" });
    const completed = events.find((e) => e.event === "response.completed");
    expect(completed).toBeDefined();
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.output).toEqual([]);
    expect(completed.data.response.model).toBe("gpt-4o");
  });

  it("10. translator response/openai-responses emits complete response with model", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.model = "gpt-4o-trans";

    const chunk1 = {
      id: "chatcmpl-trans",
      model: "gpt-4o-trans",
      choices: [{ index: 0, delta: { content: "test" }, finish_reason: null }]
    };
    const chunk2 = {
      id: "chatcmpl-trans",
      model: "gpt-4o-trans",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    };

    const ev1 = openaiToOpenAIResponsesResponse(chunk1, state);
    const ev2 = openaiToOpenAIResponsesResponse(chunk2, state);
    const allEvents = [...ev1, ...ev2];

    const created = allEvents.find((e) => e.event === "response.created");
    const completed = allEvents.find((e) => e.event === "response.completed");

    expect(created.data.response.model).toBe("gpt-4o-trans");
    expect(completed.data.response.model).toBe("gpt-4o-trans");
    expect(completed.data.response.status).toBe("completed");
    expect(completed.data.response.output[0].status).toBe("completed");
    expect(completed.data.response.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16
    });
  });
});
