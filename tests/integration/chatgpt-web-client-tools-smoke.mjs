import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const definitions = [
  { name: "Read", description: "Read a synthetic workspace file", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", enum: ["fixture.mjs", "fixture.test.mjs"] } } } },
  { name: "Edit", description: "Replace the subtraction with addition in fixture.mjs", parameters: { type: "object", additionalProperties: false, required: ["path", "old_text", "new_text"], properties: { path: { type: "string", const: "fixture.mjs" }, old_text: { type: "string", const: "return a - b;" }, new_text: { type: "string", const: "return a + b;" } } } },
  { name: "Exec", description: "Run bun fixture.test.mjs", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", const: "bun fixture.test.mjs" } } } },
];
const runTest = workspace => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, ["fixture.test.mjs"], { cwd: workspace, env: { PATH: process.env.PATH, HOME: workspace, USERPROFILE: workspace, APPDATA: workspace }, stdio: "ignore" });
  child.once("error", reject); child.once("exit", (code, signal) => signal ? reject(new Error("Fixture process interrupted")) : resolveRun(code));
});
function parseCalls(output) {
  const seen = new Set();
  return output.filter(item => item.type === "function_call").map(item => {
    assert.equal(typeof item.call_id, "string"); assert.ok(item.call_id.length && !seen.has(item.call_id)); seen.add(item.call_id);
    assert.ok(definitions.some(tool => tool.name === item.name)); assert.equal(typeof item.arguments, "string");
    const args = JSON.parse(item.arguments); assert.ok(args && typeof args === "object" && !Array.isArray(args));
    return { id: item.call_id, name: item.name, args };
  });
}
async function streamReply(response, wire) {
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const decoder = new TextDecoder(), calls = new Map(), items = new Map();
  let pending = "", content = "", terminal = 0, done = 0, completed;
  const consume = frame => {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done++; return; }
    const event = JSON.parse(data); assert.ok(!event.error, "SSE error");
    if (wire === "chat") {
      for (const choice of event.choices || []) {
        assert.equal(choice.index, 0);
        content += choice.delta?.content || "";
        for (const call of choice.delta?.tool_calls || []) {
          assert.ok(Number.isInteger(call.index) && call.index >= 0);
          const old = calls.get(call.index) || { id: "", name: "", arguments: "" };
          if (call.id) { assert.ok(!old.id || old.id === call.id); old.id = call.id; }
          if (call.function?.name) { assert.ok(!old.name || old.name === call.function.name); old.name = call.function.name; }
          old.arguments += call.function?.arguments || ""; calls.set(call.index, old);
        }
        if (choice.finish_reason) { terminal++; assert.equal(choice.finish_reason, calls.size ? "tool_calls" : "stop", "Chat SSE function finish reason"); }
      }
    } else {
      if (event.type === "response.failed" || event.type === "error") throw new Error("Responses stream failed");
      if (event.type === "response.output_item.added") {
        assert.ok(!items.has(event.output_index)); items.set(event.output_index, event.item);
      }
      if (event.type === "response.function_call_arguments.delta") {
        const item = items.get(event.output_index); assert.ok(item && item.id === event.item_id);
        const old = calls.get(event.output_index) || { id: item.call_id, name: item.name, arguments: "" };
        old.arguments += event.delta; calls.set(event.output_index, old);
      }
      if (event.type === "response.function_call_arguments.done") {
        const old = calls.get(event.output_index); assert.ok(old); assert.equal(old.arguments, event.arguments);
      }
      if (event.type === "response.output_item.done") {
        const old = items.get(event.output_index); assert.ok(old && old.id === event.item.id); items.set(event.output_index, event.item);
      }
      if (event.type === "response.completed") { terminal++; completed = event.response; }
    }
  };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) { consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
  }
  pending += decoder.decode(); assert.equal(pending.trim(), "", "SSE incomplete frame"); assert.equal(terminal, 1, "SSE terminal count");
  if (wire === "responses") {
    assert.equal(completed?.status, "completed");
    for (const [index, call] of calls) {
      const item = completed.output[index]; assert.equal(item.call_id, call.id); assert.equal(item.name, call.name); assert.equal(item.arguments, call.arguments);
    }
    return completed.output;
  }
  assert.equal(done, 1);
  assert.deepEqual([...calls.keys()], [...calls.keys()].map((_, index) => index));
  return [ ...(content ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }] : []),
    ...[...calls.values()].map(call => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments })) ];
}

