import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { buildTransformStream } from "../../open-sse/handlers/chatCore/streamingHandler.js";

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
});
