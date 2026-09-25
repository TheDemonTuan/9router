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
  const env = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    APPDATA: sandbox,
    DATA_DIR: join(sandbox, "data"),
  };
  for (const key of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy)$/i.test(key) || /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|GITHUB).*?(KEY|TOKEN)$/i.test(key)) {
      delete env[key];
    }
  }
  const args = [
    process.execPath,
    import.meta.path,
    "--child",
    `--${mode}`,
    ...(process.argv.includes("--probe") ? ["--probe"] : []),
    ...(process.argv.includes("--full") ? ["--full"] : []),
    ...(output ? ["--output", output] : []),
  ];
  try {
    const child = Bun.spawn(args, { env, stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    assert.equal(code, 0, `Headroom ${mode} smoke exited ${code}`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
} else if (mode === "offline") {
  const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
  const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
  const { default: migration } = await import("../../src/lib/db/migrations/002-headroom-timeout-default.js");

  // Migration test
  let row = JSON.stringify({ headroomTimeoutMs: 3000, unrelated: { preserved: true } });
  const db = { get: () => ({ data: row }), run: (_, [next]) => { row = next; } };
  migration.up(db);
  migration.up(db);
  assert.equal(JSON.parse(row).headroomTimeoutMs, 10000);
  assert.deepEqual(JSON.parse(row).unrelated, { preserved: true });

  // Settings repo defaults
  const merged = mergeWithDefaults({ headroomEnabled: true });
  assert.equal(merged.headroomEnabled, true);
  assert.equal(merged.headroomTimeoutMs, undefined);
  assert.equal(merged.headroomEffectiveTimeoutMs, undefined);

  let sidecarMode = "valid";
  let attempts = 0;
  let providerCalls = 0;
  let providerBody = null;

  const sidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      attempts++;
      const requestBody = await request.json();
      if (sidecarMode === "503") {
        return new Response(JSON.stringify({ error: { type: "session_busy" } }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if (sidecarMode === "500") {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (sidecarMode === "invalid_json") {
        return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (sidecarMode === "invalid_body") {
        return Response.json({ body: { model: "wrong-model", messages: [] } });
      }
      const { gateway, config, ...cleanBody } = requestBody;
      if (sidecarMode === "skipped") {
        return Response.json({ compression_skipped: true, body: cleanBody, skip_reason: "content_too_short" });
      }
      cleanBody.messages = cleanBody.messages.map((m) => (m.role === "tool" ? { ...m, content: "compressed" } : m));
      return Response.json({
        body: cleanBody,
        headers: { "anthropic-beta": "context-management-2025-06-27" },
        tokens_before: 100,
        tokens_after: 60,
        tokens_saved: 40,
      });
    },
  });

  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      providerCalls++;
      providerBody = await request.json();
      return Response.json({
        id: "chatcmpl-smoke",
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      });
    },
  });

  const url = `http://127.0.0.1:${sidecar.port}`;
  const makeBody = () => ({
    model: "synthetic",
    messages: [
      { role: "user", content: "question" },
      { role: "tool", tool_call_id: "tool-1", content: "long text" },
    ],
  });

  try {
    // 1. Stateless valid compression
    sidecarMode = "valid";
    const body1 = makeBody();
    const diag1 = {};
    const res1 = await compressWithHeadroom(body1, { url, model: "synthetic", format: "openai", diagnostics: diag1 });
    assert.ok(res1);
    assert.equal(body1.messages[1].content, "compressed");
    const provRes1 = await fetch(`http://127.0.0.1:${provider.port}`, { method: "POST", body: JSON.stringify(body1) });
    assert.equal(provRes1.status, 200);
    assert.equal(providerBody.messages[1].content, "compressed");

    // 2. Stateless 200 compression_skipped -> returns original body
    sidecarMode = "skipped";
    const body2 = makeBody();
    const before2 = structuredClone(body2);
    const diag2 = {};
    const res2 = await compressWithHeadroom(body2, { url, model: "synthetic", format: "openai", diagnostics: diag2 });
    assert.ok(res2);
    assert.equal(res2.compressionSkipped, true);
    assert.deepEqual(body2, before2);
    assert.equal(diag2.reason, "gateway_compression_skipped");

    // 3. Stateless 500 error -> fails open
    sidecarMode = "500";
    const body3 = makeBody();
    const before3 = structuredClone(body3);
    const diag3 = {};
    const res3 = await compressWithHeadroom(body3, { url, model: "synthetic", format: "openai", diagnostics: diag3 });
    assert.equal(res3, null);
    assert.deepEqual(body3, before3);
    assert.equal(diag3.reason, "gateway_http_500");

    // 4. Stateless connection refused -> fails open
    const body4 = makeBody();
    const before4 = structuredClone(body4);
    const diag4 = {};
    const res4 = await compressWithHeadroom(body4, { url: "http://127.0.0.1:1", model: "synthetic", format: "openai", diagnostics: diag4 });
    assert.equal(res4, null);
    assert.deepEqual(body4, before4);
    assert.ok(["gateway_connection_refused", "gateway_fetch_error"].includes(diag4.reason));

    // 5. Session valid compression
    sidecarMode = "valid";
    const body5 = makeBody();
    const diag5 = {};
    const res5 = await compressWithHeadroom(body5, { url, model: "synthetic", format: "openai", sessionId: "sess-smoke-1", diagnostics: diag5 });
    assert.ok(res5);
    assert.equal(body5.messages[1].content, "compressed");

    // 6. Session HTTP 503 -> fails closed via HEADROOM_SESSION_FAILURE, status 503, retryable true
    sidecarMode = "503";
    const body6 = makeBody();
    let err6 = null;
    try {
      await compressWithHeadroom(body6, { url, model: "synthetic", format: "openai", sessionId: "sess-smoke-1" });
    } catch (e) {
      err6 = e;
    }
    assert.ok(err6);
    assert.equal(err6.code, "HEADROOM_SESSION_FAILURE");
    assert.equal(err6.status, 503);
    assert.equal(err6.retryable, true);

    // 7. Session connection refused -> fails closed via HEADROOM_SESSION_FAILURE, status 503, retryable true
    const body7 = makeBody();
    let err7 = null;
    try {
      await compressWithHeadroom(body7, { url: "http://127.0.0.1:1", model: "synthetic", format: "openai", sessionId: "sess-smoke-1" });
    } catch (e) {
      err7 = e;
    }
    assert.ok(err7);
    assert.equal(err7.code, "HEADROOM_SESSION_FAILURE");
    assert.equal(err7.status, 503);
    assert.equal(err7.retryable, true);

    // 8. Session invalid response (invalid JSON) -> fails closed via HEADROOM_SESSION_FAILURE, status 502
    sidecarMode = "invalid_json";
    const body8 = makeBody();
    let err8 = null;
    try {
      await compressWithHeadroom(body8, { url, model: "synthetic", format: "openai", sessionId: "sess-smoke-1" });
    } catch (e) {
      err8 = e;
    }
    assert.ok(err8);
    assert.equal(err8.code, "HEADROOM_SESSION_FAILURE");
    assert.equal(err8.status, 502);

    // 9. Session invalid body invariant -> fails closed via HEADROOM_SESSION_FAILURE, status 502
    sidecarMode = "invalid_body";
    const body9 = makeBody();
    let err9 = null;
    try {
      await compressWithHeadroom(body9, { url, model: "synthetic", format: "openai", sessionId: "sess-smoke-1" });
    } catch (e) {
      err9 = e;
    }
    assert.ok(err9);
    assert.equal(err9.code, "HEADROOM_SESSION_FAILURE");
    assert.equal(err9.status, 502);

    // 10. Session compression_skipped -> fails closed via HEADROOM_SESSION_FAILURE, status 502
    sidecarMode = "skipped";
    const body10 = makeBody();
    let err10 = null;
    try {
      await compressWithHeadroom(body10, { url, model: "synthetic", format: "openai", sessionId: "sess-smoke-1" });
    } catch (e) {
      err10 = e;
    }
    assert.ok(err10);
    assert.equal(err10.code, "HEADROOM_SESSION_FAILURE");
    assert.equal(err10.status, 502);
    assert.equal(err10.reason, "session_compression_skipped");

    // 11. Concurrent session calls
    sidecarMode = "valid";
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, (_, i) => {
        const b = makeBody();
        return compressWithHeadroom(b, { url, model: "synthetic", format: "openai", sessionId: `concurrent-${i}` });
      })
    );
    assert.equal(concurrent.filter(Boolean).length, 4);

    console.log(JSON.stringify({
      mode: "offline",
      attempts,
      providerCalls,
      sessionFailures: "verified",
      statelessFailOpen: "verified",
      concurrentSessions: 4,
    }));
  } finally {
    sidecar.stop(true);
    provider.stop(true);
  }
} else {
  const image = "ghcr.io/headroomlabs-ai/headroom:0.38.0@sha256:14e3dda1f041eef509af850ac7a32647d1c3e5d9bd66e3e8655dfd3a398273af";
  const docker = (...args) => {
    const proc = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${new TextDecoder().decode(proc.stderr).trim()}`);
    return new TextDecoder().decode(proc.stdout).trim();
  };
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error(`Docker local/staging unavailable; prepare image with: docker pull ${image}`);
  }
  const context = docker("context", "inspect", "--format", "{{json .Endpoints.docker.Host}}");
  if (!/^"(unix:\/\/|npipe:\/\/)/.test(context)) throw new Error("Docker context is not local; refusing sidecar benchmark");
  docker("image", "inspect", image, "--format", "{{.Id}}");
  const { randomBytes } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { callHeadroomGateway } = await import("../../open-sse/rtk/headroomGateway.js");
  const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
  const { validateBodyInvariants } = await import("../../open-sse/rtk/headroomInvariants.js");
  const name = `9router-headroom-test-${process.pid}-${Date.now()}`;
  const token = randomBytes(24).toString("hex");
  const env = [
    "HEADROOM_COMPRESS_ALLOW_REMOTE=1",
    "HEADROOM_SKIP_UPSTREAM_CHECK=1",
    "HEADROOM_DISABLE_KOMPRESS=1",
    "HEADROOM_DISABLE_KOMPRESS_FALLBACK=1",
    "HEADROOM_TOOL_SEARCH=0",
    "HEADROOM_OUTPUT_SHAPER=0",
    "HEADROOM_MODEL_ROUTER_ENABLED=0",
    "HEADROOM_OFFLINE=1",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    `HEADROOM_PROXY_TOKEN=${token}`,
  ];
  const percentiles = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const pick = (p) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null);
    return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
  };
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  const memoryBytes = (text) => {
    const match = /([\d.]+)\s*(B|KiB|MiB|GiB)/.exec(text);
    return match ? Math.round(Number(match[1]) * 1024 ** ({ B: 0, KiB: 1, MiB: 2, GiB: 3 }[match[2]])) : null;
  };
  const filler = (size) =>
    JSON.stringify(
      Array.from({ length: Math.ceil(size / 88) }, (_, i) => ({
        file: `src/file-${i % 120}.js`,
        line: i,
        text: "synthetic repeated search result alpha beta gamma delta epsilon",
      }))
    );
  function fixture(format, size) {
    const text = filler(size);
    const tool = {
      type: "function",
      function: { name: "search", parameters: { type: "object", properties: { path: { type: "string" } } } },
    };
    if (format === "claude") {
      return {
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        tools: [{ name: "search", input_schema: tool.function.parameters }],
        system: [{ type: "text", text: "Synthetic instructions" }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "search", input: { path: "config.json" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: text }, { type: "text", text: "continue" }] },
        ],
      };
    }
    if (format === "openai-responses") {
      return {
        model: "gpt-5",
        tools: [tool],
        input: [
          { type: "function_call", call_id: "call_1", name: "search", arguments: "{\"path\":\"config.json\"}" },
          { type: "function_call_output", call_id: "call_1", output: text },
        ],
      };
    }
    return {
      model: "gpt-4o",
      tools: [tool],
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"path\":\"config.json\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: text },
        { role: "user", content: "continue" },
      ],
    };
  }
  let owned = false;
  try {
    docker(
      "run",
      "--pull=never",
      "--detach",
      "--name",
      name,
      "--cpus",
      "1",
      "--memory",
      "1024m",
      "--network",
      "host",
      ...env.flatMap((value) => ["--env", value]),
      image
    );
    owned = true;
    const url = "http://127.0.0.1:8787";
    async function ready() {
      let lastProbe = "none";
      for (let n = 0; n < 120; n++) {
        try {
          const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) return;
          lastProbe = `HTTP ${response.status}`;
        } catch (error) {
          lastProbe = `${error?.cause?.code || error?.name || "fetch_failed"}${error?.cause?.message ? `: ${error.cause.message}` : ""}`;
        }
        await Bun.sleep(1000);
      }
      const state = docker("inspect", "--format", "{{.State.Status}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}", name);
      const logs = Bun.spawnSync(["docker", "logs", "--tail", "30", name], { stdout: "pipe", stderr: "pipe" });
      const recent = `${new TextDecoder().decode(logs.stdout)}\n${new TextDecoder().decode(logs.stderr)}`.replaceAll(token, "[redacted]");
      throw new Error(`Headroom v0.38.0 /readyz did not become ready within 120s; last probe: ${lastProbe}; state: ${state}; logs: ${recent}`);
    }
    await ready();
    const version = docker("exec", name, "python", "-c", "import headroom; from headroom._version import __version__; print(__version__)");
    assert.equal(version, "0.38.0");
    if (process.argv.includes("--probe")) {
      const probeResults = [];
      for (const format of ["openai", "claude", "openai-responses"]) {
        const body = fixture(format, 262144);
        const before = bytes(body);
        const diagnostics = {};
        const result = await compressWithHeadroom(body, { url, proxyToken: token, model: body.model, format, diagnostics });
        const after = bytes(body);
        assert.ok(result && after < before, `${format} did not compress synthetic tool result: ${JSON.stringify({ accepted: Boolean(result), before, after, diagnostics, transforms: result?.transforms_applied })}`);
        const item = {
          format,
          before,
          after,
          tokensBefore: result.tokens_before,
          tokensAfter: result.tokens_after,
          transforms: result.transforms_applied,
          reason: diagnostics.reason || null,
        };
        probeResults.push(item);
        console.log(JSON.stringify(item));
      }
      if (output) {
        await writeFile(output, JSON.stringify({ image, version, mode: "probe", results: probeResults }, null, 2));
      }
    } else {
      const isFull = process.argv.includes("--full");
      const transports = isFull ? ["raw", "facade"] : ["facade"];
      const concurrencies = isFull ? [1, 4, 8] : [1, 8];
      const coldWaves = isFull ? 10 : 2;
      const warmupSamples = isFull ? 8 : 3;
      const warmSamples = isFull ? 100 : 16;
      const report = { image, version, hardware: { cpus: cpus().length, totalMemoryBytes: totalmem() }, cases: [], prefix: null };
      async function sample(format, size, sampleMode) {
        const input = fixture(format, size);
        const inputBytes = bytes(input);
        assert.ok(inputBytes >= size && inputBytes <= 20 * 1024 * 1024, "Synthetic payload size out of bounds");
        const original = sampleMode === "facade" ? structuredClone(input) : input;
        const diag = {};
        const started = performance.now();
        const result =
          sampleMode === "raw"
            ? await callHeadroomGateway({ url, proxyToken: token, body: input, model: input.model, diagnostics: diag })
            : await compressWithHeadroom(input, { url, proxyToken: token, model: input.model, format, diagnostics: diag });
        const accepted = Boolean(result);
        const outputBody = sampleMode === "raw" ? result?.compressedBody : input;
        if (accepted && outputBody) {
          assert.equal(validateBodyInvariants(original, outputBody, { obligations: result?.obligations, turnId: result?.turnId }).valid, true);
        }
        return {
          accepted,
          reason: diag.reason || null,
          latencyMs: diag.latencyMs ?? null,
          elapsedMs: performance.now() - started,
          inputBytes,
          outputBytes: accepted ? bytes(outputBody) : null,
          tokensBefore: result?.tokens_before ?? null,
          tokensAfter: result?.tokens_after ?? null,
        };
      }
      for (const transport of transports) {
        for (const format of ["openai", "claude", "openai-responses"]) {
          for (const size of [16384, 262144, 2097152]) {
            for (const concurrency of concurrencies) {
              let peakObservedMemoryBytes = 0;
              const observeMemory = () => {
                peakObservedMemoryBytes = Math.max(
                  peakObservedMemoryBytes,
                  memoryBytes(docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name)) || 0
                );
              };
              const summary = { transport, format, targetBytes: size, concurrency };
              for (const phase of ["cold", "warm"]) {
                const rows = [];
                if (phase === "cold") {
                  for (let wave = 0; wave < coldWaves; wave++) {
                    docker("restart", name);
                    await ready();
                    rows.push(...(await Promise.all(Array.from({ length: concurrency }, () => sample(format, size, transport)))));
                    observeMemory();
                  }
                } else {
                  for (let n = 0; n < warmupSamples; n += concurrency) {
                    await Promise.all(Array.from({ length: Math.min(concurrency, warmupSamples - n) }, () => sample(format, size, transport)));
                  }
                  for (let n = 0; n < warmSamples; n += concurrency) {
                    rows.push(...(await Promise.all(Array.from({ length: Math.min(concurrency, warmSamples - n) }, () => sample(format, size, transport)))));
                  }
                  observeMemory();
                }
                summary[phase] = {
                  samples: rows.length,
                  accepted: rows.filter((r) => r.accepted).length,
                  skipped: rows.filter((r) => r.reason === "gateway_compression_skipped").length,
                  compressed: rows.filter((r) => r.accepted && r.outputBytes < r.inputBytes).length,
                  timeouts: rows.filter((r) => r.reason === "gateway_timeout").length,
                  circuitBypass: 0,
                  invariantRejects: rows.filter((r) => r.reason === "invariant_violation").length,
                  latency: percentiles(rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs)),
                  inputBytes: rows.reduce((sum, r) => sum + r.inputBytes, 0),
                  outputBytes: rows.reduce((sum, r) => sum + (r.outputBytes || 0), 0),
                  tokenDelta: rows.reduce((sum, r) => sum + ((r.tokensBefore || 0) - (r.tokensAfter || 0)), 0),
                };
              }
              summary.peakObservedContainerMemoryBytes = peakObservedMemoryBytes;
              report.cases.push(summary);
            }
          }
        }
      }
      const counts = Object.fromEntries(
        ["openai", "claude", "openai-responses"].map((fmt) => [
          fmt,
          report.cases.filter((item) => item.format === fmt).reduce((n, item) => n + item.warm.accepted + item.cold.accepted, 0),
        ])
      );
      report.acceptedByFormat = counts;
      if (output) await writeFile(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      assert.ok(Object.values(counts).every((count) => count > 0), "At least one format had zero accepted compression results");
    }
  } finally {
    if (owned) {
      docker("stop", name);
      docker("rm", name);
    }
  }
}
