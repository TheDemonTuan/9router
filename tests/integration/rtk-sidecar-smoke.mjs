import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.includes("--wrapper-faults")) {
  const { startRtkServer } = await import("../../sidecars/rtk/server.mjs");
  const server = await startRtkServer({ hostname: "127.0.0.1", port: 0, binaryPath: "/fixtures/rtk" });
  const url = `http://127.0.0.1:${server.port}/filter`;
  const post = async (filter, content, signal) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter, content }), signal });
  try {
    assert.equal((await post("git-diff;touch /tmp/pwned", "HANG")) .status, 400);
    await assert.rejects(access("/tmp/pwned"));
    assert.equal((await post("grep", "FAIL" )).status, 502);
    assert.equal((await post("grep", "OVERFLOW" )).status, 502);
    const pending = Array.from({ length: 4 }, () => post("grep", "HANG"));
    await Bun.sleep(60);
    assert.equal((await post("grep", "HANG")).status, 503);
    const replies = await Promise.all(pending);
    assert(replies.every(r => r.status === 504));
    assert.equal((await post("grep", "file:1:hello\n")).status, 200);
    assert(!(await readdir("/tmp")).some(file => /recall\.db|tee/.test(file)));
    console.log("RTK wrapper resource smoke passed");
  } finally { server.stop(true); }
  process.exit(0);
}

if (process.argv.includes("--gateway")) {
  await import("../translator/registerAll.js");
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const captured = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const incoming = await request.json();
    captured.push(incoming);
    if (incoming.stream) {
      const chunk = { id: "chatcmpl-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    const message = { id: "chatcmpl-smoke", object: "chat.completion", model: "rtk-smoke", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    return Response.json(message);
  } });
  const diff = "diff --git a/a b/a\n" + "+synthetic change\n".repeat(100);
  const body = { model: "rtk-smoke", stream: false, messages: [
    { role: "assistant", tool_calls: [{ id: "smoke-call", type: "function", function: { name: "Bash", arguments: '{"command":"git diff"}' } }] },
    { role: "tool", tool_call_id: "smoke-call", content: diff },
  ] };
  try {
    const result = await handleChatCore({ body, modelInfo: { provider: "openai-compatible-chat-rtk-smoke", model: "rtk-smoke" }, credentials: { apiKey: "test-key", providerSpecificData: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiType: "chat" } }, rtkEnabled: true });
    assert.equal(result.response.status, 200);
    assert((await result.response.text()).includes("ok"));
    assert.equal(body.messages[1].content, diff);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].messages[1].tool_call_id, "smoke-call");
    if (process.argv.includes("--outage")) assert.equal(captured[0].messages[1].content, diff);
    else assert(Buffer.byteLength(captured[0].messages[1].content) < Buffer.byteLength(diff));
    const claude = { model: "rtk-smoke", stream: false, messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "claude-call", name: "Bash", input: { command: "git diff" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-call", content: diff }] },
    ] };
    const claudeResult = await handleChatCore({ body: claude, sourceFormatOverride: "claude", modelInfo: { provider: "openai-compatible-chat-rtk-smoke", model: "rtk-smoke" }, credentials: { apiKey: "test-key", providerSpecificData: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiType: "chat" } }, rtkEnabled: true });
    assert.equal(claudeResult.response.status, 200);
    assert((await claudeResult.response.text()).includes("ok"));
    const tool = captured[1].messages.find(message => message.role === "tool");
    assert.equal(tool.tool_call_id, "claude-call");
    if (process.argv.includes("--outage")) assert.equal(tool.content, diff);
    else assert(Buffer.byteLength(tool.content) < Buffer.byteLength(diff));
    assert.equal(claude.messages[2].content[0].content, diff);
    const streamed = structuredClone(body);
    streamed.stream = true;
    const streamedResult = await handleChatCore({ body: streamed, modelInfo: { provider: "openai-compatible-chat-rtk-smoke", model: "rtk-smoke" }, credentials: { apiKey: "test-key", providerSpecificData: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiType: "chat" } }, rtkEnabled: true });
    const events = await streamedResult.response.text();
    assert(events.includes("ok") && events.includes("[DONE]"));
    assert.equal(streamed.messages[1].content, diff);
    console.log(process.argv.includes("--outage") ? "RTK outage passthrough passed" : "RTK gateway smoke passed");
  } finally { provider.stop(true); }
  process.exit(0);
}

