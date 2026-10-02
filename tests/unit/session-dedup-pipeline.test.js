import { describe, it, expect, vi } from "vitest";
import "../translator/registerAll.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {},
  logConvertedResponse() {}, logError() {},
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest() {}, appendRequestLog: async () => {},
  saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getTokenSaverSnapshot, recordTokenSaverPreparation } = await import("../../open-sse/token-saver/state.js");
const { getRtkSnapshot } = await import("../../open-sse/rtk/state.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { inspectSource } = await import("../../open-sse/token-saver/sourceWalker.js");
const { detectCacheFence } = await import("../../open-sse/token-saver/cacheFence.js");
const { planSessionDedup, commitSessionDedup } = await import("../../open-sse/token-saver/sessionDedup.js");
const { codexOutput } = await import("../fixtures/compression-coverage.js");
function fixture() {
  const messages = [];
  for (let i = 0; i < 6; i++) messages.push(
    { role: "user", content: `turn ${i}` },
    { role: "assistant", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(2048) },
  );
  return { model: "gpt-4o-mini", stream: false, messages };
}
async function run(body, mode, options = {}) {
  let dispatched;
  execute.mockImplementation(async ({ body: upstream }) => {
    dispatched = structuredClone(upstream);
    return { response: new Response(JSON.stringify({ id: "t", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { headers: { "content-type": "application/json" } }), url: "https://example.test/v1/chat/completions", headers: {}, transformedBody: upstream };
  });
  const result = await handleChatCore({ body, sessionDedupMode: mode,
    modelInfo: { provider: "openai", model: "gpt-4o-mini" }, credentials: { apiKey: "synthetic", providerSpecificData: {} },
    connectionId: "synthetic", rtkEnabled: false, pxpipeEnabled: false, ...options,
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
  });
  expect(result.success).toBe(true);
  return dispatched;
}
describe("session dedup dispatch", () => {
  it("detects v2 replay inside the exact Responses single-text codec before RTK changes its anchor", () => {
    const repeated = "synthetic log line\n".repeat(100);
    const source = { input: Array.from({ length: 6 }, (_, i) => [
      { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic ${i}` }] },
      { type: "function_call", call_id: `exec${i}`, name: "exec_command", arguments: '{"cmd":"docker logs synthetic"}' },
      { type: "function_call_output", call_id: `exec${i}`, output: i === 1 ? [{ type: "input_text", text: codexOutput(repeated, "b") }] : codexOutput(i === 0 ? repeated : `different${i}`.repeat(200), `${i}`) },
    ]).flat() };
    const index = inspectSource(source, "openai-responses");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(source, index) });
    const final = translateRequest("openai-responses", "openai", "gpt-4o", source, false);
    expect(commitSessionDedup(final, { sourceFormat: "openai-responses", finalFormat: "openai", sourceIndex: index, plan }).bodyAppliedResults).toBe(1);
    const replay = planSessionDedup(inspectSource(final, "openai"), { mode: "on" });
    expect(replay.hasExistingMarkers).toBe(true);
  });
  it("proves different raw envelopes through Gemini translation and recognizes v2 replay", () => {
    const body = fixture();
    for (const [i, message] of body.messages.entries()) {
      if (message.role === "assistant") message.tool_calls[0].function = { name: "exec_command", arguments: '{"cmd":"bun test"}' };
      if (message.role === "tool") message.content = codexOutput("x".repeat(2048), `chunk${i}`);
    }
    body.messages = body.messages.flatMap(m => m.role === "tool" ? [m, { role: "assistant", content: "complete" }] : [m]);
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index, { targetFormat: "gemini" }) });
    const translated = translateRequest("openai", "gemini", "gemini-2.5-pro", body, false);
    const baseline = structuredClone(translated);
    const commit = commitSessionDedup(translated, { sourceFormat: "openai", finalFormat: "gemini", targetModel: "gemini-2.5-pro", sourceIndex: index, plan });
    expect(commit.bodyAppliedResults).toBe(2);
    const output = inspectSource(translated, "gemini").results;
    for (const i of [0, 3, 4, 5]) expect(output[i].resultContainer).toEqual(inspectSource(baseline, "gemini").results[i].resultContainer);
    expect(output[1].resultContainer.response.result.result).toContain("[9router dedup:v2 ");
    expect(planSessionDedup(inspectSource(translated, "gemini"), { mode: "on" }).hasExistingMarkers).toBe(true);
  });
  it("keeps the canonical result and recent history raw while shadow only measures", async () => {
    const body = fixture();
    const before = structuredClone(body);
    const shadow = await run(body, "shadow");
    expect(shadow.messages).toEqual(before.messages);
    const active = await run(body, "on");
    expect(body).toEqual(before);
    expect(active.messages[2].content).toBe(before.messages[2].content);
    expect(active.messages[5].content).toMatch(/^\[9router dedup:v1 /);
    expect(active.messages[8].content).toBe(active.messages[5].content);
    for (const i of [11, 14, 17]) expect(active.messages[i]).toEqual(before.messages[i]);
    const stats = getTokenSaverSnapshot().usage;
    expect(stats.plannedResults).toBeGreaterThanOrEqual(2);
    expect(stats.plannedSaveBytes).toBeGreaterThanOrEqual(1);
    expect(stats.wouldDedupResults).toBeGreaterThanOrEqual(2);
    expect(stats.appliedResults).toBeGreaterThanOrEqual(2);
  });
  it("protects translated Claude cache and commits old Gemini results without changing signatures", () => {
    const body = fixture();
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });

    // Real Claude translation sets cache_control on tool definitions / messages
    const claudeTranslated = translateRequest("openai", "claude", "claude-3-5-sonnet", body, false);
    const claudeCommit = commitSessionDedup(claudeTranslated, { sourceFormat: "openai", finalFormat: "claude", sourceIndex: index, plan });
    expect(claudeCommit.appliedResults).toBe(0);
    expect(claudeCommit.skipReason).toBe("final_cache_fence");

    // A final assistant answer separates a tool-response wrapper from the next genuine user turn.
    const geminiSource = { ...body, messages: body.messages.flatMap(m => m.role === "tool" ? [m, { role: "assistant", content: "complete" }] : [m]) };
    const geminiIndex = inspectSource(geminiSource, "openai");
    const geminiPlan = planSessionDedup(geminiIndex, { mode: "on", fence: detectCacheFence(geminiSource, geminiIndex, { targetFormat: "gemini" }) });
    const geminiTranslated = translateRequest("openai", "gemini", "gemini-2.5-pro", geminiSource, false);
    const baseline = structuredClone(geminiTranslated);
    const geminiCommit = commitSessionDedup(geminiTranslated, { sourceFormat: "openai", finalFormat: "gemini", targetModel: "gemini-2.5-pro", sourceIndex: geminiIndex, plan: geminiPlan });
    expect(geminiCommit.appliedResults).toBe(2);
    expect(geminiCommit.skipReason).toBe(null);
    const results = inspectSource(geminiTranslated, "gemini").results;
    expect(results[0].resultContainer).toEqual(inspectSource(baseline, "gemini").results[0].resultContainer);
    expect(results[1].resultContainer.response.result.result).toMatch(/^\[9router dedup:v1 /);
    const modelParts = value => value.contents.filter(m => m.role === "model");
    expect(modelParts(geminiTranslated)).toEqual(modelParts(baseline));
    expect(geminiTranslated.contents.slice(-9)).toEqual(baseline.contents.slice(-9));
  });
  it("proves positive cross-format marker dispatch on Responses→Chat without signed/cached state", () => {
    const responsesBody = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "query" }] },
      ],
    };
    for (let i = 0; i < 6; i++) {
      responsesBody.input.push(
        { type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: `c${i}`, output: "x".repeat(2048) },
      );
    }
    const index = inspectSource(responsesBody, "openai-responses");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(responsesBody, index) });
    expect(plan.replacements.length).toBe(3);

    const chatTranslated = translateRequest("openai-responses", "openai", "gpt-4o", responsesBody, false);
    const commit = commitSessionDedup(chatTranslated, { sourceFormat: "openai-responses", finalFormat: "openai", sourceIndex: index, plan });
    expect(commit.appliedResults).toBe(3);
    const toolOutputs = chatTranslated.messages.filter(m => m.role === "tool");
    expect(toolOutputs[0].content).toBe("x".repeat(2048));
    expect(toolOutputs[1].content).toMatch(/^\[9router dedup:v1 /);
    expect(toolOutputs[2].content).toMatch(/^\[9router dedup:v1 /);
    expect(toolOutputs[3].content).toMatch(/^\[9router dedup:v1 /);
    expect(toolOutputs[4].content).toBe("x".repeat(2048));
    expect(toolOutputs[5].content).toBe("x".repeat(2048));
  });
  it("rejects a missing same-family anchor even if another tool preserved the same text", () => {
    const body = fixture(); const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    const translated = translateRequest("openai", "claude", "claude-3-5-sonnet", body, false);
    translated.messages.splice(2, 1);
    const before = structuredClone(translated);
    const commit = commitSessionDedup(translated, { sourceFormat: "openai", finalFormat: "claude", sourceIndex: index, plan });
    expect(commit.skipReason).toBe("final_correspondence");
    expect(commit.appliedResults).toBe(0);
    expect(translated).toEqual(before);
  });
  it("declines an oversized JSON codec before writing any marker using synthetic unsigned Gemini", () => {
    const body = fixture();
    const original = "x".repeat(900_000);
    for (const message of body.messages) if (message.role === "tool") message.content = original;
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    expect(plan.replacements.length).toBe(2);

    const syntheticGemini = {
      contents: [
        { role: "user", parts: [{ text: "turn 0" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c0", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c0", response: { result: { result: original } } } }] },
        { role: "user", parts: [{ text: "turn 1" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c1", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c1", response: { result: { result: original } } } }] },
        { role: "user", parts: [{ text: "turn 2" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c2", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c2", response: { result: { result: original } } } }] },
        { role: "user", parts: [{ text: "turn 3" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c3", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c3", response: { result: { result: original } } } }] },
        { role: "user", parts: [{ text: "turn 4" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c4", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c4", response: { result: { result: original } } } }] },
        { role: "user", parts: [{ text: "turn 5" }] },
        { role: "model", parts: [{ functionCall: { name: "read_file", id: "c5", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", id: "c5", response: { result: { result: original } } } }] },
      ],
    };
    const result = commitSessionDedup(syntheticGemini, { sourceFormat: "openai", finalFormat: "gemini", sourceIndex: index, plan });
    expect(result.skipReason).toBe("final_budget");
    expect(result.appliedResults).toBe(0);
    expect(syntheticGemini.contents[2].parts[0].functionResponse.response.result.result).toBe(original);
  });
  it("dispatches exactly two old encrypted-history replacements with immutable caller input", async () => {
    const body = fixture();
    for (const message of body.messages) if (message.role === "assistant") message.reasoning = { encrypted_content: "synthetic-encrypted" };
    const before = structuredClone(body);
    const statsBefore = getTokenSaverSnapshot().usage;
    const active = await run(body, "on");
    expect(body).toEqual(before);
    for (const i of [2, 11, 14, 17]) expect(active.messages[i]).toEqual(before.messages[i]);
    for (const i of [5, 8]) expect(active.messages[i].content).toMatch(/^\[9router dedup:v1 /);
    expect(active.messages.filter(m => m.role === "assistant")).toEqual(before.messages.filter(m => m.role === "assistant"));
    const stats = getTokenSaverSnapshot().usage;
    expect(stats.appliedResults - statsBefore.appliedResults).toBe(2);
    expect(stats.skippedPreparations.opaque_state - statsBefore.skippedPreparations.opaque_state).toBe(0);
  });
  it("keeps the complete signed current-turn chain while unsigned intra-turn behavior remains", () => {
    const body = fixture();
    body.messages = [body.messages[0], ...body.messages.filter(m => m.role !== "user")];
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    expect(plan.replacements.map(r => r.resultIndex)).toEqual([1, 2, 3]);
    const signed = structuredClone(body);
    for (const message of signed.messages) if (message.role === "assistant") message.reasoning_encrypted_content = "synthetic";
    const signedIndex = inspectSource(signed, "openai");
    const signedPlan = planSessionDedup(signedIndex, { mode: "on", fence: detectCacheFence(signed, signedIndex) });
    expect(signedPlan.replacements).toEqual([]);
    expect(signedPlan.stats.protected.opaque).toBe(6);
    const before = structuredClone(signed);
    expect(commitSessionDedup(signed, { sourceFormat: "openai", finalFormat: "openai", sourceIndex: signedIndex, plan: signedPlan }).appliedResults).toBe(0);
    expect(signed).toEqual(before);
  });
  it("protects signed current RTK leaves even when dedup is off and compresses old independent output", async () => {
    const log = Array.from({ length: 5 }, (_, i) => `commit ${String(i + 1).padStart(40, "0")}\nAuthor: Fixture\nDate: today\n\n    KEEP_${i}\n${"    detail\n".repeat(20)}\n`).join("");
    const body = fixture();
    for (const message of body.messages) {
      if (message.role === "assistant") {
        message.reasoning_encrypted_content = "synthetic";
        message.tool_calls[0].function = { name: "functions.bash", arguments: '{"command":"git log"}' };
      } else if (message.role === "tool") message.content = log;
    }
    const before = structuredClone(body);
    const statsBefore = getRtkSnapshot().usage;
    const active = await run(body, "off", { rtkEnabled: true });
    expect(body).toEqual(before);
    for (const i of [2, 5, 8]) {
      expect(Buffer.byteLength(active.messages[i].content)).toBeLessThan(Buffer.byteLength(log));
      for (let j = 0; j < 5; j++) expect(active.messages[i].content).toContain(`KEEP_${j}`);
    }
    for (const i of [11, 14, 17]) expect(active.messages[i].content).toBe(log);
    const stats = getRtkSnapshot().usage;
    expect((stats.bytesBefore - stats.bytesAfter) - (statsBefore.bytesBefore - statsBefore.bytesAfter)).toBeGreaterThan(0);
    expect(stats.eligibility.rejected.opaque_state - statsBefore.eligibility.rejected.opaque_state).toBe(3);
  });
  it.each([
    ["unsupported_final", body => { body.contents = []; }],
    ["call_count", body => { body.messages.splice(16, 1); }],
    ["result_count", body => { body.messages.pop(); }],
    ["call_identity", body => { body.messages[4].tool_calls[0].function.name = "different_tool"; }],
    ["result_linkage", body => { body.messages[8].tool_call_id = "orphan"; }],
    ["result_linkage", body => { [body.messages[1], body.messages[4]] = [body.messages[4], body.messages[1]]; }],
    ["leaf_proof", body => { body.messages[8].content += "changed"; }],
    ["leaf_proof", body => { body.messages[2].content += "changed anchor"; }],
    ["non_writable", body => { Object.defineProperty(body.messages[8], "content", { writable: false }); }],
  ])("rejects %s atomically and records only its first detail", (detail, mutate) => {
    const source = fixture();
    const sourceIndex = inspectSource(source, "openai");
    const plan = planSessionDedup(sourceIndex, { mode: "on", fence: detectCacheFence(source, sourceIndex) });
    const final = structuredClone(source);
    mutate(final);
    const before = structuredClone(final);
    const finalIndex = inspectSource(final, "openai");
    const finalFence = detectCacheFence(final, finalIndex);
    const commit = commitSessionDedup(final, { sourceFormat: "openai", finalFormat: "openai", sourceIndex, plan, finalIndex, finalFence });
    expect(commit.skipReason).toBe("final_correspondence");
    expect(commit.skipDetail).toBe(detail);
    expect(commit.appliedResults).toBe(0);
    expect(final).toEqual(before);
    const statsBefore = getTokenSaverSnapshot().usage;
    recordTokenSaverPreparation({ mode: "on", commit, finalOpaqueReasons: finalFence.opaqueReasons });
    const stats = getTokenSaverSnapshot().usage;
    expect(stats.finalCorrespondenceReasons[detail] - statsBefore.finalCorrespondenceReasons[detail]).toBe(1);
    expect(stats.finalOpaqueReasons).toEqual(statsBefore.finalOpaqueReasons);
  });
  it("attributes global final opaque state from final inspection, not source presence", () => {
    const source = fixture();
    const sourceIndex = inspectSource(source, "openai");
    const plan = planSessionDedup(sourceIndex, { mode: "on", fence: detectCacheFence(source, sourceIndex) });
    const final = { ...structuredClone(source), previous_response_id: "synthetic" };
    const finalIndex = inspectSource(final, "openai");
    const finalFence = detectCacheFence(final, finalIndex);
    const before = structuredClone(final);
    const commit = commitSessionDedup(final, { sourceFormat: "openai", finalFormat: "openai", sourceIndex, plan, finalIndex, finalFence });
    expect(commit.skipReason).toBe("final_opaque_state");
    expect(final).toEqual(before);
    const statsBefore = getTokenSaverSnapshot().usage;
    recordTokenSaverPreparation({ mode: "on", commit, opaqueReasons: [], finalOpaqueReasons: finalFence.opaqueReasons });
    expect(getTokenSaverSnapshot().usage.finalOpaqueReasons.previous_response_id - statsBefore.finalOpaqueReasons.previous_response_id).toBe(1);
    final.messages.pop();
    const mismatchIndex = inspectSource(final, "openai");
    const mismatchFence = detectCacheFence(final, mismatchIndex);
    const mismatch = commitSessionDedup(final, { sourceFormat: "openai", finalFormat: "openai", sourceIndex, plan, finalIndex: mismatchIndex, finalFence: mismatchFence });
    expect(mismatch.skipDetail).toBe("result_count");
    const opaqueBefore = getTokenSaverSnapshot().usage.finalOpaqueReasons;
    recordTokenSaverPreparation({ mode: "on", commit: mismatch, finalOpaqueReasons: mismatchFence.opaqueReasons });
    expect(getTokenSaverSnapshot().usage.finalOpaqueReasons).toEqual(opaqueBefore);
  });
  it("protects future Gemini signatures before RTK with dedup off", async () => {
    const bun = "suite.test.js:\n" + Array.from({ length: 40 }, (_, i) => `✓ synthetic test ${i} [1.00ms]`).join("\n") + "\n40 pass\n0 fail\nRan 40 tests across 1 file. [40ms]\n";
    const body = fixture();
    for (const message of body.messages) {
      if (message.role === "assistant") message.tool_calls[0].function = { name: "Bash", arguments: '{"command":"bun test"}' };
      else if (message.role === "tool") message.content = bun;
    }
    body.messages = body.messages.flatMap(m => m.role === "tool" ? [m, { role: "assistant", content: "complete" }] : [m]);
    const original = structuredClone(body);
    const statsBefore = getRtkSnapshot().usage;
    const active = await run(body, "off", { rtkEnabled: true, modelInfo: { provider: "gemini", model: "gemini-2.5-pro" } });
    expect(body).toEqual(original);
    const results = inspectSource(active, "gemini").results;
    for (let i = 0; i < 3; i++) expect(Buffer.byteLength(results[i].resultContainer.response.result.result)).toBeLessThan(Buffer.byteLength(bun));
    for (let i = 3; i < 6; i++) expect(results[i].resultContainer.response.result.result).toBe(bun);
    const stats = getRtkSnapshot().usage;
    expect(stats.appliedOutputs - statsBefore.appliedOutputs).toBe(3);
    expect(stats.eligibility.rejected.opaque_state - statsBefore.eligibility.rejected.opaque_state).toBe(3);
  });
  it("keeps translated mixed signed Gemini wrappers fail closed", () => {
    const body = fixture();
    const sourceIndex = inspectSource(body, "openai");
    const plan = planSessionDedup(sourceIndex, { mode: "on", fence: detectCacheFence(body, sourceIndex) });
    const final = translateRequest("openai", "gemini", "gemini-2.5-pro", body, false);
    const before = structuredClone(final);
    const commit = commitSessionDedup(final, { sourceFormat: "openai", finalFormat: "gemini", targetModel: "gemini-2.5-pro", sourceIndex, plan });
    expect(commit.skipReason).toBe("final_opaque_state");
    expect(commit.appliedResults).toBe(0);
    expect(final).toEqual(before);
  });
  it.each([null, "", [], [{ type: "image_url", image_url: { url: "synthetic" } }]])("keeps RTK raw when Gemini discards a separator %#", async content => {
    const bun = "suite.test.js:\n" + Array.from({ length: 40 }, (_, i) => `✓ synthetic test ${i} [1.00ms]`).join("\n") + "\n40 pass\n0 fail\nRan 40 tests across 1 file. [40ms]\n";
    const body = fixture();
    for (const message of body.messages) {
      if (message.role === "assistant") message.tool_calls[0].function = { name: "Bash", arguments: '{"command":"bun test"}' };
      else if (message.role === "tool") message.content = bun;
    }
    body.messages = body.messages.flatMap(m => m.role === "tool" ? [m, { role: "assistant", content }] : [m]);
    const before = getRtkSnapshot().usage;
    const active = await run(body, "off", { rtkEnabled: true, modelInfo: { provider: "gemini", model: "gemini-2.5-pro" } });
    for (const result of inspectSource(active, "gemini").results) expect(result.resultContainer.response.result.result).toBe(bun);
    const after = getRtkSnapshot().usage;
    expect(after.appliedOutputs).toBe(before.appliedOutputs);
    expect(after.local.attempts).toBe(before.local.attempts);
    expect(after.preparationReasons.opaque_state - before.preparationReasons.opaque_state).toBe(1);
  });
  it("rejects an invalid retained anchor mapping before any replacement", () => {
    const body = fixture();
    const before = structuredClone(body);
    const sourceIndex = inspectSource(body, "openai");
    const plan = planSessionDedup(sourceIndex, { mode: "on", fence: detectCacheFence(body, sourceIndex) });
    plan.replacements.at(-1).anchorResultIndex = 5;
    const commit = commitSessionDedup(body, { sourceFormat: "openai", finalFormat: "openai", sourceIndex, plan });
    expect(commit.skipReason).toBe("final_correspondence");
    expect(commit.skipDetail).toBe("anchor_mapping");
    expect(commit.appliedResults).toBe(0);
    expect(body).toEqual(before);
  });
});
