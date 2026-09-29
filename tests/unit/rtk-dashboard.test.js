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

  it("distinguishes missing results, unsupported text and unlinked calls", async () => {
    let requests = 0;
    await setup(() => { requests++; return output("shortened"); });
    const raw = "x".repeat(800);
    const absent = { input: [{ type: "message", content: "hello" }] };
    const nonText = { input: [{ type: "function_call_output", call_id: "orphan", output: [{ type: "input_image", image_url: "synthetic" }] }] };
    const orphan = { input: [{ type: "function_call_output", call_id: "orphan", output: raw }] };
    for (const prepared of [absent, nonText, orphan]) {
      const original = structuredClone(prepared);
      await compressor.compressMessages(prepared, true);
      expect(prepared).toEqual(original);
    }
    await compressor.compressMessages(body(raw), false);
    const snapshot = state.getRtkSnapshot();
    expect(snapshot.usage.eligibility).toMatchObject({ toolResults: 2, textLeaves: 1, resultsWithoutText: 1, noToolResultsPreparations: 1, rejected: { unlinked_call: 1 } });
    expect(snapshot.usage.http.attempts).toBe(0);
    expect(requests).toBe(0);
    snapshot.usage.eligibility.rejected.unlinked_call = 900;
    snapshot.usage.eligibility.toolResults = 900;
    expect(state.getRtkSnapshot().usage.eligibility).toMatchObject({ toolResults: 2, rejected: { unlinked_call: 1 } });
  });

  it("classifies Responses function/custom outputs while preserving rejected payloads", async () => {
    let requests = 0;
    await setup(() => { requests++; return output("shortened"); });
    const raw = "x".repeat(800);
    const cases = [
      { type: "function", name: "functions.bash", input: { command: "git diff" }, reason: null },
      { type: "function", name: "functions.bash", input: { command: "cd /repo && git diff" }, reason: null },
      { type: "custom_tool", name: "Bash", input: "git diff", reason: null },
      { type: "custom_tool", name: "Bash", input: "git -C '/repo (test)' diff", reason: null },
      { type: "function", name: "functions.read", input: { path: "synthetic" }, reason: "missing_command" },
      { type: "function", name: "functions.grep", input: { pattern: "x", path: "synthetic" }, reason: "missing_command" },
      { type: "function", name: "Bash", input: { command: "pwd && git diff" }, reason: "unsupported_shell_syntax" },
      { type: "function", name: "Bash", input: { command: "git status && git diff" }, reason: "unsupported_shell_syntax" },
      { type: "function", name: "Bash", input: { command: "git diff --stat" }, reason: "unsupported_output_format" },
      { type: "function", name: "Bash", input: { command: "cargo clippy" }, reason: "unsupported_mode" },
      { type: "function", name: "Bash", input: { command: "unknown-command" }, reason: "unsupported_command" },
      { type: "function", name: "Bash", input: { command: "rtk git diff" }, reason: "already_rtk" },
      { type: "function", name: "Bash", input: { command: "git diff", cmd: "git status" }, reason: "invalid_command_metadata" },
      { type: "function", name: "Bash", input: { command: "x".repeat(8193) }, reason: "metadata_limit" },
    ];
    for (const [index, example] of cases.entries()) {
      const type = example.type === "custom_tool" ? "custom_tool_call" : "function_call";
      const prepared = { input: [
        { type, call_id: `c${index}`, name: example.name, [example.type === "custom_tool" ? "input" : "arguments"]: example.type === "custom_tool" ? example.input : JSON.stringify(example.input) },
        { type: `${type}_output`, call_id: `c${index}`, output: raw },
      ] };
      await compressor.compressMessages(prepared, true);
      expect(prepared.input[1].output).toBe(example.reason ? raw : "shortened");
    }
    const eligibility = state.getRtkSnapshot().usage.eligibility;
    expect(eligibility).toMatchObject({ toolResults: cases.length, textLeaves: cases.length, resultsWithoutText: 0, rejected: {
      missing_command: 2, unsupported_shell_syntax: 2, unsupported_output_format: 1, unsupported_mode: 1,
      unsupported_command: 1, already_rtk: 1, invalid_command_metadata: 1, metadata_limit: 1,
    } });
    expect(requests).toBe(4);
    expect(state.getRtkSnapshot().usage.http.attempts).toBe(4);
  });

  it("assigns one rejection per leaf in gate order, including duplicate calls", async () => {
    let requests = 0;
    await setup(() => { requests++; return output("shortened"); });
    const raw = "x".repeat(800);
    const samples = [
      { content: "x".repeat(499), is_error: true, expected: "error_result" },
      { content: "€".repeat(166), expected: "below_min_bytes" },
      { content: "x".repeat(10_485_761), expected: "above_max_bytes" },
      { content: raw, duplicate: true, expected: "unlinked_call" },
    ];
    for (const example of samples) {
      const prepared = body(example.content);
      if (example.is_error) prepared.messages[1].is_error = true;
      if (example.duplicate) prepared.messages[0].tool_calls.push(call());
      const original = structuredClone(prepared);
      await compressor.compressMessages(prepared, true);
      expect(prepared).toEqual(original);
      expect(state.getRtkSnapshot().usage.eligibility.rejected[example.expected]).toBe(1);
    }
    const budgeted = { messages: [{ role: "assistant", tool_calls: [call()] },
      { role: "tool", tool_call_id: "call", content: "x".repeat(10_485_000) },
      { role: "tool", tool_call_id: "call", content: raw }] };
    await compressor.compressMessages(budgeted, true);
    expect(budgeted.messages[2].content).toBe(raw);
    expect(state.getRtkSnapshot().usage.eligibility.rejected.selection_budget).toBe(1);
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

  it("diagnoses sidecar empty, unchanged, larger and applied outcomes with fallback separation", async () => {
    let step = 0;
    await setup((_, input) => {
      step++;
      if (step === 1) return output("");
      if (step === 2) return output(input.content);
      if (step === 3) return output(input.content + "extra_bytes");
      return output("x".repeat(50));
    });

    // 1: empty_output
    const raw = "x".repeat(1000);
    await compressor.compressMessages(body(raw), true);
    // 2: not_smaller (equal)
    await compressor.compressMessages(body(raw), true);
    // 3: not_smaller (larger)
    await compressor.compressMessages(body(raw), true);
    // 4: applied
    await compressor.compressMessages(body(raw), true);

    const snap = state.getRtkSnapshot();
    const emptyRow = snap.diagnostics.filters.find(r => r.outcome === "empty_output");
    const notSmallerRow = snap.diagnostics.filters.find(r => r.outcome === "not_smaller");
    const appliedRow = snap.diagnostics.filters.find(r => r.outcome === "applied");
    expect(emptyRow).toBeDefined();
    expect(notSmallerRow).toBeDefined();
    expect(notSmallerRow.count).toBe(2);
    expect(appliedRow).toBeDefined();

    // git-status unchanged triggers fallback row with fallback: true
    step = 0;
    const statusText = "## master...origin/master\n M file1.txt\n\n".repeat(25);
    const statusCall = () => ({ id: "c_stat", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "git status" }) } });
    const statusBody = { messages: [{ role: "assistant", tool_calls: [statusCall()] }, { role: "tool", tool_call_id: "c_stat", content: statusText }] };
    await compressor.compressMessages(statusBody, true);
    const snap2 = state.getRtkSnapshot();
    const fallbackRow = snap2.diagnostics.filters.find(r => r.filter === "git-status" && r.fallback === true);
    expect(fallbackRow).toBeDefined();
    expect(fallbackRow.engine).toBe("local");
  });

  it("isolates concurrent preparation outcomes and tracks aborted candidates as discarded", async () => {
    await setup((_, input) => {
      if (input?.filter === "ctest") return output(input.content);
      return output("x".repeat(100));
    });
    const raw = "x".repeat(1000);
    const ctestCall = () => ({ id: "c_test", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "ctest" }) } });
    const ctestBody = { messages: [{ role: "assistant", tool_calls: [ctestCall()] }, { role: "tool", tool_call_id: "c_test", content: raw }] };
    const diffBody = body(raw);

    // Concurrent preparations
    await Promise.all([
      compressor.compressMessages(ctestBody, true),
      compressor.compressMessages(diffBody, true),
    ]);

    const snap = state.getRtkSnapshot();
    const ctestOutcome = snap.diagnostics.filters.find(r => r.filter === "ctest");
    const diffOutcome = snap.diagnostics.filters.find(r => r.filter === "git-diff" && r.outcome === "applied");
    expect(ctestOutcome.outcome).toBe("not_smaller");
    expect(diffOutcome.outcome).toBe("applied");

    // External abort causes discarded_cancelled without applying candidate
    const abortController = new AbortController();
    const abortBody = body(raw);
    const abortPromise = compressor.compressMessages(abortBody, true, { signal: abortController.signal });
    abortController.abort(new Error("client canceled"));
    await expect(abortPromise).rejects.toThrow("client canceled");
    expect(abortBody.messages[1].content).toBe(raw);

    // checkRtkConnection does not add diagnostic rows for real preparations
    const filtersCountBefore = state.getRtkSnapshot().diagnostics.filters.length;
    await client.checkRtkConnection();
    expect(state.getRtkSnapshot().diagnostics.filters.length).toBe(filtersCountBefore);
  });

  it("preserves privacy: sentinels never appear in diagnostics, irrelevant tools are omitted, and dictionary bounds overflow", async () => {
    await setup(() => output("x".repeat(100)));
    const logs = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(msg => { if (typeof msg === "string" && msg.startsWith("[RTK diagnostics]")) logs.push(msg); });
    try {
      const sentinel = "SECRET_SENTINEL_XYZ_999";
      const secretBody = {
        messages: [
          { role: "assistant", tool_calls: [{ id: "c_sec", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: `git log --${sentinel}`, path: `/${sentinel}/file.js`, error: sentinel }) } }] },
          { role: "tool", tool_call_id: "c_sec", content: `sensitive output with ${sentinel}\n`.repeat(25) },
        ],
      };
      await compressor.compressMessages(secretBody, true);
      const snap = state.getRtkSnapshot();
      const serialized = JSON.stringify(snap.diagnostics);
      expect(serialized).not.toContain(sentinel);
      expect(logs.some(l => l.includes(sentinel))).toBe(false);

      // Irrelevant tool families (read, other) are not recorded in rejections
      const otherBody = {
        messages: [
          { role: "assistant", tool_calls: [{ id: "c_other", type: "function", function: { name: "custom_irrelevant_tool", arguments: JSON.stringify({ arg: "test" }) } }] },
          { role: "tool", tool_call_id: "c_other", content: "some file or other output\n".repeat(25) },
        ],
      };
      await compressor.compressMessages(otherBody, true);
      const snap2 = state.getRtkSnapshot();
      expect(snap2.diagnostics.rejections.some(r => r.toolFamily === "other")).toBe(false);
      expect(snap2.diagnostics.rejections.some(r => r.toolFamily === "read")).toBe(false);

      // Bound dictionary: overflow increments beyond 128 rows for tracked families
      const families = ["shell", "grep", "glob"];
      const details = ["none", "no_command", "native_metadata_missing", "native_output_mismatch", "serialized_metadata_limit", "command_length_limit"];
      let combinations = 0;
      for (const fam of families) {
        for (const det of details) {
          for (const reason of ["error_result", "cache_marker", "below_min_bytes", "above_max_bytes", "selection_budget", "unsupported_shell_syntax", "unsupported_command", "unsupported_mode"]) {
            state.recordRtkRejection(fam, reason, det, 100);
            combinations++;
          }
        }
      }
      expect(combinations).toBeGreaterThan(128);
      const snapAfter = state.getRtkSnapshot();
      expect(snapAfter.diagnostics.rejections.length).toBeLessThanOrEqual(128);
      expect(snapAfter.diagnostics.overflow.rejections).toBeGreaterThan(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("throttles diagnostics log to 60s window and captures cumulative counts", async () => {
    await setup(() => output("x".repeat(100)));
    const logs = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(msg => { if (typeof msg === "string" && msg.startsWith("[RTK diagnostics]")) logs.push(msg); });
    let mockTime = 1000;
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => mockTime);
    try {
      const raw = "x".repeat(1000);
      // 1st preparation: emits log immediately
      await compressor.compressMessages(body(raw), true);
      expect(logs.length).toBe(1);
      const firstPayload = JSON.parse(logs[0].replace("[RTK diagnostics] ", ""));
      expect(firstPayload.preparations).toBe(1);

      // 2nd preparation at +10s: throttled, no new log
      mockTime += 10_000;
      await compressor.compressMessages(body(raw), true);
      expect(logs.length).toBe(1);

      // 3rd preparation at +65s: emits log with cumulative counts
      mockTime += 55_000;
      await compressor.compressMessages(body(raw), true);
      expect(logs.length).toBe(2);
      const secondPayload = JSON.parse(logs[1].replace("[RTK diagnostics] ", ""));
      expect(secondPayload.preparations).toBe(3);

      // RTK disabled does not emit diagnostics log
      const countBefore = logs.length;
      mockTime += 70_000;
      await compressor.compressMessages(body(raw), false);
      expect(logs.length).toBe(countBefore);
    } finally {
      perfSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