const position = process.argv.indexOf("--image");
assert(position >= 0 && process.argv[position + 1], "Usage: bun rtk-sidecar-smoke.mjs --image IMAGE");
const image = process.argv[position + 1];
const name = `rtk-smoke-${randomUUID().slice(0, 12)}`;
const network = `${name}-net`;
const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 45_000 });
  if (result.status !== 0) throw Error(`docker ${args[0]} failed: ${result.stderr?.slice(0, 300)}`);
  return result.stdout.trim();
};
const input = Array.from({ length: 50 }, (_, i) => `src/a.ts:${i + 1}:KEEP_${i + 1} ${"padding ".repeat(12)}`).join("\n") + "\n";
try {
  // ponytail: Docker suppresses published ports on internal networks; smoke binds localhost, production Compose stays internal-only.
  docker("network", "create", network);
  docker("run", "-d", "--name", name, "--network", network, "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "-p", "127.0.0.1::8080", image);
  const binding = docker("port", name, "8080/tcp");
  assert.match(binding, /^127\.0\.0\.1:[0-9]+$/);
  const port = Number(binding.split(":").at(-1));
  const url = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { health = await (await fetch(`${url}/health`)).json(); if (health.ok) break; } catch {}
    await Bun.sleep(250);
  }
  assert.deepEqual(health, { ok: true, protocolVersion: 1 });
  const version = await (await fetch(`${url}/version`)).json();
  assert.equal(version.protocolVersion, 1);
  assert.equal(version.rtkVersion, "0.50.0");
  assert.equal(version.wrapperRevision, 1);
  for (const filter of ["grep", null]) {
    const args = ["exec", "-i", "-e", "RTK_TELEMETRY_DISABLED=1", "-e", "RTK_RECALL=0", "-e", "RTK_TEE=0", name, "/usr/local/bin/rtk", "pipe", ...(filter ? ["--filter", filter] : [])];
    const expected = spawnSync("docker", args, { input, encoding: "utf8", timeout: 5000 });
    assert.equal(expected.status, 0);
    const response = await fetch(`${url}/filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter, content: input }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.content, expected.stdout);
    if (filter === "grep") { assert(data.content.includes("KEEP_1")); assert(Buffer.byteLength(data.content) < Buffer.byteLength(input)); }
  }
  const unknown = "UNKNOWN_BLOB_" + "a".repeat(600);
  const unknownResponse = await fetch(`${url}/filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: unknown }) });
  assert.equal((await unknownResponse.json()).content, unknown);
  const invalid = await fetch(`${url}/filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: "git-diff;touch /tmp/pwned", content: input }) });
  assert.equal(invalid.status, 400);
  assert.equal(docker("exec", name, "bun", "-e", "console.log(process.env.RTK_TELEMETRY_DISABLED,process.env.RTK_RECALL,process.env.RTK_TEE)"), "1 0 0");
  const home = await mkdtemp(join(tmpdir(), "router-rtk-smoke-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DATA_DIR: home, RTK_URL: url };
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
  try {
    for (const mode of ["healthy", "outage"]) {
      if (mode === "outage") docker("stop", name);
      const child = Bun.spawn([process.execPath, import.meta.path, "--gateway", ...(mode === "outage" ? ["--outage"] : [])], { env, stdout: "inherit", stderr: "inherit" });
      const timer = setTimeout(() => child.kill(), 15_000);
      const code = await child.exited;
      clearTimeout(timer);
      assert.equal(code, 0, `gateway ${mode} smoke failed`);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
  const fixtureHome = await mkdtemp(join(tmpdir(), "router-rtk-fixture-"));
  try {
    const fixture = join(fixtureHome, "rtk");
    await writeFile(fixture, `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("rtk 0.50.0"); process.exit(0); }
const input = await Bun.stdin.text();
if (input === "FAIL") process.exit(2);
if (input === "HANG") await Bun.sleep(5000);
if (input === "OVERFLOW") await new Promise((resolve, reject) => process.stdout.write("x".repeat(11_000_000), error => error ? reject(error) : resolve()));
process.stdout.write(input);
`);
    await chmod(fixture, 0o755);
    docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "-v", `${process.cwd()}:/work:ro`, "-v", `${fixtureHome}:/fixtures:ro`, "--entrypoint", "bun", image, "/work/tests/integration/rtk-sidecar-smoke.mjs", "--wrapper-faults");
  } finally { await rm(fixtureHome, { recursive: true, force: true }); }
  console.log("RTK native image smoke passed");
} finally {
  try { docker("rm", "-f", name); } catch {}
  try { docker("network", "rm", network); } catch {}
}
