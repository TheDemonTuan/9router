import { describe, expect, it } from "vitest";
import { inspectSource } from "../../open-sse/token-saver/sourceWalker.js";
import { detectCacheFence } from "../../open-sse/token-saver/cacheFence.js";
import { planSessionDedup, commitSessionDedup } from "../../open-sse/token-saver/sessionDedup.js";
import { compressMessages } from "../../open-sse/rtk/index.js";

const text = "a".repeat(2048);
const inspect = (body, format) => {
  const index = inspectSource(body, format);
  const fence = detectCacheFence(body, index);
  const plan = planSessionDedup(index, { mode: "on", fence });
  return { index, fence, plan };
};
function claude() {
  return { messages: Array.from({ length: 6 }, (_, i) => [
    { role: "user", content: `u${i}` },
    { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: text }] },
  ]).flat() };
}
function gemini(envelope = false) {
  const contents = Array.from({ length: 6 }, (_, i) => [
    { role: "user", parts: [{ text: `u${i}` }] },
    { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: i } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: text } } }] },
  ]).flat();
  return envelope ? { model: "gemini-fixture", request: { contents } } : { contents };
}
function responses() {
  return { input: Array.from({ length: 6 }, (_, i) => [
    { type: "message", role: "user", content: [{ type: "input_text", text: `u${i}` }] },
    { type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: `c${i}`, output: text },
  ]).flat() };
}
function kiro() {
  return { conversationState: { history: Array.from({ length: 6 }, (_, i) => [
    { userInputMessage: { content: [{ text: `u${i}` }] } },
    { assistantResponseMessage: { toolUses: [{ toolUseId: `c${i}`, name: "read_file", input: {} }] } },
    { userInputMessage: { userInputMessageContext: { toolResults: [{ toolUseId: `c${i}`, content: [{ text }] }] } } },
  ]).flat() } };
}
describe("protocol-specific cache and tool result indexing", () => {
  it.each([
    ["claude", claude], ["gemini", () => gemini(false)], ["gemini-cli", () => gemini(true)],
    ["antigravity", () => gemini(true)], ["vertex", () => gemini(false)],
    ["openai-responses", responses], ["openai", responses], ["kiro", kiro],
  ])("deduplicates eligible whole results in %s without moving envelopes", (format, build) => {
    const body = build(); const original = structuredClone(body);
    const { index, plan } = inspect(body, format);
    expect(index.supported).toBe(true);
    expect(index.results.length).toBe(6);
    expect(index.results.map(r => r.callOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    const commit = commitSessionDedup(body, { sourceFormat: format, finalFormat: format, sourceIndex: index, plan });
    expect(commit.appliedResults).toBe(2);
    expect(index.results[0].owner[index.results[0].key]).toBe(text);
    expect(index.results[1].owner[index.results[1].key]).toMatch(/^\[9router dedup:v1 /);
    expect(index.results[3].owner[index.results[3].key]).toBe(text);
    expect(Object.keys(body)).toEqual(Object.keys(original));
  });
  it("fences the full Claude prefix at the last explicit marker", () => {
    const body = claude();
    body.messages[5].content[0].cache_control = { type: "ephemeral" };
    const { fence, index, plan } = inspect(body, "claude");
    expect(fence.hasFence).toBe(true);
    expect(fence.protectAll).toBe(false);
    expect(index.results[0].cacheProtected).toBe(true);
    expect(index.results[1].cacheProtected).toBe(true);
    expect(plan.replacements.length).toBe(1);
  });
  it("does not run RTK on an earlier result fenced by a later block", async () => {
    const log = Array.from({ length: 5 }, (_, i) =>
      `commit ${String(i + 1).padStart(40, "0")}\nAuthor: Fixture\nDate: today\n\n    KEEP_${i}\n${"    detail\n".repeat(20)}\n`).join("");
    const body = { messages: [
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "functions.bash", arguments: '{"command":"git log"}' } }] },
      { role: "tool", tool_call_id: "c", content: log },
      { role: "user", content: [{ type: "text", text: "next", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ] };
    const { index } = inspect(body, "openai");
    expect(index.results[0].cacheProtected).toBe(true);
    const segment = index.textSegments.find(entry => entry.resultIndex === 0);
    const stats = await compressMessages(body, true, { getProtectionReason: (owner, key) => owner === segment.owner && key === segment.key ? "cache_fence" : null });
    expect(body.messages[1].content).toBe(log);
    expect(stats.hits).toHaveLength(0);
  });
  it("distinguishes prompt cache routing hints from explicit OpenAI breakpoints", () => {
    const hint = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], prompt_cache_key: "key" };
    expect(inspect(hint, "openai").fence.hasFence).toBe(false);
    hint.messages[0].content[0].prompt_cache_breakpoint = { mode: "explicit" };
    expect(inspect(hint, "openai").fence.hasFence).toBe(true);
    hint.messages[0].content[0].prompt_cache_breakpoint = { mode: "unknown" };
    expect(inspect(hint, "openai").fence.protectAll).toBe(true);
  });
  it("indexes wrapped Gemini instructions and rejects unknown marker layouts", () => {
    const body = gemini(true);
    body.request.systemInstruction = { parts: [{ text: "prefix", cache_control: { type: "ephemeral" } }] };
    const { index, fence } = inspect(body, "antigravity");
    expect(index.protocolNodes[0].kind).toBe("instruction");
    expect(fence.hasFence).toBe(true);
    expect(fence.protectAll).toBe(true);
    expect(index.results[0].cacheProtected).toBe(true);
  });
  it.each([
    ["gemini", () => ({ ...gemini(), cachedContent: "cached/1" })],
    ["antigravity", () => ({ request: { ...gemini().request, contents: gemini().contents, cachedContent: "cached/1" } })],
    ["openai-responses", () => ({ ...responses(), previous_response_id: "resp_1" })],
  ])("leaves opaque %s state untouched", (format, build) => {
    const body = build(); const { fence } = inspect(body, format);
    expect(fence.reason).toBe("opaque_state");
    expect(fence.protectAll).toBe(true);
  });
  it("scopes encrypted Responses history without changing protocol objects", () => {
    const body = responses();
    body.input = body.input.flatMap(item => item.role === "user" ?
      [item, { type: "reasoning", encrypted_content: "synthetic-encrypted" }] : [item]);
    const before = structuredClone(body);
    const index = inspectSource(body, "openai-responses");
    const fence = detectCacheFence(body, index);
    expect(fence.protectAll).toBe(false);
    expect(fence.protectCurrentTurn).toBe(true);
    expect(fence.blockPromptInjection).toBe(true);
    expect(fence.opaqueReasons).toEqual(["encrypted_reasoning"]);
    expect(index.results.map(r => r.opaqueProtected)).toEqual([false, false, false, true, true, true]);
    expect(index.results.every(r => !r.cacheProtected)).toBe(true);
    expect(index.textSegments.filter(s => s.resultIndex != null).map(s => s.protectedReason)).toEqual(
      [null, null, null, "opaque_state", "opaque_state", "opaque_state"]);
    expect(body).toEqual(before);
  });
  it("predicts Gemini signature replay without fabricating observed state", () => {
    const body = responses();
    body.input = body.input.flatMap(item => item.type === "function_call_output" ? [item, { type: "message", role: "assistant", content: "complete" }] : [item]);
    const index = inspectSource(body, "openai-responses");
    const fence = detectCacheFence(body, index, { targetFormat: "gemini", targetModel: "gemini-fixture" });
    expect(fence.protectAll).toBe(false);
    expect(fence.protectCurrentTurn).toBe(true);
    expect(fence.opaqueReasons).toEqual([]);
    expect(index.results.map(r => r.opaqueProtected)).toEqual([false, false, false, true, true, true]);
  });
  it.each(["claude-fixture", null, "unknown"])("fails closed for Antigravity target %s", targetModel => {
    const body = responses();
    const index = inspectSource(body, "openai-responses");
    expect(detectCacheFence(body, index, { targetFormat: "antigravity", targetModel }).protectAll).toBe(true);
    expect(index.results.every(r => r.opaqueProtected)).toBe(true);
  });
  it.each(["thinking", "redacted_thinking"])("keeps Claude %s prefix global", type => {
    const body = claude();
    body.messages[1].content.unshift(type === "thinking" ? { type, signature: "synthetic" } : { type, data: "synthetic" });
    const { fence, index } = inspect(body, "claude");
    expect(fence.protectAll).toBe(true);
    expect(fence.opaqueReasons).toEqual(["claude_thinking_signature"]);
    expect(index.results.every(r => r.opaqueProtected && !r.cacheProtected)).toBe(true);
  });
  it("retains cache prefix protection alongside local signed state", () => {
    const body = responses();
    body.input[0].prompt_cache_breakpoint = { mode: "explicit" };
    body.input.splice(1, 0, { type: "reasoning", encrypted_content: "synthetic" });
    const { fence, index } = inspect(body, "openai-responses");
    expect(fence.hasFence).toBe(true);
    expect(fence.protectAll).toBe(false);
    expect(index.results[5].opaqueProtected).toBe(true);
  });
  it("does not scope opaque fields on arbitrary results or root config", () => {
    const body = responses();
    body.input[2].encrypted_content = "synthetic";
    expect(inspect(body, "openai-responses").fence.protectAll).toBe(true);
    delete body.input[2].encrypted_content;
    body.generationConfig = { thoughtSignature: "synthetic" };
    expect(inspect(body, "openai-responses").fence.protectAll).toBe(true);
  });
  it("commits exactly two encrypted Responses results without mutating source or reasoning items", () => {
    const source = responses();
    source.input = source.input.flatMap(item => item.role === "user" ? [item, { type: "reasoning", encrypted_content: "synthetic" }] : [item]);
    const before = structuredClone(source);
    const { index, plan } = inspect(source, "openai-responses");
    const final = structuredClone(source);
    const commit = commitSessionDedup(final, { sourceFormat: "openai-responses", finalFormat: "openai-responses", sourceIndex: index, plan });
    const results = inspectSource(final, "openai-responses").results;
    expect(commit.appliedResults).toBe(2);
    expect(commit.bytesSaved).toBe(2 * (2048 - Buffer.byteLength(results[1].text)));
    expect(results.map(r => r.text.startsWith("[9router dedup:v1 "))).toEqual([false, true, true, false, false, false]);
    expect(final.input.filter(i => i.type === "reasoning")).toEqual(before.input.filter(i => i.type === "reasoning"));
    expect(source).toEqual(before);
  });
  it("preserves every batch in a signed Gemini current turn", () => {
    const body = gemini();
    body.contents = [body.contents[0], ...body.contents.filter(m => m.role === "model" || m.parts.some(p => p.functionResponse))];
    for (const message of body.contents) if (message.role === "model") message.parts[0].thoughtSignature = "synthetic";
    const before = structuredClone(body);
    const { fence, index, plan } = inspect(body, "gemini");
    expect(fence.protectAll).toBe(false);
    expect(plan.stats.protected.opaque).toBe(6);
    expect(plan.replacements).toEqual([]);
    expect(index.results.every(r => r.opaqueProtected)).toBe(true);
    expect(body).toEqual(before);
  });
  it.each(["previous_response_id", "conversation", "cached_content", "cachedContent"])("keeps root %s state request-wide", key => {
    const body = responses();
    body[key] = "synthetic";
    const { fence, index, plan } = inspect(body, "openai-responses");
    expect(fence.protectAll).toBe(true);
    expect(fence.blockPromptInjection).toBe(true);
    expect(plan.replacements).toEqual([]);
    expect(index.results.every(r => r.opaqueProtected)).toBe(true);
  });
  it.each(["compaction", "compaction_trigger"])("keeps protocol %s global", type => {
    const body = responses(); body.input.unshift({ type });
    expect(inspect(body, "openai-responses").fence.protectAll).toBe(true);
  });
  it.each(["", {}, 4])("does not scope malformed encrypted state %#", encrypted_content => {
    const body = responses(); body.input.splice(1, 0, { type: "reasoning", encrypted_content });
    expect(inspect(body, "openai-responses").fence.protectAll).toBe(true);
  });
  it("fails closed when signed history has no genuine user turn", () => {
    const body = responses(); body.input = body.input.filter(i => i.role !== "user");
    body.input.unshift({ type: "reasoning", encrypted_content: "synthetic" });
    expect(inspect(body, "openai-responses").fence.protectAll).toBe(true);
  });
  it("does not mistake a Chat result type for a Responses reasoning item", () => {
    const body = { messages: Array.from({ length: 6 }, (_, i) => [
      { role: "user", content: `u${i}` },
      { role: "assistant", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `c${i}`, content: text },
    ]).flat() };
    Object.assign(body.messages.at(-1), { type: "reasoning", encrypted_content: "synthetic" });
    const { fence, plan } = inspect(body, "openai");
    expect(fence.protectAll).toBe(true);
    expect(plan.replacements).toEqual([]);
  });
});
