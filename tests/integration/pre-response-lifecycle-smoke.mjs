import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--child")) {
  const root = await mkdtemp(join(tmpdir(), "router-lifecycle-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, DATA_DIR: root,
    ROUTER_PRE_RESPONSE_BUDGET_MS: "200", SSE_HEARTBEAT_INTERVAL_MS: "50" };
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child"], { env, stdout: "inherit", stderr: "inherit" });
    const timeout = setTimeout(() => child.kill(), 15_000);
    const code = await child.exited;
    clearTimeout(timeout);
    assert.equal(code, 0, `network lifecycle smoke exited ${code}`);
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const { BaseExecutor } = await import("../../open-sse/executors/base.js");
  const { withPreResponseBudget } = await import("../../open-sse/utils/preResponseBudget.js");
  const { withWireHeartbeat } = await import("../../open-sse/utils/streamHandler.js");
  const { fetchWithTimeout } = await import("../../open-sse/services/usage/shared.js");
  const bytes = (s) => new TextEncoder().encode(s);
  let cancelled = 0;
  let quotaCalls = 0;
  const wireCancelled = { sse: false, ndjson: false };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/quota" && ++quotaCalls > 1) return Response.json({ ok: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes(" ")); },
      cancel() { cancelled++; },
    }), { headers: { "content-type": "application/json" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const downstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const format = new URL(request.url).pathname.slice(1);
    if (format === "sse" || format === "ndjson") {
      const content = format === "sse" ? "data: hello\\n\\n" : '{"ok":true}\\n';
      let pending;
      const inner = new Response(new ReadableStream({
        start(controller) { pending = setTimeout(() => controller.enqueue(bytes(content.replaceAll("\\n", "\n"))), 250); },
        cancel() { clearTimeout(pending); wireCancelled[format] = true; },
      }), { headers: { "content-type": format === "sse" ? "text/event-stream" : "application/x-ndjson" } });
      return withPreResponseBudget(request, async () => withWireHeartbeat(inner, { format }));
    }
    return withPreResponseBudget(request, async (budget) => {
      const result = await new BaseExecutor("test", { baseUrl: `${base}/body` }).execute({
        model: "m", body: {}, stream: false, credentials: { apiKey: "placeholder" }, preResponse: budget,
      });
      await result.response.json();
      return Response.json({ ok: true });
    });
  } });
  try {
    const response = await fetch(`http://127.0.0.1:${downstream.port}`);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.type, "gateway_timeout");
    await Bun.sleep(50);
    assert.ok(cancelled > 0, "upstream body should cancel");
    console.log("PASS body deadline cancels upstream");

    const quota = await fetchWithTimeout(`${base}/quota`, {}, 100);
    await assert.rejects(quota.json(), /Timeout after 100ms/);
    assert.deepEqual(await (await fetchWithTimeout(`${base}/quota`, {}, 100)).json(), { ok: true });
    console.log("PASS quota full-body timeout");

    async function heartbeat(format, content, expected) {
      const final = await fetch(`http://127.0.0.1:${downstream.port}/${format}`);
      assert.equal(final.status, 200);
      const reader = final.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.equal(first, expected);
      let beforeContent = first;
      let second = "";
      const untilContent = Date.now() + 1000;
      while (Date.now() < untilContent) {
        const next = new TextDecoder().decode((await reader.read()).value);
        if (next.includes(content)) { second = next; break; }
        beforeContent += next;
      }
      assert.equal(second, content);
      if (format === "ndjson") assert.deepEqual(JSON.parse(beforeContent + second), { ok: true });
      console.log(`PASS final-wire ${format === "sse" ? "SSE" : "NDJSON"} heartbeat`);
      await reader.cancel("client closed");
      const until = Date.now() + 1000;
      while (!wireCancelled[format] && Date.now() < until) await Bun.sleep(10);
      assert.ok(wireCancelled[format], "server stream must cancel after client leaves");
      console.log("PASS post-handoff client cancel");
    }
    await heartbeat("sse", "data: hello\n\n", ": keepalive\n\n");
    await heartbeat("ndjson", '{"ok":true}\n', " ");
  } finally { downstream.stop(true); upstream.stop(true); }
}
