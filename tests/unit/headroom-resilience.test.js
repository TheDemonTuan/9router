import { describe, it, expect, vi, afterEach } from "vitest";
import { validateBodyInvariants } from "../../open-sse/rtk/headroomInvariants.js";
import { callHeadroomGateway } from "../../open-sse/rtk/headroomGateway.js";
import { resolveHeadroomTimeout } from "../../open-sse/config/runtimeConfig.js";
import { beginHeadroomAttempt, markHeadroomAttemptStarted, finishHeadroomAttempt, getHeadroomRuntimeSnapshot } from "../../open-sse/rtk/headroomRuntime.js";
import { mergeAnthropicBetaHeaders } from "../../open-sse/utils/anthropicBeta.js";

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
});
