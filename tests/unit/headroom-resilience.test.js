import { describe, it, expect, vi, afterEach } from "vitest";
import { validateBodyInvariants } from "../../open-sse/rtk/headroomInvariants.js";
import { callHeadroomGateway } from "../../open-sse/rtk/headroomGateway.js";
import { resolveHeadroomTimeout } from "../../open-sse/config/runtimeConfig.js";
import { beginHeadroomAttempt, markHeadroomAttemptStarted, finishHeadroomAttempt, getHeadroomRuntimeSnapshot } from "../../open-sse/rtk/headroomRuntime.js";
import { mergeAnthropicBetaHeaders } from "../../open-sse/utils/anthropicBeta.js";
import { formatHeadroomSummaryTag } from "../../open-sse/rtk/headroom.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis[Symbol.for("9router.headroom.runtime")]?.clear();
});

describe("Headroom resilience boundaries", () => {
  it("uses valid ENV before DB; rejects non-decimal ENV and invalid DB", () => {
    expect(resolveHeadroomTimeout(undefined, "")).toEqual({ timeoutMs: 10000, source: "default" });
    expect(resolveHeadroomTimeout(15000, " 12000 ")).toEqual({ timeoutMs: 12000, source: "env" });
    for (const invalid of ["1junk", "-2", "1.5", "Infinity", "2147483648"]) {
      expect(resolveHeadroomTimeout(15000, invalid).timeoutMs).toBe(15000);
    }
    expect(resolveHeadroomTimeout("15000", "").timeoutMs).toBe(10000);
  });

  it("allows text but not valid JSON argument changes, metadata, error traces, or reasoning", () => {
    const body = { model: "claude-sonnet", metadata: { state: null }, messages: [{ role: "assistant", content: [
      { type: "text", text: "long" }, { type: "tool_use", id: "1", input: { path: "config.json" } },
      { type: "tool_result", is_error: true, content: "trace" }, { type: "thinking", thinking: "opaque", signature: "sig" },
    ] }] };
    const compressed = structuredClone(body);
    compressed.messages[0].content[0].text = "short";
    expect(validateBodyInvariants(body, compressed, "claude").valid).toBe(true);
    for (const mutate of [
      (b) => { b.messages[0].content[1].input.path = "other.json"; },
      (b) => { b.messages[0].content[2].content = "hidden"; },
      (b) => { b.messages[0].content[3].signature = "other"; },
      (b) => { b.metadata.state = ""; },
      (b) => { b.messages[0].content[0].text = ["short"]; },
    ]) {
      const changed = structuredClone(compressed);
      mutate(changed);
      expect(validateBodyInvariants(body, changed, "claude").valid).toBe(false);
    }
  });

  it("opens on third service failure, admits one probe, ignores stale success, recovers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const endpoint = "http://127.0.0.1:54321/v1/compress";
    const stale = beginHeadroomAttempt(endpoint).ticket;
    markHeadroomAttemptStarted(stale);
    for (let n = 0; n < 3; n++) {
      const ticket = beginHeadroomAttempt(endpoint, { bypassInFlight: true }).ticket;
      markHeadroomAttemptStarted(ticket);
      expect(finishHeadroomAttempt(ticket, { kind: "service_failure", reason: "gateway_timeout", latencyMs: 20 })).toBe(n === 2 ? "opened" : null);
    }
    finishHeadroomAttempt(stale, { kind: "success", latencyMs: 20 });
    expect(beginHeadroomAttempt(endpoint).reason).toBe("circuit_open");
    vi.advanceTimersByTime(30000);
    const probe = beginHeadroomAttempt(endpoint).ticket;
    expect(beginHeadroomAttempt(endpoint).reason).toBe("circuit_probe_in_flight");
    markHeadroomAttemptStarted(probe);
    expect(finishHeadroomAttempt(probe, { kind: "success", latencyMs: 10 })).toBe("recovered");
    const snapshot = getHeadroomRuntimeSnapshot(endpoint);
    expect(snapshot.headroom_circuit_open).toBe(0);
    expect(snapshot.headroom_timeout).toBe(3);
    expect(snapshot.headroom_success).toBe(2);
    expect(snapshot.headroom_latency_ms.p95).toBe(20);
  });

  it("sanitizes gateway headers, rejects malformed beta, preserves host/model rules", async () => {
    const body = { model: "claude-haiku", messages: [{ role: "user", content: "original" }] };
    let captured;
    global.fetch = vi.fn(async (_, options) => {
      captured = JSON.parse(options.body);
      return Response.json({ body: { ...body, messages: [{ role: "user", content: "short" }] },
        headers: { "Anthropic-Beta": "context-management-2025-06-27", cookie: "ignored" } });
    });
    const diagnostics = {};
    const data = await callHeadroomGateway({ url: "http://127.0.0.1:54322", model: body.model, body,
      format: "openai", requestHeaders: { "ANTHROPIC-BETA": "a,b,a", cookie: "private" }, diagnostics });
    expect(data.providerHeaders).toEqual({ "anthropic-beta": "context-management-2025-06-27" });
    expect(captured.gateway.request_headers).toEqual({ "anthropic-beta": "a,b" });
    const headers = { "Anthropic-Beta": "claude-code-20250219,effort-2025-11-24" };
    mergeAnthropicBetaHeaders(headers, data.providerHeaders["anthropic-beta"], { model: "claude-haiku", stripClaudeCode: true });
    expect(headers).toEqual({ "anthropic-beta": "context-management-2025-06-27" });
    global.fetch = vi.fn(async () => Response.json({ body, headers: { "anthropic-beta": "a\r\nb" } }));
    const rejected = {};
    expect(await callHeadroomGateway({ url: "http://127.0.0.1:54323", model: body.model, body, format: "openai", diagnostics: rejected })).toBeNull();
    expect(rejected.reason).toBe("gateway_invalid_provider_headers");
  });
  it("rejects skipped responses that change immutable arguments", async () => {
    const original = { model: "gpt-4o", messages: [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{\"path\":\"config.json\"}" } }] }] };
    global.fetch = vi.fn(async () => Response.json({ compression_skipped: true, body: { ...original, messages: [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{\"path\":\"other.json\"}" } }] }] } }));
    const diagnostics = {};
    expect(await callHeadroomGateway({ url: "http://127.0.0.1:54324", body: original, model: original.model, format: "openai", diagnostics })).toBeNull();
    expect(diagnostics.reason).toBe("invariant_violation");
    expect(original.messages[0].tool_calls[0].function.arguments).toBe("{\"path\":\"config.json\"}");
  });

  it("treats normal compression_skipped as neutral, preserves skip_reason, does not trip circuit", async () => {
    const original = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => Response.json({ compression_skipped: true, skip_reason: "content_too_short", body: original }));
    const endpoint = "http://127.0.0.1:54325";
    for (let i = 0; i < 3; i++) {
      const diagnostics = {};
      const res = await callHeadroomGateway({ url: endpoint, body: original, model: original.model, format: "openai", diagnostics });
      expect(res).toBeNull();
      expect(diagnostics.reason).toBe("gateway_compression_skipped");
      expect(diagnostics.skip_reason).toBe("content_too_short");
    }
    const snapshot = getHeadroomRuntimeSnapshot(`${endpoint}/v1/compress`);
    expect(snapshot.headroom_circuit_open).toBe(0);
    expect(snapshot.circuitState).toBe("CLOSED");
  });

  it("treats compression_timeout skip_reason as service failure and trips circuit after 3 attempts", async () => {
    const original = { model: "gpt-4o", messages: [{ role: "user", content: "heavy payload" }] };
    global.fetch = vi.fn(async () => Response.json({ compression_skipped: true, skip_reason: "compression_timeout", body: original }));
    const endpoint = "http://127.0.0.1:54326";
    for (let i = 0; i < 3; i++) {
      const diagnostics = {};
      const res = await callHeadroomGateway({ url: endpoint, body: original, model: original.model, format: "openai", diagnostics });
      expect(res).toBeNull();
      expect(diagnostics.reason).toBe("gateway_compression_skipped");
      expect(diagnostics.skip_reason).toBe("compression_timeout");
    }
    const snapshot = getHeadroomRuntimeSnapshot(`${endpoint}/v1/compress`);
    expect(snapshot.headroom_circuit_open).toBe(1);
    expect(snapshot.circuitState).toBe("OPEN");
  });

  it("captures queue metrics and pre-flight sizes upon timeout", async () => {
    const original = { model: "gpt-4o", messages: [{ role: "user", content: "latency test" }] };
    global.fetch = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const diagnostics = {};
    const res = await callHeadroomGateway({ url: "http://127.0.0.1:54327", body: original, model: original.model, format: "openai", timeoutMs: 20, diagnostics });
    expect(res).toBeNull();
    expect(diagnostics.reason).toBe("gateway_timeout");
    expect(diagnostics.queue).toBeDefined();
    expect(diagnostics.queue.circuitState).toBe("CLOSED");
    expect(diagnostics.queue.inFlight).toBeDefined();
  });

  it("trips latency guard when p95 exceeds 1500ms on SSE, admits 1 probe after cooldown and recovers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const endpoint = "http://127.0.0.1:54328/v1/compress";

    // 5 attempts with latency > 1500ms for SSE
    for (let i = 0; i < 5; i++) {
      const ticket = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true }).ticket;
      markHeadroomAttemptStarted(ticket);
      finishHeadroomAttempt(ticket, { kind: "success", latencyMs: 1600 + i * 20 });
    }

    // Next SSE request should be blocked by latency guard
    const sseBlocked = beginHeadroomAttempt(endpoint, { isSSE: true });
    expect(sseBlocked.reason).toBe("latency_guard_open");

    // Non-SSE request still allowed through circuit
    const jsonAllowed = beginHeadroomAttempt(endpoint, { isSSE: false });
    expect(jsonAllowed.ticket).toBeDefined();
    finishHeadroomAttempt(jsonAllowed.ticket, { kind: "success", latencyMs: 100 });

    // Advance beyond 30s cooldown
    vi.advanceTimersByTime(30001);

    // First SSE becomes probe
    const probeAttempt = beginHeadroomAttempt(endpoint, { isSSE: true });
    expect(probeAttempt.ticket).toBeDefined();
    expect(probeAttempt.ticket.latencyProbe).toBe(true);

    // Second concurrent SSE receives latency_probe_in_flight
    const probeBlocked = beginHeadroomAttempt(endpoint, { isSSE: true });
    expect(probeBlocked.reason).toBe("latency_probe_in_flight");

    // Probe finishes fast -> recovers
    markHeadroomAttemptStarted(probeAttempt.ticket);
    const transition = finishHeadroomAttempt(probeAttempt.ticket, { kind: "success", latencyMs: 250 });
    expect(transition).toBe("latency_recovered");

    const snapshot = getHeadroomRuntimeSnapshot(endpoint);
    expect(snapshot.latencyGuard.state).toBe("CLOSED");
    expect(snapshot.latencyGuard.probeInFlight).toBe(false);
  });

  it("session-affinity SSE does not open latency guard on single 3500ms spike, but opens on p95 > 1500ms or timeout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const endpoint = "http://127.0.0.1:54329/v1/compress";

    // 1. Single cold-start spike of 3552ms with session affinity
    const ticket1 = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: true }).ticket;
    markHeadroomAttemptStarted(ticket1);
    const trans1 = finishHeadroomAttempt(ticket1, { kind: "neutral", reason: "invariant_violation", latencyMs: 3552 });
    expect(trans1).toBeNull();

    // Guard remains CLOSED because session affinity protects warm turn 2
    const nextAttempt = beginHeadroomAttempt(endpoint, { isSSE: true, hasSession: true });
    expect(nextAttempt.ticket).toBeDefined();
    expect(nextAttempt.reason).toBeUndefined();
    finishHeadroomAttempt(nextAttempt.ticket, { kind: "success", latencyMs: 300 });

    // 2. But a genuine timeout on session-affinity SSE opens guard immediately
    const timeoutTicket = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: true }).ticket;
    markHeadroomAttemptStarted(timeoutTicket);
    const transTimeout = finishHeadroomAttempt(timeoutTicket, { kind: "service_failure", reason: "gateway_timeout", latencyMs: 10000 });
    expect(transTimeout).toBe("latency_opened");

    const blockedAfterTimeout = beginHeadroomAttempt(endpoint, { isSSE: true, hasSession: true });
    expect(blockedAfterTimeout.reason).toBe("latency_guard_open");
  });

  it("stateless SSE opens latency guard immediately on single severe spike >= 3000ms", () => {
    const endpoint = "http://127.0.0.1:54330/v1/compress";

    // Single spike on stateless SSE (hasSession: false)
    const ticket = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: false }).ticket;
    markHeadroomAttemptStarted(ticket);
    const trans = finishHeadroomAttempt(ticket, { kind: "success", latencyMs: 3552 });
    expect(trans).toBe("latency_opened");

    const blocked = beginHeadroomAttempt(endpoint, { isSSE: true, hasSession: false });
    expect(blocked.reason).toBe("latency_guard_open");
  });

  it("isolates latency guard from neutral invariant_violation outcomes even with spike or high historical p95", () => {
    const endpoint = "http://127.0.0.1:54331/v1/compress";

    // 1. Single spike with invariant_violation on stateless SSE must NOT open guard
    const ticket1 = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: false }).ticket;
    markHeadroomAttemptStarted(ticket1);
    const trans1 = finishHeadroomAttempt(ticket1, { kind: "neutral", reason: "invariant_violation", latencyMs: 3552 });
    expect(trans1).toBeNull();

    const nextAttempt = beginHeadroomAttempt(endpoint, { isSSE: true, hasSession: false });
    expect(nextAttempt.ticket).toBeDefined();
    expect(nextAttempt.reason).toBeUndefined();
    finishHeadroomAttempt(nextAttempt.ticket, { kind: "success", latencyMs: 200 });

    // 2. High historical P95 followed by an invariant_violation at 372ms must NOT open guard
    for (let i = 0; i < 4; i++) {
      const t = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: false }).ticket;
      markHeadroomAttemptStarted(t);
      finishHeadroomAttempt(t, { kind: "success", latencyMs: 1800 });
    }
    const invTicket = beginHeadroomAttempt(endpoint, { bypassInFlight: true, isSSE: true, hasSession: false }).ticket;
    markHeadroomAttemptStarted(invTicket);
    const transInv = finishHeadroomAttempt(invTicket, { kind: "neutral", reason: "invariant_violation", latencyMs: 372 });
    expect(transInv).toBeNull();

    const allowed = beginHeadroomAttempt(endpoint, { isSSE: true, hasSession: false });
    expect(allowed.ticket).toBeDefined();
    expect(allowed.reason).toBeUndefined();
    finishHeadroomAttempt(allowed.ticket, { kind: "success", latencyMs: 150 });
  });

  it("formats invariant summary tag with path detail or fallback", () => {
    expect(formatHeadroomSummaryTag(null, { reason: "invariant_violation", detail: "input.127.arguments", latencyMs: 3552 }))
      .toBe("HEADROOM:BYPASS:invariant(input.127.arguments) 3552ms");

    expect(formatHeadroomSummaryTag(null, { reason: "invariant_violation", latencyMs: 3552 }))
      .toBe("HEADROOM:BYPASS:invariant_violation 3552ms");

    expect(formatHeadroomSummaryTag(null, { reason: "gateway_timeout", latencyMs: 10000 }))
      .toBe("HEADROOM:TIMEOUT 10000ms");
  });
});
