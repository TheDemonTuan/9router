import { expect, it, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), trackPendingRequest: vi.fn() }));
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
const error = { code: "agent_tool_choice_unsatisfied", type: "runtime_error", message: "Required tool choice was not satisfied", retryable: false };
const record = (type, response) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const created = record("response.created", { id: "resp_fixture", status: "in_progress" });
const failed = record("response.failed", { id: "resp_fixture", status: "failed", output: [], error });
const context = providerResponse => ({ providerResponse, sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI_RESPONSES, provider: "chatgpt-web", model: "gpt-5.6-sol", body: {}, requestStartTime: Date.now(), trackDone: vi.fn(), appendLog: vi.fn() });
it.each(["failed", "disconnected", "transport"])("nonstream %s preserves terminal no-fallback instead of a successful completion", async kind => {
  const body = kind === "transport" ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(created)); }, pull(controller) { controller.error(new Error("offline transport interruption")); } }) : created + (kind === "failed" ? failed : "");
  const result = await handleForcedSSEToJson(context(new Response(body, { headers: { "content-type": "text/event-stream", "x-9router-no-fallback": "true" } })));
  expect(result.success).toBe(false);
  expect(result.terminalNoFallback).toBe(true);
  expect(result.response.status).toBe(502);
  expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
  const json = await result.response.json();
  expect(json.error).toMatchObject({ code: kind === "failed" ? error.code : "submission_unknown", retryable: false });
  expect(json).not.toHaveProperty("choices");
});
it("streaming Chat exposes a structured failure without an assistant error answer or successful finish", async () => {
  const input = new Response(created + failed).body;
  const output = await new Response(input.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "chatgpt-web", null, null, "gpt-5.6-sol"))).text();
  const frames = output.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
  expect(frames.find(frame => frame.error)?.error).toEqual(error);
  expect(frames.some(frame => frame.choices?.[0]?.finish_reason)).toBe(false);
  expect(output).not.toContain("[Error]");
});
it("native Responses keeps its failed terminal envelope and safe error code", async () => {
  const ctx = context(new Response(created + failed, { headers: { "content-type": "text/event-stream", "x-9router-no-fallback": "true" } }));
  ctx.sourceFormat = FORMATS.OPENAI_RESPONSES;
  const result = await handleForcedSSEToJson(ctx);
  expect(result.response.status).toBe(200);
  expect(await result.response.json()).toMatchObject({ status: "failed", error });
});
