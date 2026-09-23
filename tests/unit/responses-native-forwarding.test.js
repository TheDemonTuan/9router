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
      await writer.close();
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
