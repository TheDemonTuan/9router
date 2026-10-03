import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildResponseJSON } from "../src/bridge";
import { compileChatGptWebPrompt, formatChatGptWebMultipartStage, formatChatGptWebMultipartCommit } from "../src/adapters/chatgpt-web/prompt";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { decodeCompactionSummary } from "../src/responses/compaction";
const summary = "Synthetic completed checkpoint";
const events: AdapterEvent[] = [{ type: "text_delta", text: summary, phase: "final_answer" }, { type: "done", stopReason: "stop", endTurn: true }];
test("native memento is assistant text while v2 is exactly one ocx1 compaction item", () => {
  const base = { model: "chatgpt-web/gpt-5.6-sol", input: [{ type: "message", role: "user", id: "task", content: "Synthetic task" }] };
  const memento = parseRequest({ ...base, client_metadata: { "x-codex-turn-metadata": { request_kind: "compaction", compaction: { implementation: "responses", strategy: "memento" } } } });
  expect(memento._compactionRequest).toBe(true); expect(memento._compactionResponseFormat).toBe("message");
  const v2 = parseRequest({ ...base, input: [...base.input, { type: "compaction_trigger" }] }); expect(v2._compactionRequest).toBe(true);
  const text = buildResponseJSON(events, base.model); expect(text.output).toEqual([expect.objectContaining({ type: "message", role: "assistant", content: [{ type: "output_text", text: summary, annotations: [] }] })]);
  const compact = buildResponseJSON(events, base.model, { compaction: true });
  if (!Array.isArray(compact.output)) throw new Error("Compaction output must be an array");
  expect(compact.output).toHaveLength(1); expect(compact.output[0]).toMatchObject({ type: "compaction" });
  expect(decodeCompactionSummary(compact.output[0].encrypted_content)).toBe(summary);
});
for (const total of [2, 6] as const) test(`multipart ${total} never grants tools or attachments before final commit`, () => {
  const request: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, context: { messages: [{ role: "user", content: "Synthetic context ".repeat(1000), timestamp: 1 }], tools: [{ name: "fixture_tool", description: "synthetic", parameters: { type: "object" } }] } };
  const prompt = compileChatGptWebPrompt(request, { solAvailable: true, proAvailable: true, extraHighAvailable: true, localToolsEnabled: true }, "turn_fixturecapability1234567890123456789", { experimentalMultipartParts: total });
  expect(prompt.multipart?.parts).toHaveLength(total);
  const multipart = prompt.multipart!;
  const transaction = `ctx_${"a".repeat(32)}`;
  for (const [index, stage] of multipart.parts.slice(0, -1).entries()) {
    const staged = formatChatGptWebMultipartStage(stage, transaction, index + 1, total);
    expect(staged.text).not.toContain("turn_fixturecapability1234567890123456789");
    expect(staged.acknowledgement).toMatch(new RegExp(`^CODEX_MULTIPART_ACK ${transaction} ${index + 1}/${total} [a-f0-9]{64}$`));
  }
  const final = formatChatGptWebMultipartCommit(multipart, transaction);
  expect(final).toContain("turn_fixturecapability1234567890123456789");
});
