import { expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn() }));
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

it.each(["data: [DONE]\n\n", "data:[DONE]", "data: [DONE]\n\ndata: [DONE]\n\n", ""])("emits exactly one terminal sentinel for upstream tail %j", async tail => {
  const content = 'data: {"id":"synthetic","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n' + tail;
  const input = new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(content);
    controller.enqueue(bytes.subarray(0, 7)); controller.enqueue(bytes.subarray(7)); controller.close();
  } });
  const output = await new Response(input.pipeThrough(createPassthroughStreamWithLogger("openai"))).text();
  expect(output).toContain('"content":"hello"');
  expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(output.endsWith("\n\n")).toBe(true);
});
