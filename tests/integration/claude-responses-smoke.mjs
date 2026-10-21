import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual HTTP transport + handleChatCore, with disposable state and synthetic
// Anthropic data only. No provider account, dashboard, or public listener.
if (!process.argv.includes("--child")) {
  const root = await mkdtemp(join(tmpdir(), "router-claude-responses-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, DATA_DIR: root,
    NODE_ENV: "production", ENABLE_REQUEST_LOGS: "false", CLAUDE_CONTINUATION_SECRET: "offline-fixture-secret-not-for-production-0001" };
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child"], { env, stdout: "inherit", stderr: "inherit" });
    const timeout = setTimeout(() => child.kill(), 60_000);
    const code = await child.exited;
    clearTimeout(timeout);
    assert.equal(code, 0, `offline Claude smoke exited ${code}`);
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const { createSSERecordParser } = await import("../../open-sse/utils/sseRecordParser.js");
  const model = "claude-sonnet-4-6";
  const provider = "anthropic-compatible-offline";
  const encoder = new TextEncoder();
  let calls = 0;
  let replayChecked = false;
  let upstreamClosed = false;
  let cancelled = 0;
  const answer = "Xin chào 😀";
  const customInput = "printf 'xin chào 😀'\n";
  const start = { type: "message_start", message: { id: "msg_offline", model, role: "assistant", content: [], usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 0 } } };
  const text = [start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
  const tool = [start, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Use the declared tool." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signed-thinking" } },
    { type: "content_block_stop", index: 0 }, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_offline", name: "shell", input: {} } },
    ...Array.from(JSON.stringify({ input: customInput })).map(char => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: char } })),
    { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }, { type: "message_stop" }];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    calls++;
    assert.equal(new URL(request.url).pathname, "/messages");
    assert.equal(request.headers.get("x-api-key"), "offline-dummy-key");
    assert.equal(body.model, model);
    assert.equal(body._directResponsesToClaude, undefined);
    const replay = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === "tool_result");
    if (replay) {
      const thinking = body.messages.flatMap(m => m.content).find(b => b.type === "thinking");
      assert.equal(thinking.signature, "synthetic-signed-thinking");
      assert.equal(thinking.thinking, "Use the declared tool.");
      assert.equal(replay.tool_use_id, "toolu_offline");
      replayChecked = true;
    }
    if (!body.stream) return Response.json({ id: "msg_json", type: "message", model, role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 5, output_tokens: 3 } });
    const prompt = JSON.stringify(body.messages);
    const events = body.tools?.some(t => t.name === "shell") && !replay ? tool : prompt.includes("sse-error") ? [start, { type: "error", error: { type: "overloaded_error", message: "offline overloaded" } }] : prompt.includes("truncate") ? text.slice(0, 3) : text;
    upstreamClosed = false;
    let stopped = false;
    return new Response(new ReadableStream({
      async start(controller) {
        try {
          for (const event of events) {
            if (stopped) return;
            const bytes = encoder.encode(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
            // Every event crosses arbitrary byte boundaries, including UTF-8.
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
            await Bun.sleep(1);
          }
          await Bun.sleep(20);
          if (!stopped) { upstreamClosed = true; controller.close(); }
        } catch (error) { if (!stopped) controller.error(error); }
      },
      cancel() { stopped = true; cancelled++; },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const native = new URL(request.url).pathname === "/messages";
    const body = await request.json();
    const result = await handleChatCore({ body, modelInfo: { provider, model }, credentials: { apiKey: "offline-dummy-key", providerSpecificData: { baseUrl: `http://127.0.0.1:${upstream.port}` } },
      sourceFormatOverride: native ? "claude" : "openai-responses", connectionId: "offline-account", apiKey: "offline-client", clientSignal: request.signal,
      clientRawRequest: { endpoint: native ? "/v1/messages" : "/v1/responses", body, headers: {} } });
    return result.response;
  } });
  const base = `http://127.0.0.1:${gateway.port}`;
  async function request(body, native = false, observe = null) {
    const t0 = performance.now();
    const response = await fetch(`${base}/${native ? "messages" : "responses"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!body.stream || !response.ok) return { response, json: await response.json() };
    const decoder = new TextDecoder();
    const events = [];
    let firstContent = null, terminal = null;
    const parser = createSSERecordParser(raw => {
      const data = raw.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("\n").trim();
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      events.push(event);
      if (event.delta?.text || event.type === "response.output_text.delta") firstContent ??= performance.now() - t0;
      if (event.type === "message_stop" || ["response.completed", "response.failed", "response.incomplete"].includes(event.type)) terminal ??= performance.now() - t0;
      observe?.(event);
    });
    const reader = response.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; parser.write(decoder.decode(value, { stream: true })); }
    parser.write(decoder.decode()); parser.end();
    return { response, events, firstContent, terminal };
  }
  const input = [{ role: "user", content: "hello" }];
  try {
    const first = await request({ model, input, stream: true, tools: [{ type: "custom", name: "shell" }], parallel_tool_calls: false });
    const result = first.events.find(e => e.type === "response.completed").response;
    assert.equal(result.output.find(i => i.type === "custom_tool_call").input, customInput);
    assert.ok(result.output.find(i => i.type === "reasoning").encrypted_content.startsWith("ccr1."));
    await request({ model, input: [...input, ...result.output, { type: "custom_tool_call_output", call_id: "toolu_offline", output: "ok" }], tools: [{ type: "custom", name: "shell" }], stream: true });
    assert.equal(replayChecked, true);
    const json = await request({ model, input, stream: false });
    assert.equal(json.json.object, "response"); assert.equal(json.json.status, "incomplete"); assert.equal(json.json.usage.input_tokens, 5);
    for (const prompt of ["sse-error", "truncate"]) {
      const failure = await request({ model, input: prompt, stream: true });
      assert.equal(failure.events.filter(e => ["response.failed", "response.completed"].includes(e.type)).length, 1);
      assert.equal(failure.events.at(-1).type, "response.failed");
    }
    const before = calls;
    const unsupported = await request({ model, input, previous_response_id: "resp_unavailable", stream: true });
    assert.equal(unsupported.response.status, 400); assert.equal(calls, before);
    await request({ model, input, stream: true }, false, e => { if (e.type === "response.output_text.delta") assert.equal(upstreamClosed, false, "text must arrive before upstream EOF"); });
    console.log("PASS real loopback HTTP: direct tools + signed continuation, stream:false, error/truncation, unsupported predispatch, text before EOF");
    const samples = [];
    for (let i = 0; i < 35; i++) {
      const native = await request({ model, messages: input, stream: true }, true);
      const translated = await request({ model, input, stream: true });
      if (i >= 5) samples.push({ native: native.firstContent, translated: translated.firstContent, excess: translated.firstContent - native.firstContent });
    }
    const quantile = (key, q) => samples.map(s => s[key]).sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1];
    console.log(JSON.stringify({ benchmark: "loopback paired first-content latency; same synthetic upstream schedule, not live-provider latency", samples: samples.length,
      milliseconds: Object.fromEntries(["native", "translated", "excess"].map(key => [key, { p50: +quantile(key, 0.5).toFixed(3), p95: +quantile(key, 0.95).toFixed(3) }])) }));
  } finally { gateway.stop(true); upstream.stop(true); }
}
