import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectSource } from "../../open-sse/token-saver/sourceWalker.js";
import { detectCacheFence } from "../../open-sse/token-saver/cacheFence.js";
import { planSessionDedup, commitSessionDedup } from "../../open-sse/token-saver/sessionDedup.js";

const big = "x".repeat(2048);
function fixture(texts = Array(6).fill(big), names = texts.map(() => "read_file")) {
  const messages = [];
  texts.forEach((text, i) => messages.push(
    { role: "user", content: `u${i}` },
    { role: "assistant", tool_calls: [{ id: `c${i}`, type: "function", function: { name: names[i], arguments: JSON.stringify({ path: `/file/${i}` }) } }] },
    { role: "tool", tool_call_id: `c${i}`, content: text },
  ));
  return { messages };
}
function execute(body, format = "openai", mode = "on") {
  const index = inspectSource(body, format);
  const fence = detectCacheFence(body, index);
  const plan = planSessionDedup(index, { mode, fence });
  const commit = commitSessionDedup(body, { sourceFormat: format, finalFormat: format, sourceIndex: index, plan });
  return { index, fence, plan, commit };
}
const result = (body, ordinal) => body.messages[ordinal * 3 + 2].content;
describe("request-local exact session dedup", () => {
  it("preserves the first result, call metadata and three recent turns", () => {
    const body = fixture(); const original = structuredClone(body);
    const { plan, commit } = execute(body);
    expect(commit.appliedResults).toBe(2);
    expect(commit.bytesSaved).toBe(2 * (2048 - Buffer.byteLength(result(body, 1))));
    expect(result(body, 0)).toBe(big);
    expect(result(body, 1)).toBe(`[9router dedup:v1 this tool result is byte-identical to an earlier preserved result from the same tool family in this request; bytes=2048; sha256=${createHash("sha256").update(big).digest("hex")}]`);
    expect(result(body, 2)).toBe(result(body, 1));
    for (const i of [3, 4, 5]) expect(result(body, i)).toBe(big);
    for (const i of [0, 1, 2, 3, 4, 5]) expect(body.messages[3 * i + 1]).toEqual(original.messages[3 * i + 1]);
    expect(plan.protection.get(body.messages[2]).get("content")).toBe("dedup_anchor");
    const applied = structuredClone(body);
    expect(execute(body).commit.appliedResults).toBe(0);
    expect(body).toEqual(applied);
    expect(original.messages[5].content).toBe(big);
  });
  it("keeps shadow mutation-free and off avoids hashing", () => {
    const body = fixture(); const before = structuredClone(body);
    const shadowPlan = execute(body, "openai", "shadow").plan;
    expect(shadowPlan.stats.plannedResults).toBe(2);
    expect(shadowPlan.stats.wouldDedupResults).toBe(2);
    expect(shadowPlan.stats.plannedSaveBytes).toBeGreaterThan(0);
    expect(shadowPlan.stats.wouldSaveBytes).toBe(shadowPlan.stats.plannedSaveBytes);
    expect(body).toEqual(before);
    const off = execute(body, "openai", "off");
    expect(off.plan.stats.scannedBytes).toBe(0);
    expect(off.commit.appliedResults).toBe(0);
  });
  it("requires exact same family, bytes and linked calls", () => {
    const body = fixture([big, big + "\n", big, big, big, big], ["read_file", "read_file", "bash", "read_file", "read_file", "read_file"]);
    expect(execute(body).commit.appliedResults).toBe(0);
    const unicode = fixture(["é".repeat(1024), "e\u0301".repeat(1024), ...Array(4).fill(big)]);
    expect(execute(unicode).commit.appliedResults).toBe(0);
    const duplicate = fixture(); duplicate.messages[16].tool_calls[0].id = "c0";
    expect(execute(duplicate).commit.appliedResults).toBe(0);
    expect(result(duplicate, 0)).toBe(big);
    expect(result(duplicate, 1)).toBe(big);
  });
  it("uses UTF-8 size boundaries and structured error metadata", () => {
    const short = fixture(Array(6).fill("é".repeat(511)));
    expect(execute(short).commit.appliedResults).toBe(0);
    const boundary = fixture(Array(6).fill("é".repeat(512)));
    expect(execute(boundary).commit.appliedResults).toBe(2);
    const error = fixture(); error.messages[2].is_error = true;
    expect(execute(error).commit.appliedResults).toBe(1);
    expect(result(error, 0)).toBe(big);
    const structured = fixture(); structured.messages[2].content = [{ type: "text", text: big, citations: ["citation"] }];
    expect(execute(structured).commit.appliedResults).toBe(1);
    expect(structured.messages[2].content[0].text).toBe(big);
  });
  it("accepts 4 MiB but never reads a 4 MiB plus one result as a candidate", () => {
    const atLimit = "m".repeat(4_194_304);
    const overLimit = atLimit + "n";
    const body = fixture([atLimit, atLimit, overLimit, big, big, big]);
    const { plan, commit } = execute(body);
    expect(commit.appliedResults).toBe(1);
    expect(plan.stats.skipped.above_max_bytes).toBe(1);
    expect(result(body, 0)).toBe(atLimit);
    expect(result(body, 1)).toMatch(/^\[9router dedup:v1 /);
    expect(result(body, 2)).toBe(overLimit);
  });
  it("never rewrites orphan or malformed client markers", () => {
    const malformed = "[9router dedup:v1 malformed]".padEnd(2048, "x");
    const body = fixture([malformed, malformed, ...Array(4).fill(big)]);
    expect(execute(body).commit.appliedResults).toBe(0);
    expect(result(body, 0)).toBe(malformed);
    expect(result(body, 1)).toBe(malformed);
  });
  it("discards all pending writes when a late result exceeds the scan budget", () => {
    const body = fixture(Array(13).fill("z".repeat(2 * 1024 * 1024)));
    const before = structuredClone(body);
    const first = execute(body);
    expect(first.plan.skipReason).toBe("scan_budget");
    expect(first.commit.appliedResults).toBe(0);
    expect(body).toEqual(before);
    expect(execute(body).commit.appliedResults).toBe(0);
  });
  it("rejects an incomplete index before using late duplicate IDs or cache markers", () => {
    const body = fixture();
    body.messages.push(...Array.from({ length: 2049 }, (_, i) => ({ role: "assistant", tool_calls: [{ id: `extra${i}`, function: { name: "read_file", arguments: "{}" } }] })));
    const indexed = inspectSource(body, "openai");
    expect(indexed.supported).toBe(false);
    expect(indexed.blockedReason).toBe("metadata_budget");
    expect(indexed.results).toHaveLength(0);
    expect(planSessionDedup(indexed, { mode: "on" }).replacements).toHaveLength(0);
  });
  it("treats a late result as current even when its call is old", () => {
    const body = fixture();
    const late = body.messages.splice(2, 1)[0];
    body.messages.push(late);
    const { index } = execute(body);
    expect(index.results.at(-1).turnIndex).toBe(index.currentTurnIndex);
    expect(late.content).toBe(big);
  });
  it("rejects an aborted commit without changing any result", () => {
    const body = fixture(); const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    const controller = new AbortController(); const reason = new Error("cancelled by client");
    controller.abort(reason);
    expect(() => commitSessionDedup(body, { sourceFormat: "openai", finalFormat: "openai", sourceIndex: index, plan, signal: controller.signal })).toThrow(reason);
    expect(result(body, 1)).toBe(big);
  });
  it("treats typed and role-only Responses user messages identically and counts implicit user turns", () => {
    const makeResponsesBody = (withType = true, stringContent = false) => {
      const input = [];
      for (let i = 0; i < 6; i++) {
        const userMsg = withType
          ? { type: "message", role: "user", content: stringContent ? `turn ${i}` : [{ type: "input_text", text: `turn ${i}` }] }
          : { role: "user", content: stringContent ? `turn ${i}` : [{ type: "input_text", text: `turn ${i}` }] };
        input.push(
          userMsg,
          { type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}" },
          { type: "function_call_output", call_id: `c${i}`, output: big },
        );
      }
      return { input };
    };

    const typed = makeResponsesBody(true, false);
    const roleOnly = makeResponsesBody(false, false);
    const stringContent = makeResponsesBody(false, true);

    const typedExec = execute(typed, "openai-responses");
    const roleOnlyExec = execute(roleOnly, "openai-responses");
    const stringExec = execute(stringContent, "openai-responses");

    expect(typedExec.index.currentTurnIndex).toBe(5);
    expect(roleOnlyExec.index.currentTurnIndex).toBe(5);
    expect(stringExec.index.currentTurnIndex).toBe(5);

    expect(typedExec.index.diagnostics.userTurns).toBe(6);
    expect(roleOnlyExec.index.diagnostics.userTurns).toBe(6);
    expect(roleOnlyExec.index.diagnostics.responsesImplicitUserMessages).toBe(6);
    expect(typedExec.index.diagnostics.responsesImplicitUserMessages).toBe(0);

    expect(roleOnlyExec.commit.appliedResults).toBe(2);
    expect(typedExec.commit.appliedResults).toBe(2);
    expect(stringExec.commit.appliedResults).toBe(2);

    for (let i = 0; i < 6; i++) {
      expect(roleOnlyExec.index.results[i].turnIndex).toBe(typedExec.index.results[i].turnIndex);
      expect(roleOnlyExec.index.results[i].isCurrentTurn).toBe(i === 5);
      expect(roleOnlyExec.index.results[i].isRecentTurn).toBe(i >= 3);
    }

    expect(stringExec.index.textSegments.some(s => s.role === "user" && s.text === "turn 0")).toBe(true);
  });
  it("marks unknown history when no genuine user turn exists and never flags as current or recent", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "c0", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c0", output: big },
      ],
    };
    const { index, commit } = execute(body, "openai-responses");
    expect(index.currentTurnIndex).toBe(-1);
    expect(index.diagnostics.userTurns).toBe(0);
    expect(index.results[0].turnIndex).toBe(-1);
    expect(index.results[0].isCurrentTurn).toBe(false);
    expect(index.results[0].isRecentTurn).toBe(false);
    expect(commit.appliedResults).toBe(0);
  });
  it("detects batch completion, taints interleaved batches, and vetoes ambiguous turns", () => {
    // Interleaved batches: A/B -> out A -> C -> out B/C
    const interleaved = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "cA", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "cB", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "cA", output: big },
        { type: "function_call", call_id: "cC", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "cB", output: big },
        { type: "function_call_output", call_id: "cC", output: big },
      ],
    };
    const { index } = execute(interleaved, "openai-responses");
    expect(index.toolBatches).toHaveLength(2);
    expect(index.toolBatches[0].completed).toBe(false);
    expect(index.toolBatches[0].tainted).toBe(true);
    expect(index.toolBatches[1].completed).toBe(false);
    expect(index.toolBatches[1].tainted).toBe(true);

    // Ambiguous turn: mixed Claude user wrapper
    const mixedClaude = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: big },
            { type: "text", text: "extra user instruction" },
          ],
        },
      ],
    };
    const claudeExec = execute(mixedClaude, "claude");
    expect(claudeExec.index.diagnostics.ambiguousTurns).toBe(1);
    expect(claudeExec.index.blockedReason).toBe("ambiguous_turn");
  });
  it("deduplicates old completed batches in a single user turn while preserving the latest two completed batches", () => {
    const makeSingleTurnBatches = (count = 6) => {
      const input = [
        { role: "user", content: [{ type: "input_text", text: "single turn" }] },
      ];
      for (let i = 0; i < count; i++) {
        input.push(
          { type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}" },
          { type: "function_call_output", call_id: `c${i}`, output: big },
        );
      }
      return { input };
    };

    // Shadow mode
    const callerShadow = makeSingleTurnBatches(6);
    const beforeShadow = structuredClone(callerShadow);
    const shadow = execute(callerShadow, "openai-responses", "shadow");
    expect(callerShadow).toEqual(beforeShadow);
    expect(shadow.plan.stats.plannedResults).toBe(3);
    expect(shadow.plan.stats.wouldDedupResults).toBe(3);
    expect(shadow.commit.appliedResults).toBe(0);
    expect(shadow.plan.stats.hashedResults).toBe(4); // B0 (anchor), B1, B2, B3 (duplicates)
    expect(shadow.plan.stats.intraTurnEligibleResults).toBe(4);
    expect(shadow.plan.stats.intraTurnDuplicatesFound).toBe(3);

    // On mode
    const callerOn = makeSingleTurnBatches(6);
    const beforeOn = structuredClone(callerOn);
    const active = execute(callerOn, "openai-responses", "on");
    expect(active.commit.appliedResults).toBe(3);
    expect(active.plan.stats.plannedResults).toBe(3);
    expect(active.plan.stats.plannedSaveBytes).toBeGreaterThan(0);
    const outputs = callerOn.input.filter(x => x.type === "function_call_output").map(x => x.output);
    // B0: RAW anchor
    expect(outputs[0]).toBe(big);
    // B1, B2, B3: markers
    expect(outputs[1]).toMatch(/^\[9router dedup:v1 /);
    expect(outputs[2]).toMatch(/^\[9router dedup:v1 /);
    expect(outputs[3]).toMatch(/^\[9router dedup:v1 /);
    // B4, B5: RAW (latest two completed batches)
    expect(outputs[4]).toBe(big);
    expect(outputs[5]).toBe(big);

    // Original caller object structure before dedup was untouched
    expect(beforeOn.input[2].output).toBe(big);
  });
  it("bypasses hashing and savers when incoming history already has well-formed v1 markers", () => {
    const marker = `[9router dedup:v1 this tool result is byte-identical to an earlier preserved result from the same tool family in this request; bytes=2048; sha256=${createHash("sha256").update(big).digest("hex")}]`;
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "query" }] },
        { type: "function_call", call_id: "c0", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c0", output: big },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: marker },
      ],
    };

    for (const mode of ["off", "shadow", "on"]) {
      const cloned = structuredClone(body);
      const { plan, commit } = execute(cloned, "openai-responses", mode);
      expect(plan.hasExistingMarkers).toBe(true);
      expect(plan.skipReason).toBe("existing_marker");
      expect(plan.stats.skipped.existing_marker).toBe(1);
      expect(plan.stats.hashedResults).toBe(0);
      expect(plan.replacements).toHaveLength(0);
      expect(commit.appliedResults).toBe(0);
      expect(cloned).toEqual(body);
    }
  });
});
