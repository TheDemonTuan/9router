import { describe, it, expect, afterAll, vi } from "vitest";
import { createServer } from "node:http";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { classifyToolCall } from "../../open-sse/rtk/classifier.js";
import { filterToolOutput } from "../../open-sse/rtk/client.js";

const input = "diff --git a/a b/a\n" + "+changed value\n".repeat(70);
let requests = 0;
const server = createServer(async (request, response) => {
  requests++;
  const data = JSON.parse(await new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  }));
  expect(data.filter).toBe("git-diff");
  if (data.content.startsWith("FAIL_")) { response.writeHead(500); response.end("offline"); return; }
  if (data.content.startsWith("BUSY_")) { response.writeHead(503); response.end("busy"); return; }
  if (data.content.startsWith("HANG_")) { response.setHeader("content-type", "application/json"); response.flushHeaders(); return; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ protocolVersion: 1, content: "shortened" }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.RTK_URL = `http://127.0.0.1:${server.address().port}`;
afterAll(() => new Promise(resolve => server.close(resolve)));
const call = (id = "call_1", command = "git diff") => ({ id, type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } });

describe("upstream RTK source traversal", () => {
  it("compresses only linked tool result text, preserving caller ownership", async () => {
    const body = { messages: [
      { role: "system", content: input }, { role: "user", content: input },
      { role: "assistant", tool_calls: [call()] },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: input }, { type: "image", data: input }] },
    ] };
    const original = structuredClone(body);
    const stats = await compressMessages(body, true);
    expect(body.messages[3].content[0].text).toBe("shortened");
    expect(body.messages[3].content[1]).toEqual(original.messages[3].content[1]);
    expect(body.messages.slice(0, 3)).toEqual(original.messages.slice(0, 3));
    expect(stats.hits[0].filter).toBe("git-diff");
    expect(stats.bytesBefore).toBe(Buffer.byteLength(input));
  });

  it("does not dispatch orphan, duplicate or error results", async () => {
    const start = requests;
    const body = { messages: [
      { role: "assistant", tool_calls: [call("dup"), call("dup")] },
      { role: "tool", tool_call_id: "dup", content: input },
      { role: "tool", tool_call_id: "missing", content: input },
      { role: "tool", tool_call_id: "dup", content: input, is_error: true },
      { role: "assistant", tool_calls: [call("late")] },
      { role: "tool", tool_call_id: "late", content: input },
      { role: "assistant", tool_calls: [call("late")] },
    ] };
    await compressMessages(body, true);
    expect(body.messages[1].content).toBe(input);
    expect(body.messages[5].content).toBe(input);
    expect(requests).toBe(start);
  });

  it("supports Responses input even with OpenAI format override", async () => {
    const body = { input: [
      { type: "function_call", call_id: "id", name: "Bash", arguments: '{"command":"git diff"}' },
      { type: "function_call_output", call_id: "id", output: input },
    ], sourceFormat: "openai" };
    await compressMessages(body, true);
    expect(body.input[1].output).toBe("shortened");
  });

  it("handles Claude, custom Responses, Gemini, Antigravity and Kiro linked output", async () => {
    const claude = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "git diff" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: input }, { type: "image", data: input }] }] },
    ] };
    const custom = { input: [
      { type: "custom_tool_call", call_id: "x", name: "Bash", input: "git diff" },
      { type: "custom_tool_call_output", call_id: "x", output: [{ type: "input_text", text: input }, { type: "input_image", image_url: input }] },
    ] };
    const gemini = { contents: [
      { role: "model", parts: [{ functionCall: { name: "Bash", args: { command: "git diff" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "Bash", response: { result: input, metadata: { untouched: input } } } }] },
    ] };
    const antigravity = { request: { contents: structuredClone(gemini.contents) } };
    const kiro = { conversationState: { history: [
      { assistantResponseMessage: { toolUses: [{ toolUseId: "k", name: "Bash", input: { command: "git diff" } }] } },
      { userInputMessage: { userInputMessageContext: { toolResults: [{ toolUseId: "k", content: [{ text: input }] }] } } },
    ] } };
    for (const [body, result, sibling] of [
      [claude, () => claude.messages[1].content[0].content[0].text, () => claude.messages[1].content[0].content[1].data],
      [custom, () => custom.input[1].output[0].text, () => custom.input[1].output[1].image_url],
      [gemini, () => gemini.contents[1].parts[0].functionResponse.response.result, () => gemini.contents[1].parts[0].functionResponse.response.metadata.untouched],
      [antigravity, () => antigravity.request.contents[1].parts[0].functionResponse.response.result],
      [kiro, () => kiro.conversationState.history[1].userInputMessage.userInputMessageContext.toolResults[0].content[0].text],
    ]) {
      const stats = await compressMessages(body, true);
      expect(result()).toBe("shortened");
      expect(stats.hits).toHaveLength(1);
      if (sibling) expect(sibling()).toBe(input);
    }
  });

  it("leaves Gemini ambiguous names and mismatched IDs raw", async () => {
    const start = requests;
    const body = { contents: [
      { parts: [{ functionCall: { name: "Bash", args: { command: "git diff" } } }, { functionCall: { name: "Bash", args: { command: "git diff" } } }] },
      { parts: [{ functionResponse: { name: "Bash", response: { output: input } } }, { functionResponse: { id: "unknown", name: "Bash", response: { result: input } } }] },
      { parts: [{ functionCall: { id: 7, name: "Bash", args: { command: "git diff" } } }, { functionResponse: { id: 7, name: "Bash", response: { output: input } } }] },
    ] };
    await compressMessages(body, true);
    expect(body.contents[1].parts[0].functionResponse.response.output).toBe(input);
    expect(body.contents[1].parts[1].functionResponse.response.result).toBe(input);
    expect(body.contents[2].parts[1].functionResponse.response.output).toBe(input);
    expect(requests).toBe(start);
  });

  it("propagates original caller abort instead of failing open", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("client canceled"), { code: "CLIENT_ABORT" });
    const body = { messages: [{ role: "assistant", tool_calls: [call()] }, { role: "tool", tool_call_id: "call_1", content: "HANG_" + "x".repeat(600) }] };
    setTimeout(() => controller.abort(reason), 30);
    await expect(compressMessages(body, true, { signal: controller.signal })).rejects.toBe(reason);
    expect(body.messages[1].content).toMatch(/^HANG_/);
  });

  it("skips cooldown without HTTP, probes once, and does not break on 503", async () => {
    const clock = vi.spyOn(Date, "now");
    let now = 100_000;
    clock.mockImplementation(() => now);
    try {
      const bad = "FAIL_" + "x".repeat(600);
      expect(await filterToolOutput({ filter: "git-diff", content: bad })).toBeNull();
      const afterFailure = requests;
      expect(await filterToolOutput({ filter: "git-diff", content: input })).toBeNull();
      expect(requests).toBe(afterFailure);
      now += 30_001;
      expect(await filterToolOutput({ filter: "git-diff", content: input })).toBe("shortened");
      const busy = "BUSY_" + "x".repeat(600);
      expect(await filterToolOutput({ filter: "git-diff", content: busy })).toBeNull();
      expect(await filterToolOutput({ filter: "git-diff", content: input })).toBe("shortened");
    } finally { clock.mockRestore(); }
  });

  it("bounds all pending results by one preparation deadline", async () => {
    const raw = "HANG_" + "x".repeat(600);
    const body = { messages: [{ role: "assistant", tool_calls: [call("a"), call("b"), call("c")] },
      ...["a", "b", "c"].map(id => ({ role: "tool", tool_call_id: id, content: raw }))] };
    const start = performance.now();
    const stats = await compressMessages(body, true);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(stats.hits).toEqual([]);
    expect(body.messages.slice(1).map(x => x.content)).toEqual([raw, raw, raw]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(body.messages.slice(1).map(x => x.content)).toEqual([raw, raw, raw]);
  });

  it("never classifies unknown commands or unsound modes", () => {
    for (const command of ["git log --oneline", "rg -n --stats x", "rg -n -C 3 x", "find . -ls", "fd --format x", "git diff | cat", "git diff; cat", "git diff 'unterminated", "git diff " + "x".repeat(8192)]) {
      expect(classifyToolCall({ name: "Bash", input: { command } }, input)).toBeNull();
    }
    expect(classifyToolCall({ name: "Bash", input: { command: 'git -C "path with spaces" diff' } }, input)).toBe("git-diff");
    expect(classifyToolCall({ name: "read_file", input: { path: "git diff" } }, input)).toBeNull();
    expect(classifyToolCall({ name: "Bash", input: { command: "go test ./..." } }, input)).toBeNull();
    const classify = (command, text) => classifyToolCall({ name: "Bash", input: { command } }, text);
    const grepOutput = "src/a.ts:12:retained\n".repeat(5);
    expect(classify("rg -n retained src", grepOutput)).toBe("grep");
    for (const command of ["rg -n --stats retained", "rg -n -C 3 retained"]) expect(classify(command, grepOutput)).toBeNull();
    expect(classify("rg -n retained", "\u001b[31m" + grepOutput)).toBeNull();
    expect(classify("find . -name '*.ts' -print", "./src/a.ts\n".repeat(30))).toBe("local:find");
    expect(classify("find . -ls", "./src/a.ts\n".repeat(30))).toBeNull();
    expect(classify("go test -json ./...", '{"Action":"pass"}\n')).toBe("go-test");
    expect(classify("go test ./...", '{"Action":"pass"}\n')).toBeNull();
    expect(classify("go test -json=false ./...", '{"Action":"pass"}\n')).toBeNull();
    expect(classify("ruff check --output-format json .", "[]")).toBe("ruff-check");
    expect(classify("ruff check .", "[]")).toBeNull();
    expect(classify("sqlfluff lint --format=json .", "[]")).toBe("sqlfluff-lint");
    expect(classify("sqlfluff lint --format=json .", "not-json")).toBeNull();
  });
  it("classifies literal shell metacharacters and a single safe cd prefix", () => {
    const grepOutput = "src/a.ts:12:retained\n".repeat(5);
    const cases = [
      ["rg -n 'foo|bar' src", "grep", grepOutput],
      ["rg -n '(foo|bar);$`&' src", "grep", grepOutput],
      ['rg -n "foo|bar;()&" src', "grep", grepOutput],
      ["git -C '/repo (test)' diff", "git-diff"],
      ["git -C '/repo&&name' diff", "git-diff"],
      [String.raw`git -C "C:\repo" diff`, "git-diff"],
      ["/usr/bin/git diff", "git-diff"],
      ["cd /repo && git diff", "git-diff"],
      ["cd -- './repo (test)' && git diff", "git-diff"],
      ["cd ./repo && rg -n 'foo|bar' src", "grep", grepOutput],
      ["cd ../repo && git diff", "git-diff"],
    ];
    for (const [command, filter, output = input] of cases) {
      const reasons = [];
      expect(classifyToolCall({ name: "functions.bash", input: { command } }, output, reason => reasons.push(reason)), command).toBe(filter);
      expect(reasons, command).toEqual([]);
    }
    expect(classifyToolCall({ name: "exec_command", input: { cmd: "cd /repo && git diff" } }, input)).toBe("git-diff");
    expect(classifyToolCall({ name: "read_file", input: { command: "cd /repo && git diff" } }, input)).toBeNull();
  });

  it("leaves ambiguous shell syntax and stdout-producing chains raw", () => {
    const commands = [
      "git diff 'unterminated", 'git -C "unterminated diff', "git diff $(pwd)", "git diff `pwd`",
      'git -C "$HOME" diff', 'git -C "`pwd`" diff', "git diff\\ foo", "git diff\\'x'",
      "git diff\\\\x", "git diff\\;cat", "git diff\\", "git diff\ncat", "git diff\r",
      "git diff || cat", "git diff | cat", "git diff > out", "git diff # comment", "git diff; cat",
      "cd repo && git diff", "cd - && git diff", "cd && git diff", "cd /repo extra && git diff",
      "pwd && git diff", "git status && git diff", "cd /repo && git diff && git status",
      "cd /repo; git diff", "cd /repo && git diff | cat", "pushd /repo && git diff",
      "cd /repo &&", "&& git diff",
    ];
    for (const command of commands) {
      const reasons = [];
      expect(classifyToolCall({ name: "Bash", input: { command } }, input, reason => reasons.push(reason)), command).toBeNull();
      expect(reasons, command).toHaveLength(1);
    }
  });
});