export async function runClientToolsSmoke({ baseUrl, apiKey, model, wire, stream, reasoning, live = false }) {
  const url = new URL(baseUrl);
  assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  assert.ok(loopback || live, "Nonloopback requires live mode"); assert.ok(!live || process.env.CGW_LIVE === "1", "Live mode requires CGW_LIVE=1");
  assert.ok(wire === "chat" || wire === "responses"); assert.equal(typeof stream, "boolean");
  const workspace = await mkdtemp(join(tmpdir(), "cgw-client-tools-"));
  const history = wire === "chat" ? [{ role: "user", content: "Fix add in fixture.mjs. Read it, Edit the subtraction to addition, then Exec bun fixture.test.mjs. Use the tools; finish only after successful Exec with CGW_CLIENT_TOOLS_OK." }]
    : [{ role: "user", content: "Fix add in fixture.mjs. Read it, Edit the subtraction to addition, then Exec bun fixture.test.mjs. Use the tools; finish only after successful Exec with CGW_CLIENT_TOOLS_OK." }];
  const counts = { Read: 0, Edit: 0, Exec: 0 }; const ids = new Set(); let requests = 0, execPassed = false;
  try {
    await writeFile(join(workspace, "fixture.mjs"), "export function add(a, b) { return a - b; }\n");
    await writeFile(join(workspace, "fixture.test.mjs"), "import assert from 'node:assert/strict';\nimport { add } from './fixture.mjs';\nassert.equal(add(2, 3), 5);\n");
    assert.notEqual(await runTest(workspace), 0, "Fixture must fail before loop");
    for (; requests < 10;) {
      requests++;
      const body = { model, stream, tools: definitions.map(tool => wire === "chat" ? { type: "function", function: tool } : { type: "function", ...tool }),
        tool_choice: "auto", parallel_tool_calls: false, ...(wire === "chat" ? { messages: history, ...(reasoning ? { reasoning_effort: reasoning } : {}) } : { input: history, ...(reasoning ? { reasoning: { effort: reasoning } } : {}) }) };
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${wire === "chat" ? "chat/completions" : "responses"}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(300000), headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body),
      });
      assert.ok(response.ok, `Public API failed: HTTP ${response.status}`);
      let output;
      if (stream) output = await streamReply(response, wire);
      else {
        const data = await response.json(); assert.ok(!data.error);
        if (wire === "responses") { assert.equal(data.status, "completed", "Responses JSON terminal status"); output = data.output; }
        else {
          assert.equal(data.choices.length, 1); const choice = data.choices[0]; const message = choice.message;
          assert.equal(choice.finish_reason, message.tool_calls?.length ? "tool_calls" : "stop", `Chat JSON function finish reason: ${["stop", "tool_calls", "completed", "length"].includes(choice.finish_reason) ? choice.finish_reason : "other"}; calls=${message.tool_calls?.length || 0}`);
          output = [ ...(message.content ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] }] : []),
            ...(message.tool_calls || []).map(call => { assert.equal(call.type, "function"); return { type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments }; }) ];
        }
      }
      assert.ok(Array.isArray(output)); const calls = parseCalls(output);
      if (!calls.length) {
        const text = output.flatMap(item => item.content || []).map(part => part.text || "").join(""); assert.equal(text.trim(), "CGW_CLIENT_TOOLS_OK", "Final client marker");
        assert.ok(counts.Read && counts.Edit && counts.Exec && execPassed); assert.equal(await runTest(workspace), 0, "Independent fixture verification");
        return { model, wire, stream, requests, calls: counts, failedBefore: true, passedAfter: true, localExecExitCode: 0 };
      }
      assert.equal(calls.length, 1);
      if (wire === "responses") history.push(...output);
      else history.push({ role: "assistant", content: output.filter(item => item.type === "message").flatMap(item => item.content).map(part => part.text).join("") || null,
        tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
      for (const call of calls) {
        assert.ok(!ids.has(call.id)); ids.add(call.id); counts[call.name]++;
        const args = call.args; let result;
        if (call.name === "Read" || call.name === "Edit") {
          assert.ok(["fixture.mjs", "fixture.test.mjs"].includes(args.path));
          const file = join(workspace, args.path); assert.equal((await lstat(file)).isSymbolicLink(), false);
          if (call.name === "Read") { assert.deepEqual(Object.keys(args), ["path"]); result = await readFile(file, "utf8"); }
          else {
            assert.equal(args.path, "fixture.mjs"); assert.deepEqual(Object.keys(args).sort(), ["new_text", "old_text", "path"]);
            assert.equal(args.old_text, "return a - b;", "Only the synthetic arithmetic edit is authorized"); assert.equal(args.new_text, "return a + b;", "Arbitrary executable edits are not authorized");
            const content = await readFile(file, "utf8"); assert.equal(content.split(args.old_text).length, 2, "Exact unique edit required");
            await writeFile(file, content.replace(args.old_text, args.new_text)); result = "Edit succeeded";
          }
        } else {
          assert.deepEqual(Object.keys(args), ["command"]); assert.equal(args.command, "bun fixture.test.mjs");
          const exitCode = await runTest(workspace); execPassed = exitCode === 0; result = JSON.stringify({ exit_code: exitCode });
        }
        history.push(wire === "chat" ? { role: "tool", tool_call_id: call.id, content: result } : { type: "function_call_output", call_id: call.id, output: result });
      }
    }
    throw new Error("Client tool loop exceeded 10 requests");
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) { const key = args[index]; if (key === "--live") options.live = true; else { assert.ok(["--base-url", "--api-key-file", "--model", "--wire", "--stream", "--reasoning"].includes(key)); options[key.slice(2)] = args[++index]; } }
  assert.ok(options["api-key-file"]); assert.ok(["true", "false"].includes(options.stream));
  const apiKey = (await readFile(options["api-key-file"], "utf8")).trim(); assert.ok(apiKey);
  console.log(JSON.stringify(await runClientToolsSmoke({ baseUrl: options["base-url"], apiKey, model: options.model, wire: options.wire, stream: options.stream === "true", reasoning: options.reasoning, live: options.live })));
}
