import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, isAbsolute } from "node:path";

const mode = process.argv.includes("--sidecar") ? "sidecar" : "offline";
const outputAt = process.argv.indexOf("--output");
const output = outputAt < 0 ? null : process.argv[outputAt + 1];
if (output && !isAbsolute(output)) throw new Error("--output requires an absolute path");
if (!process.argv.includes("--child")) {
  const sandbox = await mkdtemp(join(tmpdir(), "headroom-resilience-"));
  const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, APPDATA: sandbox,
    DATA_DIR: join(sandbox, "data"), HEADROOM_DEFAULT_TIMEOUT_MS: "" };
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(key) || /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|GITHUB).*?(KEY|TOKEN)$/i.test(key)) delete env[key];
  const args = [process.execPath, import.meta.path, "--child", `--${mode}`, ...(process.argv.includes("--probe") ? ["--probe"] : []), ...(output ? ["--output", output] : [])];
  try {
    const child = Bun.spawn(args, { env, stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    assert.equal(code, 0, `Headroom ${mode} smoke exited ${code}`);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
} else if (mode === "offline") {
  const { callHeadroomGateway } = await import("../../open-sse/rtk/headroomGateway.js");
  const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
  const { getHeadroomRuntimeSnapshot } = await import("../../open-sse/rtk/headroomRuntime.js");
  const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
  const { default: migration } = await import("../../src/lib/db/migrations/002-headroom-timeout-default.js");
  let row = JSON.stringify({ headroomTimeoutMs: 3000, unrelated: { preserved: true } });
  const db = { get: () => ({ data: row }), run: (_, [next]) => { row = next; } };
  migration.up(db);
  migration.up(db);
  assert.equal(JSON.parse(row).headroomTimeoutMs, 10000);
  assert.deepEqual(JSON.parse(row).unrelated, { preserved: true });
  assert.equal(mergeWithDefaults({ headroomTimeoutMs: 15000 }).headroomEffectiveTimeoutMs, 15000);
  assert.equal(mergeWithDefaults({}).headroomEffectiveTimeoutMs, 10000);
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { getAdapter, resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  const { getSettings, updateSettings, exportSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
  await mkdir(process.env.DATA_DIR, { recursive: true });
  await writeFile(join(process.env.DATA_DIR, "db.json"), JSON.stringify({ settings: { headroomTimeoutMs: 3000, unrelated: "kept" } }));
  let adapter = await getAdapter();
  assert.equal((await getSettings()).headroomTimeoutMs, 10000);
  assert.equal((await exportSettings()).unrelated, "kept");
  adapter.run("UPDATE _meta SET value = '1' WHERE key = 'schemaVersion'");
  adapter.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify({ headroomTimeoutMs: 3000, unrelated: "kept" })]);
  resetAdapterForTest();
  adapter = await getAdapter();
  assert.equal((await getSettings()).headroomTimeoutMs, 10000);
  await updateSettings({ headroomTimeoutMs: 3000, headroomEffectiveTimeoutMs: 9 });
  resetAdapterForTest();
  adapter = await getAdapter();
  assert.equal((await getSettings()).headroomTimeoutMs, 3000);
  assert.equal((await exportSettings()).headroomEffectiveTimeoutMs, undefined);
  await updateSettings({ headroomTimeoutMs: 15000 });
  assert.equal((await getSettings()).headroomEffectiveTimeoutMs, 15000);
  let mode = "valid", attempts = 0, providerCalls = 0, providerBody;
  const sidecar = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    attempts++;
    const requestBody = await request.json();
    if (mode === "500") return new Response("unavailable", { status: 500 });
    if (mode === "skipped") {
      const { gateway, config, ...body } = requestBody;
      return Response.json({ compression_skipped: true, body });
    }
    if (mode === "hang") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() {} }), { headers: { "content-type": "application/json" } });
    const { gateway, config, ...body } = requestBody;
    body.messages = body.messages.map((message) => message.role === "tool" ? { ...message, content: "compressed" } : message);
    if (mode === "tampered") body.tools[0].function.parameters.properties.path.description = "other.json";
    return Response.json({ body, headers: { "anthropic-beta": "context-management-2025-06-27", cookie: "forbidden" }, tokens_before: 100, tokens_after: 60 });
  } });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    providerCalls++;
    providerBody = await request.json();
    return Response.json({ id: "chatcmpl-synthetic", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } });
  } });
  const url = `http://127.0.0.1:${sidecar.port}`;
  const body = () => ({ model: "synthetic", messages: [{ role: "user", content: "question" }, { role: "tool", tool_call_id: "tool-1", content: "long text" }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { description: "config.json" } } } } }] });
  const run = async (budget = 80) => {
    const original = body();
    const before = structuredClone(original);
    const diagnostics = {};
    const result = await compressWithHeadroom(original, { url, model: "synthetic", format: "openai", timeoutMs: budget, diagnostics });
    const response = await fetch(`http://127.0.0.1:${provider.port}`, { method: "POST", body: JSON.stringify(original) });
    assert.equal(response.status, 200);
    if (!result) assert.deepEqual(original, before);
    return { result, diagnostics, original };
  };
  try {
    let result = await run();
    assert.equal(result.original.messages[1].content, "compressed");
    assert.equal(result.result.providerHeaders.cookie, undefined);
    assert.equal(providerBody.messages[1].content, "compressed");
    mode = "tampered";
    result = await run();
    assert.equal(result.diagnostics.reason, "invariant_violation");
    mode = "skipped";
    result = await run();
    assert.equal(result.diagnostics.reason, "gateway_compression_skipped");
    globalThis[Symbol.for("9router.headroom.runtime")]?.clear();
    mode = "hang";
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      result = await run(40);
      assert.equal(result.diagnostics.reason, "gateway_timeout");
      assert.ok(performance.now() - start < 600);
    }
    const countAtOpen = attempts;
    for (let i = 0; i < 8; i++) {
      result = await run(40);
      assert.equal(result.diagnostics.reason, "circuit_open");
    }
    assert.equal(attempts, countAtOpen);
    assert.equal(providerCalls, 14);
    assert.equal(getHeadroomRuntimeSnapshot(`${url}/v1/compress`).headroom_circuit_open, 1);
    await Bun.sleep(30010);
    mode = "valid";
    const probes = await Promise.all(Array.from({ length: 8 }, () => run()));
    assert.equal(probes.filter((item) => item.result).length, 1);
    assert.equal(getHeadroomRuntimeSnapshot(`${url}/v1/compress`).headroom_circuit_open, 0);
    console.log(JSON.stringify({ mode: "offline", attempts, providerCalls, breaker: "recovered", timeout: "body bounded", invariant: "rejected" }));
  } finally { sidecar.stop(true); provider.stop(true); }
} else {
  const image = "ghcr.io/headroomlabs-ai/headroom:0.38.0@sha256:14e3dda1f041eef509af850ac7a32647d1c3e5d9bd66e3e8655dfd3a398273af";
  const docker = (...args) => {
    const process = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    if (process.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${new TextDecoder().decode(process.stderr).trim()}`);
    return new TextDecoder().decode(process.stdout).trim();
  };
  try { docker("version", "--format", "{{.Server.Version}}"); }
  catch { throw new Error(`Docker local/staging unavailable; prepare image with: docker pull ${image}`); }
  const context = docker("context", "inspect", "--format", "{{json .Endpoints.docker.Host}}");
  if (!/^"(unix:\/\/|npipe:\/\/)/.test(context)) throw new Error("Docker context is not local; refusing sidecar benchmark");
  docker("image", "inspect", image, "--format", "{{.Id}}");
  const { randomBytes } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { callHeadroomGateway } = await import("../../open-sse/rtk/headroomGateway.js");
  const { compressWithHeadroom, collectKiroHeadroomMessages } = await import("../../open-sse/rtk/headroom.js");
  const { validateBodyInvariants } = await import("../../open-sse/rtk/headroomInvariants.js");
  const name = `9router-headroom-test-${process.pid}-${Date.now()}`;
  const token = randomBytes(24).toString("hex");
  const env = ["HEADROOM_COMPRESS_ALLOW_REMOTE=1", "HEADROOM_SKIP_UPSTREAM_CHECK=1", "HEADROOM_DISABLE_KOMPRESS=1",
    "HEADROOM_DISABLE_KOMPRESS_FALLBACK=1", "HEADROOM_TOOL_SEARCH=0", "HEADROOM_OUTPUT_SHAPER=0",
    "HEADROOM_MODEL_ROUTER_ENABLED=0", "HEADROOM_OFFLINE=1", "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
    `HEADROOM_PROXY_TOKEN=${token}`];
  const percentiles = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const pick = (p) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
    return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
  };
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  const memoryBytes = (text) => {
    const match = /([\d.]+)\s*(B|KiB|MiB|GiB)/.exec(text);
    return match ? Math.round(Number(match[1]) * 1024 ** ({ B: 0, KiB: 1, MiB: 2, GiB: 3 }[match[2]])) : null;
  };
  const filler = (size) => Array.from({ length: Math.ceil(size / 88) }, (_, i) => `line-${i.toString().padStart(7, "0")}: synthetic output alpha beta gamma delta epsilon zeta eta theta iota kappa.`).join("\n");
  function fixture(format, size) {
    const text = filler(size);
    const tool = { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } };
    if (format === "claude") return { model: "claude-sonnet-4-5", max_tokens: 256, tools: [{ name: "read", input_schema: tool.function.parameters }], system: [{ type: "text", text: "Synthetic instructions" }], messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "read", input: { path: "config.json" } }, { type: "thinking", thinking: "opaque", signature: "sig" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: text }, { type: "text", text: "continue" }] },
    ] };
    if (format === "openai-responses") return { model: "gpt-5", tools: [tool], input: [
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"config.json\"}" },
      { type: "function_call_output", call_id: "call_1", output: text },
      { type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "opaque" }] },
    ] };
    if (format === "kiro") return { model: "claude-sonnet-4-5", conversationState: { history: [{ assistantResponseMessage: { content: "reading", toolUses: [{ toolUseId: "tool_1", name: "read", input: { path: "config.json" } }] } }],
      currentMessage: { userInputMessage: { content: "continue", userInputMessageContext: { toolResults: [{ toolUseId: "tool_1", status: "success", content: [{ text }] }] } } } } };
    return { model: "gpt-4o", tools: [tool], messages: [
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"config.json\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: text }, { role: "user", content: "continue" },
    ] };
  }
  let owned = false;
  try {
    docker("run", "--pull=never", "--detach", "--name", name, "--cpus", "1", "--memory", "1024m",
      "--network", "host", ...env.flatMap((value) => ["--env", value]), image);
    owned = true;
    const url = "http://127.0.0.1:8787";
    async function ready() {
      let lastProbe = "none";
      for (let n = 0; n < 120; n++) {
        try {
          const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) return;
          lastProbe = `HTTP ${response.status}`;
        } catch (error) { lastProbe = `${error?.cause?.code || error?.name || "fetch_failed"}${error?.cause?.message ? `: ${error.cause.message}` : ""}`; }
        await Bun.sleep(1000);
      }
      const state = docker("inspect", "--format", "{{.State.Status}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}", name);
      const logs = Bun.spawnSync(["docker", "logs", "--tail", "30", name], { stdout: "pipe", stderr: "pipe" });
      const recent = `${new TextDecoder().decode(logs.stdout)}\n${new TextDecoder().decode(logs.stderr)}`.replaceAll(token, "[redacted]");
      const internal = Bun.spawnSync(["docker", "exec", name, "python", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8787/readyz', timeout=2).status)"], { stdout: "pipe", stderr: "pipe" });
      const inside = `${internal.exitCode}: ${new TextDecoder().decode(internal.stdout)} ${new TextDecoder().decode(internal.stderr)}`;
      const hostCurl = Bun.spawnSync(["curl", "--max-time", "3", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", `${url}/readyz`], { stdout: "pipe", stderr: "pipe" });
      const curlStatus = `${hostCurl.exitCode}: ${new TextDecoder().decode(hostCurl.stdout)} ${new TextDecoder().decode(hostCurl.stderr)}`;
      throw new Error(`Headroom v0.38.0 /readyz did not become ready within 120s; last probe: ${lastProbe}; curl: ${curlStatus}; inside: ${inside}; container state: ${state}; recent logs: ${recent}`);
    }
    await ready();
    const version = docker("exec", name, "python", "-c", "import headroom; from headroom._version import __version__; print(__version__)");
    assert.equal(version, "0.38.0");
    if (process.argv.includes("--probe")) {
      const structured = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ file: `src/file-${i % 120}.js`, line: i, text: "synthetic repeated search result alpha beta gamma delta epsilon" })));
      const samples = [
        ["prose", fixture("openai", 262144)],
        ["structured", { model: "gpt-4o", messages: [
          { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: structured },
          { role: "user", content: "Summarize results" },
        ] }],
      ];
      for (const [shape, body] of samples) {
        const diagnostics = {};
        const result = await callHeadroomGateway({ url, proxyToken: token, model: body.model, body, format: "openai", timeoutMs: 30000, diagnostics });
        console.log(JSON.stringify({ shape, before: bytes(body), after: result ? bytes(result.compressedBody) : null,
          tokensBefore: result?.tokens_before, tokensAfter: result?.tokens_after, transforms: result?.transforms_applied,
          reason: diagnostics.reason || null }));
      }
    } else {
    const report = { image, version, hardware: { cpus: cpus().length, totalMemoryBytes: totalmem() }, cases: [], prefix: null };
    async function sample(format, size, mode) {
      const input = fixture(format, size);
      const projected = format === "kiro" ? { messages: collectKiroHeadroomMessages(input).messages } : input;
      const inputBytes = bytes(projected);
      assert.ok(inputBytes >= size && inputBytes <= 20 * 1024 * 1024, "Synthetic payload size out of bounds");
      const diag = {};
      const started = performance.now();
      const result = mode === "raw"
        ? await callHeadroomGateway({ url, proxyToken: token, body: projected, model: input.model, format: format === "kiro" ? "openai" : format, timeoutMs: 30000, diagnostics: diag })
        : await compressWithHeadroom(input, { url, proxyToken: token, model: input.model, format, timeoutMs: 10000, diagnostics: diag });
      const accepted = !!result;
      const outputBody = mode === "raw" ? result?.compressedBody : input;
      if (accepted && format !== "kiro") assert.equal(validateBodyInvariants(projected, outputBody, format).valid, true);
      return { accepted, reason: diag.reason || null, latencyMs: diag.latencyMs ?? null,
        elapsedMs: performance.now() - started, inputBytes, outputBytes: accepted ? bytes(outputBody) : null,
        tokensBefore: result?.tokens_before ?? null, tokensAfter: result?.tokens_after ?? null };
    }
    for (const transport of ["raw", "facade"]) for (const format of ["openai", "claude", "openai-responses", "kiro"])
      for (const size of [16384, 262144, 2097152]) for (const concurrency of [1, 4, 8]) {
        let peakObservedMemoryBytes = 0;
        const observeMemory = () => { peakObservedMemoryBytes = Math.max(peakObservedMemoryBytes, memoryBytes(docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name)) || 0); };
        globalThis[Symbol.for("9router.headroom.runtime")]?.clear();
        const summary = { transport, format, targetBytes: size, concurrency };
        for (const phase of ["cold", "warm"]) {
          const rows = [];
          if (phase === "cold") {
            for (let wave = 0; wave < 10; wave++) {
              docker("restart", name);
              await ready();
              rows.push(...await Promise.all(Array.from({ length: concurrency }, () => sample(format, size, transport))));
              observeMemory();
            }
          } else {
            for (let n = 0; n < 8; n += concurrency) await Promise.all(Array.from({ length: Math.min(concurrency, 8 - n) }, () => sample(format, size, transport)));
            for (let n = 0; n < 100; n += concurrency) rows.push(...await Promise.all(Array.from({ length: Math.min(concurrency, 100 - n) }, () => sample(format, size, transport))));
            observeMemory();
          }
          summary[phase] = { samples: rows.length, accepted: rows.filter((r) => r.accepted).length,
            skipped: rows.filter((r) => r.reason === "gateway_compression_skipped").length,
            timeouts: rows.filter((r) => r.reason === "gateway_timeout").length,
            circuitBypass: rows.filter((r) => r.reason === "circuit_open" || r.reason === "circuit_probe_in_flight").length,
            invariantRejects: rows.filter((r) => r.reason === "invariant_violation").length,
            latency: percentiles(rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs)),
            inputBytes: rows.reduce((sum, r) => sum + r.inputBytes, 0), outputBytes: rows.reduce((sum, r) => sum + (r.outputBytes || 0), 0),
            tokenDelta: rows.reduce((sum, r) => sum + ((r.tokensBefore || 0) - (r.tokensAfter || 0)), 0) };
        }
        summary.peakObservedContainerMemoryBytes = peakObservedMemoryBytes;
        report.cases.push(summary);
      }
    const counts = Object.fromEntries(["openai", "claude", "openai-responses", "kiro"].map((format) => [format,
      report.cases.filter((item) => item.format === format).reduce((n, item) => n + item.warm.accepted + item.cold.accepted, 0)]));
    report.acceptedByFormat = counts;
    const original = fixture("openai", 262144);
    const baselinePrefix = JSON.stringify(original.messages);
    const compressedPrefixes = [];
    let prefixAccepted = 0;
    for (let n = 0; n < 6; n++) {
      const request = structuredClone(original);
      if (n >= 3) request.messages.push({ role: "user", content: "additional synthetic turn" });
      const data = await compressWithHeadroom(request, { url, proxyToken: token, model: request.model, format: "openai", timeoutMs: 10000 });
      if (data) prefixAccepted++;
      compressedPrefixes.push(JSON.stringify(request.messages.slice(0, original.messages.length)));
    }
    const prefix = compressedPrefixes[0];
    const common = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    report.prefix = { accepted: prefixAccepted, originalPrefixBytes: new TextEncoder().encode(baselinePrefix).length,
      compressedPrefixBytes: new TextEncoder().encode(prefix).length,
      stability: compressedPrefixes.slice(1).map((value) => common(prefix, value) / prefix.length),
      note: "Synthetic byte-prefix stability; not provider billed/cache-hit evidence" };
    if (output) await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    assert.ok(Object.values(counts).every((count) => count > 0), "At least one format had zero accepted compression results");
    }
  } finally {
    if (owned) { docker("stop", name); docker("rm", name); }
  }
}
