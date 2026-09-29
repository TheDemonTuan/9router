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
    expect(execute(body, "openai", "shadow").plan.stats.wouldDedupResults).toBe(2);
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
});
