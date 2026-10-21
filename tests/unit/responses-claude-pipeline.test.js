import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveUsageHistory: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}),
}));
import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

const encoder = new TextEncoder();
const start = { type: "message_start", message: { id: "msg_pipeline", model: "claude-test", role: "assistant", content: [], usage: { input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 0 } } };
const textEvents = [start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Việt 😀" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];
const wire = (events) => encoder.encode(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
const parse = (text) => text.split(/\r?\n/).filter(l => l.startsWith("data: ") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(6)));
const transform = (onStreamComplete = null) => createSSEStream({ targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI_RESPONSES, provider: "claude", model: "claude-test", onStreamComplete });
async function run(bytes, fragment = bytes.length) {
  let offset = 0;
  const source = new ReadableStream({ pull(c) { if (offset === bytes.length) { c.close(); return; } c.enqueue(bytes.slice(offset, offset += Math.min(fragment, bytes.length - offset))); } });
  return parse(await new Response(source.pipeThrough(transform())).text());
}
const terminal = events => events.filter(e => ["response.completed", "response.incomplete", "response.failed"].includes(e.type));

describe("Responses client through actual Claude SSE pipeline", () => {
  it("turns an upstream SSE error after HTTP 200 into exactly one failure", async () => {
    const events = await run(wire([start, { type: "error", error: { type: "overloaded_error", message: "busy" } }]));
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({ type: "response.failed", response: { status: "failed", error: { message: expect.stringContaining("busy") } } });
  });
  it("reports clean EOF without message_stop as failure, including ping-only streams", async () => {
    for (const input of [[start], [{ type: "ping" }]]) {
      const events = await run(wire(input));
      expect(terminal(events)).toHaveLength(1);
      expect(terminal(events)[0].type).toBe("response.failed");
    }
  });
  it("keeps output and lifecycle invariant across every single-byte UTF-8 split", async () => {
    const events = await run(wire(textEvents), 1);
    expect(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("")).toBe("Việt 😀");
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({ type: "response.completed", response: { output: [{ type: "message", content: [{ text: "Việt 😀" }] }] } });
  });
  it("reports max_tokens as incomplete rather than completed", async () => {
    const input = textEvents.map(e => e.type === "message_delta" ? { ...e, delta: { stop_reason: "max_tokens" } } : e);
    const events = await run(wire(input));
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
  });
  it("surfaces Anthropic refusal explanation as a Responses refusal content block", async () => {
    const explanation = "Violates safety restrictions";
    const events = await run(wire([
      start,
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation } }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]));
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: explanation }] }],
      },
    });
  });
  it("emits text and finalizes accounting before upstream EOF", async () => {
    let source;
    const completed = vi.fn();
    const stream = new ReadableStream({ start(c) { source = c; } }).pipeThrough(transform(completed));
    const reader = stream.getReader();
    source.enqueue(wire(textEvents));
    const observed = [];
    while (!terminal(observed).length) {
      const { value } = await reader.read();
      observed.push(...parse(new TextDecoder().decode(value)));
    }
    expect(observed.find(e => e.type === "response.output_text.delta")?.delta).toBe("Việt 😀");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][3]).toMatchObject({ status: "completed", successful: true });
    source.close();
    while (!(await reader.read()).done) {}
    expect(completed).toHaveBeenCalledTimes(1);
  });
  it("returns Responses JSON rather than Chat Completions for stream:false", () => {
    const result = translateNonStreamingResponse({ id: "msg_json", model: "claude-test", type: "message", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 5, output_tokens: 3 } }, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(result).toMatchObject({ object: "response", status: "incomplete", output: [{ type: "message", content: [{ text: "partial" }] }] });
    expect(result.choices).toBeUndefined();
  });
  it("uses Responses failure framing on a transport failure without a second terminal", async () => {
    let source;
    const upstream = new Response(new ReadableStream({ start(c) { source = c; } }));
    const t = transform();
    const control = createStreamController({ provider: "offline", model: "claude-test" });
    const output = pipeWithDisconnect(upstream, t, control, message => t.abortTerminal(message), 1000, { heartbeatIntervalMs: 0 });
    const reading = new Response(output).text();
    source.enqueue(wire([start]));
    await new Promise(resolve => setTimeout(resolve, 10));
    source.error(new Error("socket hang up"));
    const events = parse(await reading);
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({ type: "response.failed", response: { id: events[0].response.id, status: "failed" } });
    expect(events.some(e => e.error && !e.type)).toBe(false);
  });
  it("separates raw byte activity from content progress and enforces explicit contentStallTimeoutMs on ping-only streams", async () => {
    let source;
    const completed = vi.fn();
    const stream = new ReadableStream({ start(c) { source = c; } }).pipeThrough(
      createSSEStream({
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "claude",
        model: "claude-test",
        onStreamComplete: completed,
        contentStallTimeoutMs: 20,
      })
    );
    const consuming = new Response(stream).text();
    source.enqueue(wire([start]));
    await new Promise(resolve => setTimeout(resolve, 30));
    source.enqueue(wire([{ type: "ping" }]));
    source.close();
    const events = parse(await consuming);
    expect(terminal(events)).toHaveLength(1);
    expect(terminal(events)[0]).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "stream_content_stall", message: "Stream content progress timeout" },
      },
    });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][2]).toBeNull();
    expect(completed.mock.calls[0][3]).toMatchObject({ status: "failed", successful: false, pingCount: 1 });
  });
  it("keeps direct Responses-to-Claude streaming overhead within sub-millisecond budget vs native Messages passthrough", async () => {
    const schedule = [
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step 1" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_bench" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello benchmark" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_bench", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"test"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const payload = wire(schedule);
    const runStream = async (sourceFormat) => {
      const t0 = performance.now();
      const s = new ReadableStream({
        start(c) {
          c.enqueue(payload);
          c.close();
        },
      }).pipeThrough(
        createSSEStream({
          targetFormat: FORMATS.CLAUDE,
          sourceFormat,
          provider: "claude",
          model: "claude-test",
        })
      );
      await new Response(s).text();
      return performance.now() - t0;
    };
    const nativeSamples = [];
    const directSamples = [];
    for (let i = 0; i < 25; i++) {
      nativeSamples.push(await runStream(FORMATS.CLAUDE));
      directSamples.push(await runStream(FORMATS.OPENAI_RESPONSES));
    }
    nativeSamples.sort((a, b) => a - b);
    directSamples.sort((a, b) => a - b);
    const p50Direct = directSamples[Math.floor(directSamples.length * 0.5)];
    const p95Direct = directSamples[Math.floor(directSamples.length * 0.95)];
    expect(p50Direct).toBeLessThan(15);
    expect(p95Direct).toBeLessThan(35);
  });
});
