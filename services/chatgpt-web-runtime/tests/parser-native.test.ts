import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildResponseJSON, bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

test("readable agent_message preserves native author/recipient and encrypted V2 is marked unsupported", () => {
  const readable = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", input: [{ type: "agent_message", id: "agent-task", author: "/root", recipient: "/root/reviewer", content: [{ type: "input_text", text: "Synthetic child request" }] }] });
  expect(readable.context.messages).toEqual([expect.objectContaining({ role: "agentMessage", author: "/root", recipient: "/root/reviewer" })]);
  const message = readable.context.messages[0];
  const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
  expect(text).toBe("Synthetic child request");
  const encrypted = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", input: [{ type: "agent_message", id: "encrypted-task", author: "/root", recipient: "/root/reviewer", content: [{ type: "encrypted_content", encrypted_content: "opaque-cross-backend" }] }] });
  expect(encrypted._opaqueMultiAgentV2Payload).toBe(true);
});
test("namespaced function and freeform tools preserve native output identities", () => {
  const events: AdapterEvent[] = [{ type: "tool_call_start", id: "call-native", name: "fixture__read" }, { type: "tool_call_delta", arguments: '{"path":"synthetic.txt"}' }, { type: "tool_call_end" }, { type: "tool_call_start", id: "call-patch", name: "apply_patch" }, { type: "tool_call_delta", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) }, { type: "tool_call_end" }, { type: "done", stopReason: "toolUse", endTurn: false }];
  const response = buildResponseJSON(events, "chatgpt-web/gpt-5.6-sol", { toolNsMap: new Map([["fixture__read", { namespace: "fixture", name: "read" }]]), freeformToolNames: new Set(["apply_patch"]) });
  expect(response.output).toEqual([expect.objectContaining({ type: "function_call", call_id: "call-native", namespace: "fixture", name: "read", arguments: '{"path":"synthetic.txt"}' }), expect.objectContaining({ type: "custom_tool_call", call_id: "call-patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" })]);
});
test("stream carries reasoning, commentary and final phases with one completed terminal", async () => {
  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { type: "thinking_delta", thinking: "Synthetic public reasoning summary" };
    yield { type: "text_delta", text: "Checking synthetic fixture", phase: "commentary" };
    yield { type: "text_delta", text: "Synthetic final answer", phase: "final_answer" };
    yield { type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true } };
  }
  const text = await new Response(bridgeToResponsesSSE(events(), "chatgpt-web/gpt-5.6-sol")).text();
  const wire = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  expect(wire.filter(event => event.type === "response.completed")).toHaveLength(1);
  const completed = wire.find(event => event.type === "response.completed").response;
  expect(completed.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: "reasoning" }), expect.objectContaining({ type: "message", phase: "commentary" }), expect.objectContaining({ type: "message", phase: "final_answer" })]));
  expect(completed.usage).toMatchObject({ total_tokens: 15, estimated: true });
});
