import { describe, it, expect } from "vitest";
import { inspectSource } from "../../open-sse/token-saver/sourceWalker.js";
import { detectCacheFence } from "../../open-sse/token-saver/cacheFence.js";
import { measureCleanupOpportunities } from "../../open-sse/token-saver/safeCleanup.js";

function measure(body, options) {
  const index = inspectSource(body, "openai");
  detectCacheFence(body, index);
  return measureCleanupOpportunities(index, options);
}
describe("generic cleanup shadow", () => {
  it("measures whitespace, ANSI, repeated pure messages without changing input", () => {
    const body = { messages: [
      { role: "system", content: "policy" }, { role: "system", content: "policy" },
      { role: "user", content: "same" }, { role: "user", content: "same" },
      { role: "assistant", content: "a  \n\n\n\n\u001b[31mB\u001b[0m\t" },
    ] }; const original = structuredClone(body);
    const metric = measure(body);
    expect(metric.trailingWhitespaceBytes).toBe(3);
    expect(metric.blankLineBytes).toBe(2);
    expect(metric.ansiBytes).toBe(9);
    expect(metric.adjacentDuplicateBytes).toBe(Buffer.byteLength("policy") + Buffer.byteLength("same"));
    expect(metric.duplicateSystemBytes).toBe(0);
    expect(body).toEqual(original);
  });
  it("does not inspect a cache-protected adjacent neighbor", () => {
    const body = { messages: [{ role: "system", content: "private", cache_control: { type: "ephemeral" } },
      { role: "system", content: "private" }, { role: "user", content: "hello" }] };
    const result = measure(body);
    expect(result.protectedSegments).toBeGreaterThanOrEqual(1);
    expect(result.duplicateSystemBytes).toBe(0);
  });
  it("stops on whole-segment budget without truncating", () => {
    const body = { messages: [{ role: "system", content: "ok" }, { role: "user", content: "large".repeat(100) }] };
    const metric = measure(body, { remainingScanBytes: 10 });
    expect(metric.complete).toBe(false);
    expect(metric.measuredSegments).toBe(1);
    expect(metric.scannedBytes).toBe(2);
    expect(body.messages[1].content).toBe("large".repeat(100));
  });
});
