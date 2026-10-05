import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../open-sse/utils/usageTracking.js", async (importOriginal) => ({
  ...await importOriginal(),
  logUsage: vi.fn(),
}));

import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const FINISH_CHUNK = {
  id: "chatcmpl-fixture",
  choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
};
const USAGE_TRAILER = {
  choices: [],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
};

function pipe(options = {}) {
  let source;
  const onCancel = vi.fn();
  const input = new ReadableStream({
    start(controller) { source = controller; },
    cancel: onCancel,
  });
  const onStreamComplete = vi.fn();
  const releasePending = vi.fn();
  const reader = input.pipeThrough(createSSEStream({
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    provider: "fixture-provider",
    model: "fixture-model",
    onStreamComplete,
    releasePending,
    ...options,
  })).getReader();
  const events = [];
  const decoder = new TextDecoder();
  let failure;
  // Start reading immediately: merely closing the upstream and then reading cannot
  // prove that the watchdog emitted while the HTTP connection was still open.
  const finished = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            events.push(JSON.parse(line.slice(6)));
          }
        }
      }
    } catch (error) { failure = error; }
  })();
  return {
    source, reader, events, finished, onCancel, onStreamComplete, releasePending,
    failure: () => failure,
    send: (chunk) => source.enqueue(encoder.encode(
      typeof chunk === "string" ? chunk : `data: ${JSON.stringify(chunk)}\n\n`,
    )),
    completed: () => events.filter((event) => event.type === "response.completed"),
  };
}

describe("pending response.completed watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits exactly once at 3000ms before a stalled upstream closes", async () => {
    const stream = pipe();
    stream.send(FINISH_CHUNK);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.completed()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2999);
    expect(stream.completed()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.completed()).toHaveLength(1);
    expect(stream.completed()[0].response).toMatchObject({
      object: "response", status: "completed",
      output: [{ type: "message", status: "completed", content: [{ text: "hi" }] }],
    });
    expect(stream.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(stream.releasePending).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stream.send(USAGE_TRAILER);
    stream.send("data: [DONE]\n\n");
    stream.source.close();
    await stream.finished;
    expect(stream.completed()).toHaveLength(1);
    expect(stream.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(stream.releasePending).toHaveBeenCalledTimes(1);
  });

  it("completes on real usage and clears the timer before a consumer disconnects", async () => {
    const stream = pipe();
    stream.send(FINISH_CHUNK);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    stream.send(USAGE_TRAILER);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.completed()).toHaveLength(1);
    expect(stream.completed()[0].response.usage).toEqual({
      input_tokens: 120, output_tokens: 30, total_tokens: 150,
    });
    expect(vi.getTimerCount()).toBe(0);
    await stream.reader.cancel("fixture disconnect after terminal");
    await stream.finished;
    await vi.advanceTimersByTimeAsync(10000);
    expect(stream.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(stream.releasePending).toHaveBeenCalledTimes(1);
    expect(stream.completed()).toHaveLength(1);
  });

  it.each(["DONE", "EOF"])("flushes at %s without waiting for the watchdog", async (ending) => {
    const stream = pipe();
    stream.send(FINISH_CHUNK);
    await vi.advanceTimersByTimeAsync(0);
    if (ending === "DONE") stream.send("data: [DONE]\n\n");
    else stream.source.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.completed()).toHaveLength(1);
    expect(stream.completed()[0].response).not.toHaveProperty("usage");
    expect(vi.getTimerCount()).toBe(0);
    if (ending === "DONE") stream.source.close();
    await stream.finished;
    expect(stream.onStreamComplete).toHaveBeenCalledTimes(1);
    expect(stream.releasePending).toHaveBeenCalledTimes(1);
  });

  it("clears a pending timer on consumer cancellation without logging successful completion", async () => {
    const stream = pipe();
    stream.send(FINISH_CHUNK);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await stream.reader.cancel("fixture consumer abort");
    await stream.finished;
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.completed()).toHaveLength(0);
    expect(stream.onStreamComplete).not.toHaveBeenCalled();
  });

  it("clears a pending timer when the upstream body errors", async () => {
    const stream = pipe();
    stream.send(FINISH_CHUNK);
    await vi.advanceTimersByTimeAsync(0);
    const error = new Error("fixture upstream failure");
    stream.source.error(error);
    await stream.finished;
    await vi.advanceTimersByTimeAsync(10000);
    expect(stream.failure()).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(stream.completed()).toHaveLength(0);
    expect(stream.onStreamComplete).not.toHaveBeenCalled();
  });

  it("preserves schema-validation failure metadata on deferred completion", async () => {
    const stream = pipe({ responseSchemaValidation: { type: "object", required: ["ok"] } });
    stream.send({ ...FINISH_CHUNK, choices: [{ index: 0, delta: { content: "{}" }, finish_reason: "stop" }] });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(stream.completed()).toHaveLength(1);
    expect(stream.onStreamComplete.mock.calls[0][3]).toMatchObject({
      status: "failed", successful: false,
      message: expect.stringContaining("missing required property ok"),
    });
    stream.source.close();
    await stream.finished;
    expect(stream.onStreamComplete).toHaveBeenCalledTimes(1);
  });
});
