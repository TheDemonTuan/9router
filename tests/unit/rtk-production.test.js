import { describe, it, expect } from "vitest";
import { classifyToolCall } from "../../open-sse/rtk/classifier.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { getRtkSnapshot, getRtkState, recordRtkCommand, recordRtkFilterOutcome } from "../../open-sse/rtk/state.js";
import { RTK_COMMAND_FAMILIES, RTK_FILTER_DETAILS } from "../../open-sse/config/rtkConfig.js";
import { codexOutput, largePatch, mixedBun, grokStructured, zcodePersisted, zcodeContext } from "../fixtures/compression-coverage.js";

const text = Array.from({ length: 40 }, (_, i) => `./synthetic/path/file-${i}.js`).join("\n") + "\n";
const call = { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "Bash", arguments: '{"command":"find ."}' } }] };
const result = extra => ({ role: "tool", tool_call_id: "c", content: text, ...extra });

describe("RTK production safety", () => {
  it("never shortens Unicode filename or body content that resembles an OpenCode row", async () => {
    const path = "/tmp/\u2028  Line 1: file.js:";
    const payload = "matched text " + "synthetic ".repeat(100);
    const raw = `Found 1 matches\n${path}\n  Line 2: ${payload}`;
    const body = { messages: [{ role: "assistant", tool_calls: [{ id: "grep", type: "function", function: { name: "grep", arguments: '{"path":"/tmp","pattern":"matched"}' } }] }, { role: "tool", tool_call_id: "grep", content: raw }] };
    await compressMessages(body, true);
    expect(body.messages[1].content).toBe(`Found 1 matches\n${path}\n2: ${payload}`);
  });
  it("never dispatches patch or non-patch diff modes through a lossy filter", async () => {
    const before = getRtkSnapshot().usage.http.attempts;
    for (const command of ["git diff", "git diff --check", "git diff --quiet", "git diff -s", "git diff --no-patch"]) {
      const body = { messages: [{ role: "assistant", tool_calls: [{ id: "patch", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } }] }, { role: "tool", tool_call_id: "patch", content: largePatch }] };
      await compressMessages(body, true);
      expect(body.messages[1].content).toBe(largePatch);
      expect(body.messages[1].content.split("\n").filter(line => line.startsWith("+synthetic line "))).toHaveLength(250);
    }
    expect(getRtkSnapshot().usage.http.attempts).toBe(before);
    expect(classifyToolCall({ name: "Bash", input: { command: "git diff" } }, "ordinary stdout")).toBeNull();
  });
  it("formats only completed linked exec bodies and accounts reconstructed bytes", async () => {
    const raw = codexOutput(mixedBun);
    const body = { input: [{ type: "function_call", call_id: "exec", name: "exec_command", arguments: JSON.stringify({ cmd: "bun --cwd tests run test --config vitest.config.js" }) }, { type: "function_call_output", call_id: "exec", output: raw }] };
    const stats = await compressMessages(body, true);
    const output = body.input[1].output;
    expect(output.slice(0, raw.indexOf("Output:\n") + 8)).toBe(raw.slice(0, raw.indexOf("Output:\n") + 8));
    for (const token of ["KEEP_FAILURE", "KEEP_ERROR", "KEEP_STACK", "KEEP_WARNING", "40 pass", "1 fail", "Ran 41 tests"]) expect(output).toContain(token);
    expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(raw));
    expect(stats.bytesBefore - stats.bytesAfter).toBe(Buffer.byteLength(raw) - Buffer.byteLength(output));
    for (const invalid of [raw.replace("code 0", "code 1"), raw.replace("Process exited with code 0", "Process running with session ID 3"), codexOutput("Warning: truncated output\n" + mixedBun), grokStructured, zcodePersisted("/synthetic/a"), zcodeContext]) {
      const carrier = structuredClone(body); carrier.input[1].output = invalid;
      await compressMessages(carrier, true);
      expect(carrier.input[1].output).toBe(invalid);
    }
    for (const command of ["bun --cwd 'tests directory' run test --config vitest.config.js", "bun --cwd ./tests test"]) expect(classifyToolCall({ name: "Bash", input: { command } }, mixedBun)).toBe("local:test");
    for (const command of ["bun --cwd tests --cwd other test", "bun --cwd tests run build", "bun --cwd tests run test | cat", "bun --cwd $(pwd) test", "timeout 3 bun test"]) expect(classifyToolCall({ name: "Bash", input: { command } }, mixedBun)).toBeNull();
  });
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
  it("keeps filter details bounded, isolated, sanitized and saturating", () => {
    const key = Symbol.for("9router.rtk.runtime.v1");
    const previous = globalThis[key];
    delete globalThis[key];
    try {
      recordRtkFilterOutcome("shell", "local:test", "local", false, "format_not_accepted", Number.MAX_SAFE_INTEGER, -1, "bun test", "unknown_reporter");
      recordRtkFilterOutcome("shell", "local:test", "local", false, "format_not_accepted", 10, Infinity, "bun test", "unknown_reporter");
      recordRtkFilterOutcome("shell", "local:test", "local", false, "format_not_accepted", NaN, 12.8, "SECRET_COMMAND", "SECRET_TEST_PATH_PAYLOAD");
      const snapshot = getRtkSnapshot();
      const row = snapshot.diagnostics.filters.find(r => r.detail === "unknown_reporter");
      expect(row).toMatchObject({ count: 2, inputBytes: Number.MAX_SAFE_INTEGER, outputBytes: 0 });
      expect(snapshot.diagnostics.filters.find(r => r.commandFamily === "other")).toMatchObject({ detail: "none", inputBytes: 0, outputBytes: 12 });
      expect(JSON.stringify(snapshot)).not.toContain("SECRET");
      row.detail = "failure_detected";
      row.count = 999;
      expect(getRtkSnapshot().diagnostics.filters.find(r => r.detail === "unknown_reporter").count).toBe(2);
      for (const command of RTK_COMMAND_FAMILIES) for (const detail of RTK_FILTER_DETAILS) {
        recordRtkFilterOutcome("shell", "local:test", "local", false, "format_not_accepted", 1, 0, command, detail);
      }
      const full = getRtkSnapshot();
      expect(full.diagnostics.filters).toHaveLength(128);
      expect(full.diagnostics.overflow.filters).toBe(RTK_COMMAND_FAMILIES.length * RTK_FILTER_DETAILS.length - 128);
      expect(full.diagnostics.filters.find(r => r.detail === "unknown_reporter" && r.commandFamily === "bun test")).toMatchObject({ count: 3, inputBytes: Number.MAX_SAFE_INTEGER });
    } finally {
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
  });
  it("preserves hot runtime counters when old filter rows have no detail", () => {
    const key = Symbol.for("9router.rtk.runtime.v1");
    const previous = globalThis[key];
    delete globalThis[key];
    try {
      const state = getRtkState();
      state.usage.local.attempts = 20;
      state.usage.diagnostics.filters["shell:local:test:local:0:not_smaller:bun test"] = {
        toolFamily: "shell", filter: "local:test", engine: "local", fallback: false, outcome: "not_smaller", commandFamily: "bun test", count: 7, inputBytes: 700, outputBytes: 700,
      };
      expect(getRtkSnapshot().diagnostics.filters[0]).toMatchObject({ detail: "none", count: 7 });
      recordRtkFilterOutcome("shell", "local:test", "local", false, "not_smaller", 100, 100, "bun test", "none");
      const snapshot = getRtkSnapshot();
      expect(snapshot.usage.local.attempts).toBe(20);
      expect(snapshot.diagnostics.filters).toEqual([{
        toolFamily: "shell", filter: "local:test", engine: "local", fallback: false, outcome: "not_smaller", commandFamily: "bun test", detail: "none", count: 8, inputBytes: 800, outputBytes: 800,
      }]);
    } finally {
      if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
  });
});
