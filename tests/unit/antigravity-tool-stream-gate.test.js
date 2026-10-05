import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveUsageHistory: vi.fn(async () => {}), saveUsageStats: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/utils/usageTracking.js", async (original) => ({ ...(await original()), logUsage: vi.fn() }));
import "../translator/registerAll.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { prepareAntigravityToolValidation } from "../../open-sse/translator/concerns/antigravityToolValidation.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { getGeminiThoughtSignatureSync } from "../../open-sse/services/thoughtSignatureStore.js";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const frame = (parts, finishReason = "STOP") => ({ response: { responseId: "resp_synthetic", modelVersion: "claude-opus-5-5-high", candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } });
const call = (args, name = "probe", id = "call_synthetic") => ({ functionCall: { name, id, args }, thoughtSignature: "synthetic-signature" });
const context = () => prepareAntigravityToolValidation([{ name: "probe", parameters: schema }]);
async function stream(frames, source = "openai-responses", split = false) {
  const ctx = await context();
  const text = frames.map(value => typeof value === "string" ? value : `data: ${JSON.stringify(value)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const complete = vi.fn();
  const release = vi.fn();
  const upstream = new ReadableStream({ start(controller) { if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes); controller.close(); } });
  const output = upstream.pipeThrough(createSSETransformStreamWithLogger("antigravity", source, "antigravity", null, null, "claude-opus-5-5-high", null, {}, complete, null, null, null, null, release, ctx));
  return { text: await new Response(output).text(), complete, release };
}
function handlerContext(providerResponse, ctx, sourceFormat = "openai-responses") {
  return { providerResponse, provider: "antigravity", model: "claude-opus-5-5-high", sourceFormat, targetFormat: "antigravity", body: {}, stream: false, toolArgumentValidation: ctx, requestStartTime: Date.now(), trackDone: vi.fn(), appendLog: vi.fn(), onRequestSuccess: vi.fn(), reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() } };
}
describe("Antigravity canonical client gate", () => {
  it.each([{ value: 1 }, {}, "{\"value\":\"ok\"}", null, []])("never emits invalid call arguments %j", async (args) => {
    const result = await stream([frame([call(args)])]);
    expect(result.text.match(/event: response.failed/g)).toHaveLength(1);
    expect(result.text).toContain('"code":"invalid_tool_arguments"');
    expect(result.text).not.toContain("response.completed");
    expect(result.text).not.toContain("function_call_arguments");
    expect(result.text).not.toContain("response.output_item.added");
    expect(result.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(result.complete.mock.calls[0][3]).toMatchObject({ successful: false });
  });
  it("validates all parallel calls before emitting any call in their chunk", async () => {
    const result = await stream([frame([call({ value: "ok" }, "probe", "first"), call({ value: 1 }, "probe", "second")])]);
    expect(result.text).not.toContain("first");
    expect(result.text).not.toContain("function_call_arguments");
    expect(result.text).toContain("response.failed");
  });
  it("preserves text, call id, typed arguments, usage through byte splits and EOF without newline", async () => {
    const last = frame([call({ value: "đúng" })]);
    const result = await stream([frame([{ text: "Xin chào" }], null), `data: ${JSON.stringify(last)}`], "openai-responses", true);
    expect(result.text).toContain("Xin chào");
    expect(result.text).toContain("call_synthetic");
    expect(result.text).toContain("đúng");
    expect(getGeminiThoughtSignatureSync("call_synthetic", null, "claude-opus-5-5-high")).toBe("synthetic-signature");
    expect(result.text).toContain("response.completed");
    expect(result.text).not.toContain("response.failed");
  });
  it.each(["openai", "claude", "antigravity"])("fails closed for native/client %s", async (source) => {
    const result = await stream([frame([call({ value: "ok" }, "unknown")])], source);
    expect(result.text).toContain("failed validation");
    expect(result.text).not.toContain('"functionCall"');
    expect(result.text).not.toContain('"tool_calls"');
    if (source === "claude") expect(result.text).toContain("event: error");
    if (source === "antigravity") expect(result.text).not.toContain("[DONE]");
  });
  it.each(["data: {broken\n\n", `data: ${JSON.stringify(frame([{ text: "partial" }], null))}`])("rejects malformed or unterminated upstream frame", async (raw) => {
    const result = await stream([raw]);
    expect(result.text).toContain("response.failed");
    expect(result.text).not.toContain("response.completed");
  });
  it.each(["json", "sse", "forced-sse", "native-json"])("invalid %s returns terminal 502 without success callback", async (transport) => {
    const ctx = await context();
    const raw = frame([call({ value: 42 })]);
    const sse = transport.includes("sse");
    const response = new Response(sse ? `data: ${JSON.stringify(raw)}\n\n` : JSON.stringify(raw), { headers: { "content-type": sse ? "text/event-stream" : "application/json" } });
    const options = handlerContext(response, ctx, transport.startsWith("native") ? "antigravity" : "openai-responses");
    const result = await (transport === "forced-sse" ? handleForcedSSEToJson(options) : handleNonStreamingResponse(options));
    expect(result.response.status).toBe(502);
    expect(result.terminalNoFallback).toBe(true);
    expect(options.onRequestSuccess).not.toHaveBeenCalled();
    expect(await result.response.text()).toContain("failed validation");
  });
  it.each(["json", "sse", "forced-sse"])("valid %s keeps executable original call", async (transport) => {
    const ctx = await context();
    const raw = frame([call({ value: "ok" })]);
    const sse = transport.includes("sse");
    const options = handlerContext(new Response(sse ? `data: ${JSON.stringify(raw)}` : JSON.stringify(raw), { headers: { "content-type": sse ? "text/event-stream" : "application/json" } }), ctx);
    const result = await (transport === "forced-sse" ? handleForcedSSEToJson(options) : handleNonStreamingResponse(options));
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    const item = body.output.find(item => item.type === "function_call");
    expect(item.call_id).toBe("call_synthetic");
    expect(JSON.parse(item.arguments)).toEqual({ value: "ok" });
    expect(body.status).toBe("completed");
  });
  it.each([null, true, "unexpected", [], { choices: [{ delta: { tool_calls: [{ function: { name: "probe", arguments: '{"value":123}' } }] } }] }])("fails parsed non-native SSE %j with one canonical terminal", async (parsed) => {
    const result = await stream([`data: ${JSON.stringify(parsed)}\n\n`]);
    expect(result.text.match(/event: response.failed/g)).toHaveLength(1);
    expect(result.text).toContain('"code":"invalid_tool_arguments"');
    expect(result.text).not.toContain("response.completed");
    expect(result.text).not.toContain("function_call_arguments");
    expect(result.text).not.toContain("[DONE]");
  });
  it("rejects alternate OpenAI JSON instead of passing unchecked executable calls", async () => {
    const ctx = await context();
    const options = handlerContext(Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "wrong-envelope", type: "function", function: { name: "probe", arguments: '{"value":123}' } }] } }] }), ctx, "openai");
    const result = await handleNonStreamingResponse(options);
    expect(result.response.status).toBe(502);
    expect(result.terminalNoFallback).toBe(true);
    expect(options.onRequestSuccess).not.toHaveBeenCalled();
    expect(await result.response.text()).not.toContain("wrong-envelope");
  });
  it("keeps native candidate alternatives separate when SSE is aggregated", async () => {
    const ctx = await context();
    const first = frame([call({ value: "first" }, "probe", "candidate-a")]);
    first.response.candidates.push({ index: 1, content: { role: "model", parts: [call({ value: "second" }, "probe", "candidate-b")] }, finishReason: "STOP" });
    const options = handlerContext(new Response(`data: ${JSON.stringify(first)}\n\n`, { headers: { "content-type": "text/event-stream" } }), ctx, "antigravity");
    const result = await handleNonStreamingResponse(options);
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.response.candidates.map(candidate => ({ index: candidate.index, calls: candidate.content.parts.filter(part => part.functionCall).map(part => part.functionCall.id) }))).toEqual([{ index: 0, calls: ["candidate-a"] }, { index: 1, calls: ["candidate-b"] }]);
  });
  it("finalizes successful Responses accounting before a terminal-closing client cancels", async () => {
    const ctx = await context();
    const upstream = new TransformStream();
    const writer = upstream.writable.getWriter();
    const complete = vi.fn();
    const release = vi.fn();
    const reader = upstream.readable.pipeThrough(createSSETransformStreamWithLogger("antigravity", "openai-responses", "antigravity", null, null, "claude-opus-5-5-high", null, {}, complete, null, null, null, null, release, ctx)).getReader();
    const writing = writer.write(new TextEncoder().encode(`data: ${JSON.stringify(frame([call({ value: "ok" })]))}\n\n`)).catch(() => {});
    let output = "";
    while (!output.includes("response.completed")) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      output += new TextDecoder().decode(part.value);
    }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][3]).toBeUndefined();
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    await reader.cancel();
    await writing;
    await writer.abort().catch(() => {});
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
