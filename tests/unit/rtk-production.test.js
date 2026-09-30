import { describe, it, expect } from "vitest";
import { classifyToolCall } from "../../open-sse/rtk/classifier.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { getRtkSnapshot, recordRtkCommand } from "../../open-sse/rtk/state.js";

const text = Array.from({ length: 40 }, (_, i) => `./synthetic/path/file-${i}.js`).join("\n") + "\n";
const call = { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "Bash", arguments: '{"command":"find ."}' } }] };
const result = extra => ({ role: "tool", tool_call_id: "c", content: text, ...extra });

describe("RTK production safety", () => {
  it("does not inspect non-command tool metadata", () => {
    for (const name of ["Read", "Edit", "Write", "read_file", "unknown_mcp_SECRET"]) {
      const reasons = [];
      const families = [];
      expect(classifyToolCall({ name, input: "SECRET_PATH".repeat(1000) }, text, r => reasons.push(r), f => families.push(f))).toBeNull();
      expect(reasons).toEqual(["not_applicable_tool"]);
      expect(families).toEqual([]);
    }
    const reasons = [];
    classifyToolCall({ name: "Bash", input: {} }, text, r => reasons.push(r));
    expect(reasons).toEqual(["missing_command"]);
  });
  it("routes only approved test scripts and records safe command families", () => {
    for (const manager of ["npm", "pnpm", "yarn", "bun"]) for (const script of ["test", "test:unit", "test:integration", "test:e2e"]) {
      const families = [];
      expect(classifyToolCall({ name: "Bash", input: { command: `${manager} run ${script}` } }, text, null, f => families.push(f))).toBe("local:test");
      expect(families).toEqual([`${manager} test`]);
    }
    expect(classifyToolCall({ name: "Bash", input: { command: "node --test" } }, text)).toBe("local:test");
    const families = [];
    classifyToolCall({ name: "Bash", input: { command: "/SECRET_PATH/unknown_SECRET argument_SECRET" } }, text, null, f => families.push(f));
    expect(families).toEqual(["other"]);
    recordRtkCommand(families[0], text.length);
    expect(JSON.stringify(getRtkSnapshot())).not.toContain("SECRET");
  });
  it("preserves failed results even when their output is compressible", async () => {
    const valid = { messages: [structuredClone(call), result()] };
    await compressMessages(valid, true);
    expect(valid.messages[1].content).not.toBe(text);
    for (const extra of [{ isError: true }, { error: {} }, { status: "failed" }, { status: "in_progress" }, { status: "cancelled" }]) {
      const body = { messages: [structuredClone(call), result(extra)] };
      await compressMessages(body, true);
      expect(body.messages[1].content).toBe(text);
    }
  });
  it("preserves both results for duplicate result IDs", async () => {
    const body = { messages: [structuredClone(call), result(), result()] };
    await compressMessages(body, true);
    expect(body.messages.slice(1).map(r => r.content)).toEqual([text, text]);
  });
  it("rejects custom/function kind mismatches", async () => {
    const body = { input: [{ type: "custom_tool_call", call_id: "c", name: "Bash", input: "find ." }, { type: "function_call_output", call_id: "c", output: text }] };
    await compressMessages(body, true);
    expect(body.input[1].output).toBe(text);
  });
  it("rejects duplicate and stale Gemini ID-less results", async () => {
    const body = { contents: [
      { role: "model", parts: [{ functionCall: { name: "Bash", args: { command: "find ." } } }] },
      { role: "user", parts: [{ functionResponse: { name: "Bash", response: { output: text } } }, { functionResponse: { name: "Bash", response: { output: text } } }] },
      { role: "model", parts: [{ functionCall: { name: "Read", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "Bash", response: { output: text } } }] },
    ] };
    await compressMessages(body, true);
    expect(body.contents[1].parts.map(p => p.functionResponse.response.output)).toEqual([text, text]);
    expect(body.contents[3].parts[0].functionResponse.response.output).toBe(text);
  });
});
