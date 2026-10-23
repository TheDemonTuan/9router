import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb.js";
import { buildOnStreamComplete, buildTransformStream, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.js";

const encode = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);
const created = { type: "response.created", response: { id: "resp_smoke", status: "in_progress" } };
const tool = { type: "response.output_item.added", output_index: 0, item: { id: "fc_smoke", type: "function_call", call_id: "call_smoke", name: "todo", arguments: "" } };

function progressPipeline(dialect) {
  let source;
  let cancels = 0;
  const outcomes = [];
  const upstream = new ReadableStream({ start(c) { source = c; }, cancel() { cancels++; } });
  const transform = buildTransformStream({
    provider: "codex", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
    responsesProviderDialect: dialect, model: "gpt-5.5",
    onStreamComplete(_content, _usage, _ttft, outcome) { outcomes.push(outcome); },
  });
  const control = createStreamController({ log: { errorLine() {} } });
  const output = pipeWithDisconnect({ body: upstream }, transform, control,
    message => transform.abortTerminal(message), 500,
    { heartbeatIntervalMs: 0, progressState: transform.progressState, progressTimeoutMs: 60 });
  return { source, output, outcomes, upstream, cancels: () => cancels };
}

async function read(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

describe("native Responses forwarding", () => {
  for (const dialect of ["standard-openai", "codex"]) {
    it(`rejects keepalive/metadata-only progress after a partial tool (${dialect})`, async () => {
      vi.useFakeTimers();
      try {
        const p = progressPipeline(dialect);
        const result = read(p.output);
        p.source.enqueue(encode(created));
        p.source.enqueue(encode(tool));
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(15);
          if (p.cancels()) break;
          p.source.enqueue(new TextEncoder().encode(': keepalive\r\n\r\ndata: {"type":"response.in_progress"}\r\n\r\ndata: {"type":"codex.response.metadata"}\r\n\r\ndata: {"type":"response.created","response":{"id":"resp_smoke"}}\r\n\r\ndata: [DONE]\r\n\r\n'));
        }
        const text = await result;
        const failure = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith("data: ") && line.includes('"type":"response.failed"')).slice(6));
        expect(failure.response).toMatchObject({ id: "resp_smoke", status: "failed", output: [], error: { code: "stream_disconnected", message: "upstream Responses stream made no progress" } });
        expect(text.match(/"type":"response.failed"/g)).toHaveLength(1);
        expect(text).not.toContain("response.completed");
        expect(text).not.toContain('"type":"response.output_item.done"');
        expect(p.cancels()).toBe(1);
        expect(p.outcomes).toEqual([{ status: "failed", successful: false }]);
        expect(p.upstream.locked).toBe(false);
      } finally { vi.useRealTimers(); }
    });

    it(`allows reasoning and argument progress beyond the budget (${dialect})`, async () => {
      vi.useFakeTimers();
      try {
        const p = progressPipeline(dialect);
        const result = read(p.output);
        p.source.enqueue(encode(created));
        p.source.enqueue(encode(tool));
        for (let i = 0; i < 18; i++) {
          await vi.advanceTimersByTimeAsync(15);
          p.source.enqueue(encode({ type: i % 2 ? "response.function_call_arguments.delta" : "response.reasoning_text.delta", delta: "x", item_id: "fc_smoke", output_index: 0 }));
        }
        p.source.enqueue(encode({ type: "response.function_call_arguments.done", item_id: "fc_smoke", output_index: 0, arguments: '{"op":"init"}' }));
        p.source.enqueue(encode({ type: "response.output_item.done", output_index: 0, item: { ...tool.item, arguments: '{"op":"init"}', status: "completed" } }));
        p.source.enqueue(encode({ type: "response.completed", response: { id: "resp_smoke", status: "completed", output: [] } }));
        await vi.advanceTimersByTimeAsync(0);
        const text = await result;
        expect(text).toContain("call_smoke");
        expect(text).toContain('"name":"todo"');
        expect(text).toContain('"arguments":"{\\"op\\":\\"init\\"}"');
        expect(text).not.toContain("stream_disconnected");
        expect(p.outcomes).toEqual([{ status: "completed", successful: true }]);
        expect(p.cancels()).toBe(1);
      } finally { vi.useRealTimers(); }
    });

    it.each(["EOF", "ECONNRESET"])(`fails a partial tool without authorizing execution (${dialect}, %s)`, async cause => {
      const p = progressPipeline(dialect);
      const result = read(p.output);
      p.source.enqueue(encode(created));
      p.source.enqueue(encode(tool));
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cause === "EOF") p.source.close();
      else p.source.error(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
      const text = await result;
      expect(text.match(/"type":"response.failed"/g)).toHaveLength(1);
      expect(text).toContain('"id":"resp_smoke"');
      expect(text).not.toContain('"type":"response.output_item.done"');
      expect(text).not.toContain('"status":"completed"');
      expect(p.outcomes).toEqual([{ status: "failed", successful: false }]);
      expect(p.upstream.locked).toBe(false);
    });
  }

  it("preserves fragmented native UTF-8/CRLF and trailing bytes in the terminal chunk", async () => {
    const p = progressPipeline("standard-openai");
    const result = read(p.output);
    const input = new TextEncoder().encode('data: {"type":"response.reasoning_text.delta","delta":"Việt"}\r\n\r\ndata: {"type":"response.completed","response":{"id":"resp_smoke","status":"completed"}}\r\n\r\n: trailing\r\n\r\n');
    const split = input.indexOf(0xe1) + 1;
    p.source.enqueue(input.slice(0, split));
    p.source.enqueue(input.slice(split, input.length - 17));
    p.source.enqueue(input.slice(input.length - 17));
    expect(await result).toBe(new TextDecoder().decode(input));
    expect(p.cancels()).toBe(1);
  });
  it.each(["standard-openai", "codex"])("closes an open upstream at each terminal (%s)", async (dialect) => {
    for (const type of ["response.completed", "response.done", "response.failed", "response.incomplete", "error"]) {
      let cancels = 0;
      let successes = 0;
      const outcomes = [];
      const status = ["response.completed", "response.done"].includes(type) ? "completed" : type === "response.incomplete" ? "incomplete" : "failed";
      const wire = `data: ${JSON.stringify({ type, response: { id: "resp_smoke", status, output: [], usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`;
      const result = await handleStreamingResponse({
        providerResponse: new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(wire)); }, cancel() { cancels++; },
        }), { headers: { "content-type": "text/event-stream" } }),
        provider: "codex", model: "gpt-5.5", sourceFormat: FORMATS.OPENAI_RESPONSES,
        targetFormat: FORMATS.OPENAI_RESPONSES, responsesProviderDialect: dialect,
        body: {}, translatedBody: {}, requestStartTime: Date.now(),
        streamController: { signal: new AbortController().signal, isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {} },
        onRequestSuccess() { successes++; }, onStreamComplete(_c, _u, _t, outcome) { outcomes.push(outcome); },
      });
      expect(successes).toBe(0);
      const text = await read(result.response.body);
      expect(text).toContain(`"type":"${type}"`);
      expect(text).not.toContain("stream_disconnected");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(cancels).toBe(1);
      expect(successes).toBe(status === "completed" ? 1 : 0);
      expect(outcomes).toEqual([{ status, successful: status === "completed" }]);
    }
  });
  it("forwards unknown data-only events byte-for-byte", async () => {
    const input = "id: 7\r\nevent: response.future\r\ndata: {\"type\":\"response.future\",\"opaque\":{\"x\":1}}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\r\n\r\n";
    const transform = buildTransformStream({
      provider: "codex",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      model: "gpt-5.5",
    });
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input.slice(0, 37)));
        controller.enqueue(new TextEncoder().encode(input.slice(37)));
        controller.close();
      },
    });
    expect(await read(upstream.pipeThrough(transform))).toBe(input);
  });

  it("appends a failure when a native stream ends without terminal event", async () => {
    const transform = buildTransformStream({
      provider: "codex",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      model: "gpt-5.5",
    });
    const output = await read(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        controller.close();
      },
    }).pipeThrough(transform));
    expect(output).toContain('"type":"response.failed"');
    expect(output).toContain('"model":"gpt-5.5"');
  });

  it("propagates safe Codex headers and only marks completed streams successful", async () => {
    for (const [status, expectedSuccess] of [["completed", 1], ["failed", 0], ["incomplete", 0]]) {
      let successes = 0;
      const providerResponse = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: `response.${status}`, response: { status } })}\n\n`));
          controller.close();
        },
      }), {
        headers: { "content-type": "text/event-stream", "x-request-id": "req_123", "x-codex-turn-state": "turn_456", "set-cookie": "never-forward" },
      });
      const result = await handleStreamingResponse({
        providerResponse, provider: "codex", model: "gpt-5.5", sourceFormat: FORMATS.OPENAI_RESPONSES,
        targetFormat: FORMATS.OPENAI_RESPONSES, body: {}, stream: true, translatedBody: {}, requestStartTime: Date.now(),
        streamController: { isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {}, signal: new AbortController().signal },
        onRequestSuccess: () => { successes++; }, streamDetailId: `test-${status}`,
      });
      await read(result.response.body);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(successes).toBe(expectedSuccess);
      expect(result.response.headers.get("x-request-id")).toBe("req_123");
      expect(result.response.headers.get("x-codex-turn-state")).toBe("turn_456");
      expect(result.response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("uses supplied upstream-header time for HDR, not the post-peek handler time", async () => {
    const events = [];
    const response = new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
    const result = await handleStreamingResponse({
      providerResponse: response, provider: "codex", model: "gpt-5.5",
      sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
      requestStartTime: 1000, upstreamHeadersAt: 1900, body: {}, translatedBody: {},
      streamController: { isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {}, signal: new AbortController().signal },
      onStreamComplete: (_content, _usage, _ttft, _outcome, metrics) => events.push(metrics),
    });
    await read(result.response.body);
    expect(events[0].hdrAt - 1000).toBe(900);
    const missing = [];
    const plain = await handleStreamingResponse({
      providerResponse: new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } }),
      provider: "codex", model: "gpt-5.5", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
      requestStartTime: 1000, body: {}, translatedBody: {},
      streamController: { isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {}, signal: new AbortController().signal },
      onStreamComplete: (_content, _usage, _ttft, _outcome, metrics) => missing.push(metrics),
    });
    await read(plain.response.body);
    expect(missing[0].hdrAt).toBeNull();
  });

  it("finalizes usage, request detail, and pending state for every terminal outcome", () => {
    for (const [outcome, expectedStatus] of [
      [{ status: "completed", successful: true }, "success"],
      [{ status: "failed", successful: false }, "error"],
      [{ status: "incomplete", successful: false }, "error"],
    ]) {
      vi.clearAllMocks();
      const { onStreamComplete } = buildOnStreamComplete({
        provider: "codex", model: "gpt-5.5", connectionId: "connection-1", requestStartTime: Date.now(),
        body: { model: "gpt-5.5" }, stream: true, translatedBody: {}, streamDetailId: `test-${outcome.status}`,
      });
      onStreamComplete({ content: "partial", thinking: "" }, { prompt_tokens: 7, completion_tokens: 3 }, Date.now(), outcome);
      expect(trackPendingRequest).toHaveBeenCalledWith("gpt-5.5", "codex", "connection-1", false);
      expect(saveRequestDetail).toHaveBeenCalledWith(expect.objectContaining({
        status: expectedStatus,
        tokens: { prompt_tokens: 7, completion_tokens: 3 },
      }));
      if (outcome.successful) expect(appendRequestLog).not.toHaveBeenCalled();
      else expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: outcome.status }));
    }
  });

  it("records TTFT only when the first text delta arrives", async () => {
    let now = 100;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const events = [];
      const transform = buildTransformStream({
        provider: "codex", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES,
        model: "gpt-5.5", onStreamComplete: (_content, _usage, ttft) => events.push(ttft),
      });
      const output = read(transform.readable);
      const writer = transform.writable.getWriter();
      await writer.write(new TextEncoder().encode('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'));
      now = 250;
      await writer.write(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
      now = 300;
      await writer.write(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
      expect(await output).toContain('response.output_text.delta');
      expect(events).toEqual([250]);
    } finally {
      Date.now = realNow;
    }
  });

  it("logs ERROR/INCOMPLETE instead of DONE for failed terminal streams", () => {
    const log = { line: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "codex", model: "gpt-5.5", connectionId: "connection-1", requestStartTime: Date.now(),
      body: {}, stream: true, translatedBody: {}, reqTag: "test", log,
    });
    onStreamComplete({ content: "partial" }, null, Date.now(), { status: "incomplete", successful: false });
    expect(log.line).toHaveBeenCalledWith("test", "✗", expect.stringContaining("INCOMPLETE"));
    expect(log.line.mock.calls[0][2]).not.toContain("DONE");
  });

  it("records terminal usage and distinguishes completed from failed/incomplete/EOF", async () => {
    for (const [type, status, successful] of [
      ["response.completed", "completed", true],
      ["response.failed", "failed", false],
      ["response.incomplete", "incomplete", false],
    ]) {
      const events = [];
      const transform = buildTransformStream({
        provider: "codex",
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        model: "gpt-5.5",
        onStreamComplete: (content, usage, _ttft, outcome) => events.push({ content, usage, outcome }),
      });
      await read(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, response: { status, usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`));
          controller.close();
        },
      }).pipeThrough(transform));
      expect(events).toEqual([{
        content: { content: "", thinking: "" },
        usage: { prompt_tokens: 7, completion_tokens: 3 },
        outcome: { status, successful },
      }]);
    }

    const eofEvents = [];
    const eofTransform = buildTransformStream({
      provider: "codex",
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      model: "gpt-5.5",
      onStreamComplete: (_content, _usage, _ttft, outcome) => eofEvents.push(outcome),
    });
    await read(new ReadableStream({ start: c => c.close() }).pipeThrough(eofTransform));
    expect(eofEvents).toEqual([{ status: "failed", successful: false }]);
  });
});
