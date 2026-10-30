import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveUsageHistory: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse, handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

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

const providerUsageFixture = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 50 };
const usageEvents = () => textEvents.map(event => event.type === "message_start"
  ? { ...event, message: { ...event.message, usage: { ...providerUsageFixture, output_tokens: 0 } } }
  : event.type === "message_delta" ? { ...event, usage: { output_tokens: 50 } } : event);

describe("Claude provider usage fidelity", () => {
  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])("never estimates a cache-only %s response", async field => {
    const complete = vi.fn();
    const input = usageEvents().map(event => event.type === "message_start"
      ? { ...event, message: { ...event.message, usage: { input_tokens: 0, output_tokens: 0, [field]: 30 } } }
      : event.type === "message_delta" ? { ...event, usage: { output_tokens: 0 } } : event);
    const stream = new ReadableStream({ start(c) { c.enqueue(wire(input)); c.close(); } }).pipeThrough(createSSEStream({ targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI, provider: "claude", model: "claude-sonnet-4-6", onStreamComplete: complete }));
    const output = parse(await new Response(stream).text()).find(event => event.usage).usage;
    expect(output).toMatchObject({ prompt_tokens: 30, completion_tokens: 0, total_tokens: 30 });
    expect(output.estimated).toBeUndefined();
    const accounting = canonicalizeUsage(complete.mock.calls[0][1]);
    expect(accounting.prompt_tokens).toBe(30);
    expect(accounting[field === "cache_read_input_tokens" ? "cached_tokens" : field]).toBe(30);
  });
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("keeps canonical TTL accounting after streaming translation to %s", async sourceFormat => {
    const complete = vi.fn();
    const stream = new ReadableStream({ start(c) { c.enqueue(wire(usageEvents())); c.close(); } }).pipeThrough(createSSEStream({ targetFormat: FORMATS.CLAUDE, sourceFormat, provider: "claude", model: "claude-sonnet-4-6", onStreamComplete: complete }));
    await new Response(stream).text();
    expect(canonicalizeUsage(complete.mock.calls[0][1])).toMatchObject({ prompt_tokens: 330, completion_tokens: 50, total_tokens: 380, cached_tokens: 200, cache_creation_input_tokens: 30, cache_creation: providerUsageFixture.cache_creation });
  });
  it("keeps raw TTL accounting before forced Claude SSE becomes Responses JSON", async () => {
    saveRequestUsage.mockClear();
    const result = await handleNonStreamingResponse({ providerResponse: new Response(wire(usageEvents()), { headers: { "content-type": "text/event-stream" } }), provider: "claude", model: "claude-sonnet-4-6", sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.CLAUDE, body: {}, requestStartTime: Date.now(), trackDone() {}, appendLog() {} });
    const output = await result.response.json();
    expect(output.usage).toEqual({ input_tokens: 330, output_tokens: 50, total_tokens: 380, input_tokens_details: { cached_tokens: 200 } });
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({ prompt_tokens: 330, cached_tokens: 200, cache_creation_input_tokens: 30, cache_creation: providerUsageFixture.cache_creation });
  });
  it.each([FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("projects JSON usage without a buffer for %s", async sourceFormat => {
    const message = { id: "msg_usage", type: "message", role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: "answer" }], usage: structuredClone(providerUsageFixture) };
    const result = await handleNonStreamingResponse({ providerResponse: Response.json(message), provider: "claude", model: message.model, sourceFormat, targetFormat: FORMATS.CLAUDE, body: {}, requestStartTime: Date.now(), trackDone() {}, appendLog() {} });
    const output = await result.response.json();
    if (sourceFormat === FORMATS.CLAUDE) expect(output.usage).toEqual(providerUsageFixture);
    else if (sourceFormat === FORMATS.OPENAI) expect(output.usage).toMatchObject({ prompt_tokens: 330, completion_tokens: 50, total_tokens: 380, prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 30 } });
    else expect(output.usage).toEqual({ input_tokens: 330, output_tokens: 50, total_tokens: 380, input_tokens_details: { cached_tokens: 200 } });
  });
  it.each([FORMATS.CLAUDE, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("preserves provider SSE counters for %s", async sourceFormat => {
    const stream = new ReadableStream({ start(c) { c.enqueue(wire(usageEvents())); c.close(); } }).pipeThrough(createSSEStream({ targetFormat: FORMATS.CLAUDE, sourceFormat, provider: "claude", model: "claude-sonnet-4-6" }));
    const events = parse(await new Response(stream).text());
    if (sourceFormat === FORMATS.CLAUDE) {
      expect(events.find(e => e.type === "message_start").message.usage).toEqual({ ...providerUsageFixture, output_tokens: 0 });
      expect(events.find(e => e.type === "message_delta").usage).toEqual({ output_tokens: 50 });
    } else if (sourceFormat === FORMATS.OPENAI) expect(events.find(e => e.usage)?.usage).toMatchObject({ prompt_tokens: 330, completion_tokens: 50, total_tokens: 380, prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 30 } });
    else expect(terminal(events)[0].response.usage).toEqual({ input_tokens: 330, output_tokens: 50, total_tokens: 380, input_tokens_details: { cached_tokens: 200 } });
  });
});

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
