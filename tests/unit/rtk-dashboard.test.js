import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";

const KEY = Symbol.for("9router.rtk.runtime.v1");
let server;
let client;
let state;
let compressor;

async function setup(handler) {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const result = handler(request, input, response);
    if (result === null) return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.RTK_URL = `http://127.0.0.1:${server.address().port}/`;
  delete globalThis[KEY];
  vi.resetModules();
  client = await import("../../open-sse/rtk/client.js");
  state = await import("../../open-sse/rtk/state.js");
  compressor = await import("../../open-sse/rtk/index.js");
}

afterEach(async () => {
  globalThis[KEY]?.client.dispatcher?.destroy();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  delete globalThis[KEY];
  delete process.env.RTK_URL;
  server = null;
});

const call = (command = "git diff") => ({ id: "call", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command }) } });
const body = content => ({ messages: [{ role: "assistant", tool_calls: [call()] }, { role: "tool", tool_call_id: "call", content }] });
const output = content => ({ protocolVersion: 1, content });

describe("RTK process dashboard", () => {
  it("reads configuration and session without sidecar I/O", async () => {
    let calls = 0;
    await setup(() => { calls++; return output("shortened"); });
    const first = state.getRtkSnapshot().session.id;
    expect(client.getRtkClientStatus()).toMatchObject({ endpointState: "configured", check: null, active: 0 });
    expect((await import("../../open-sse/rtk/state.js")).getRtkSnapshot().session.id).toBe(first);
    expect(calls).toBe(0);
  });

  it("counts applied leaves, not direct HTTP calls; snapshot is detached", async () => {
    let requests = 0;
    await setup(() => { requests++; return output("x".repeat(100)); });
    const raw = "x".repeat(1000);
    expect(await client.filterToolOutput({ filter: "git-diff", content: raw })).toBe("x".repeat(100));
    expect(state.getRtkSnapshot().usage.appliedOutputs).toBe(0);
    const original = body(raw);
    const prepared = structuredClone(original);
    const stats = await compressor.compressMessages(prepared, true);
    expect(prepared.messages[1].content).toBe("x".repeat(100));
    expect(original.messages[1].content).toBe(raw);
    expect(stats.hits[0].estimatedTokensSaved).toBe(225);
    const snapshot = state.getRtkSnapshot();
    expect(requests).toBe(2);
    expect(snapshot.usage).toMatchObject({ preparations: 1, compressedPreparations: 1, appliedOutputs: 1, bytesBefore: 1000, bytesAfter: 100, estimatedTokensSaved: 225, http: { attempts: 2, succeeded: 2, failed: 0 } });
    snapshot.usage.filters[0].bytesBefore = 0;
    snapshot.usage.http.attempts = 0;
    expect(state.getRtkSnapshot().usage.filters[0].bytesBefore).toBe(1000);
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(2);
    expect((await import("../../open-sse/rtk/state.js")).getRtkSnapshot().session.id).toBe(snapshot.session.id);
  });

  it("tracks UTF-8 bytes without inventing token savings", async () => {
    await setup(() => output("a".repeat(900)));
    const prepared = body("€".repeat(500));
    await compressor.compressMessages(prepared, true);
    expect(state.getRtkSnapshot().usage).toMatchObject({ appliedOutputs: 1, bytesBefore: 1500, bytesAfter: 900, estimatedTokensSaved: 0 });
  });

  it("keeps bypasses, unknown commands and unchanged output out of savings", async () => {
    let requests = 0;
    await setup((_, data) => { requests++; return output(data.content); });
    for (const reason of ["disabled", "opted_out", "structured_output", "native_passthrough"]) await compressor.compressMessages(body("x".repeat(1000)), false, { disabledReason: reason });
    const unknown = body("x".repeat(1000));
    unknown.messages[0].tool_calls[0] = call("unknown-command");
    await compressor.compressMessages(unknown, true);
    const ambiguous = body("x".repeat(1000));
    ambiguous.messages[0].tool_calls.push(call());
    await compressor.compressMessages(ambiguous, true);
    await compressor.compressMessages(body("x".repeat(1000)), true);
    const usage = state.getRtkSnapshot().usage;
    expect(usage.preparationReasons).toMatchObject({ disabled: 1, opted_out: 1, structured_output: 1, native_passthrough: 1, no_eligible_output: 2, no_change: 1 });
    expect(usage.http).toMatchObject({ attempts: 1, succeeded: 1, unchanged: 1 });
    expect(usage.appliedOutputs).toBe(0);
    expect(requests).toBe(1);
  });

  it("probes health, version, identity once without touching usage or circuit", async () => {
    const visited = [];
    await setup((request, input) => {
      visited.push(request.url);
      if (request.url === "/health") return { ok: true, protocolVersion: 1 };
      if (request.url === "/version") return { protocolVersion: 1, rtkVersion: "0.50.0", wrapperRevision: 1, filters: ["grep"] };
      return output(input.content);
    });
    const before = state.getRtkSnapshot().usage;
    const [first, second] = await Promise.all([client.checkRtkConnection(), client.checkRtkConnection()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "passed", rtkVersion: "0.50.0", wrapperRevision: 1 });
    expect((await client.checkRtkConnection()).checkedAt).toBe(first.checkedAt);
    expect(visited).toEqual(["/health", "/version", "/filter"]);
    expect(state.getRtkSnapshot().usage).toEqual(before);
    expect(client.getRtkClientStatus().check.status).toBe("passed");
  });

  it("separates protocol failure, circuit skip and sanitized status", async () => {
    let requests = 0;
    await setup(() => { requests++; return { protocolVersion: 99, content: "secret" }; });
    const raw = "x".repeat(1000);
    expect(await client.filterToolOutput({ content: raw })).toBeNull();
    expect(await client.filterToolOutput({ content: raw })).toBeNull();
    const snapshot = state.getRtkSnapshot();
    expect(snapshot.usage.http).toMatchObject({ attempts: 1, failed: 1 });
    expect(snapshot.usage.skipped.circuit_open).toBe(1);
    expect(requests).toBe(1);
    expect(client.getRtkClientStatus()).toMatchObject({ circuit: "open", lastFailure: { reason: "bad_response" } });
    expect(JSON.stringify(client.getRtkClientStatus())).not.toContain("secret");
  });
  it("tracks rejected/busy calls without opening the circuit", async () => {
    await setup((_, input, response) => { response.statusCode = input.content.startsWith("busy") ? 503 : 413; return { error: "rejected" }; });
    const raw = "x".repeat(1000);
    await client.filterToolOutput({ content: `busy${raw}` });
    await client.filterToolOutput({ content: raw });
    expect(state.getRtkSnapshot().usage.http).toMatchObject({ attempts: 2, busy: 1, rejected: 1, failed: 0, succeeded: 0 });
    expect(client.getRtkClientStatus().circuit).toBe("closed");
  });

  it("counts external cancellation but never applies an aborted clone", async () => {
    await setup((_, input, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); return null; });
    const controller = new AbortController();
    const reason = Object.assign(Error("external deadline"), { code: "RTK_TIMEOUT" });
    const prepared = body("x".repeat(1000));
    const pending = compressor.compressMessages(prepared, true, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 40));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(prepared.messages[1].content).toBe("x".repeat(1000));
    expect(state.getRtkSnapshot().usage).toMatchObject({ appliedOutputs: 0, preparationReasons: { cancelled: 1 }, http: { attempts: 1, cancelled: 1, failed: 0 } });
  });

  it("reports invalid or missing endpoint without network", async () => {
    await setup(() => { throw Error("should not fetch"); });
    delete globalThis[KEY];
    process.env.RTK_URL = "http://user:password@127.0.0.1:1234/";
    expect(client.getRtkClientStatus().endpointState).toBe("invalid");
    expect((await client.checkRtkConnection()).reason).toBe("invalid_url");
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(0);
    delete globalThis[KEY];
    delete process.env.RTK_URL;
    expect(client.getRtkClientStatus().endpointState).toBe("unconfigured");
    expect((await client.checkRtkConnection()).reason).toBe("unconfigured");
  });

  it("fails a malformed check without changing an open request circuit", async () => {
    await setup((request) => request.url === "/health" ? { ok: true, protocolVersion: 1 } : { protocolVersion: 99 });
    state.getRtkState().client.openUntil = Date.now() + 30_000;
    const result = await client.checkRtkConnection();
    expect(result).toMatchObject({ status: "failed", reason: "bad_response", rtkVersion: null });
    expect(client.getRtkClientStatus().circuit).toBe("open");
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(0);
  });
  it("commits only finished leaves on an internal deadline", async () => {
    await setup((_, input, response) => {
      if (input.content.startsWith("B")) { response.setHeader("content-type", "application/json"); response.flushHeaders(); return null; }
      return output("shortened");
    });
    const fast = { ...call(), id: "fast" };
    const slow = { ...call(), id: "slow" };
    const prepared = { messages: [
      { role: "assistant", tool_calls: [fast, slow] },
      { role: "tool", tool_call_id: "fast", content: "A".repeat(1000) },
      { role: "tool", tool_call_id: "slow", content: "B".repeat(1000) },
    ] };
    await compressor.compressMessages(prepared, true);
    expect(prepared.messages.slice(1).map(item => item.content)).toEqual(["shortened", "B".repeat(1000)]);
    expect(state.getRtkSnapshot().usage).toMatchObject({ appliedOutputs: 1, bytesBefore: 1000, bytesAfter: 9, preparationReasons: { timeout: 1 }, http: { attempts: 2, succeeded: 1, failed: 1, timedOut: 1 } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(prepared.messages[2].content).toBe("B".repeat(1000));
    expect(state.getRtkSnapshot().usage.appliedOutputs).toBe(1);
  });

  it("bounds oversized probe bodies", async () => {
    await setup((request, _, response) => request.url === "/health" ? { ok: true, protocolVersion: 1, extra: "x".repeat(66_000) } : output(""));
    expect((await client.checkRtkConnection()).reason).toBe("bad_response");
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(0);
  });

  it("ends a stalled check at the server deadline", async () => {
    await setup((_, input, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); return null; });
    expect((await client.checkRtkConnection()).reason).toBe("timeout");
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(0);
  });

  it("skips fifth in-flight request and accounts external aborts", async () => {
    await setup((_, input, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); return null; });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = controllers.map(controller => client.filterToolOutput({ content: "x".repeat(1000), signal: controller.signal }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(client.getRtkClientStatus().active).toBe(4);
    expect(await client.filterToolOutput({ content: "x".repeat(1000) })).toBeNull();
    const reason = Error("cancel all");
    controllers.forEach(controller => controller.abort(reason));
    await Promise.all(pending.map(promise => expect(promise).rejects.toBe(reason)));
    expect(state.getRtkSnapshot().usage).toMatchObject({ http: { attempts: 4, cancelled: 4, failed: 0 }, skipped: { saturated: 1 } });
    expect(client.getRtkClientStatus().active).toBe(0);
  });
});
