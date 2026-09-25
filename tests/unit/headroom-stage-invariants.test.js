import { describe, it, expect, vi, afterEach } from "vitest";
import { selectHeadroomStage, HEADROOM_STAGES } from "../../open-sse/rtk/headroomStage.js";
import { validateBodyInvariants } from "../../open-sse/rtk/headroomInvariants.js";
import { normalizeRelayUsage, createHeadroomTurnContext, hasRelayUsage } from "../../open-sse/rtk/headroomRelay.js";
import { isInternalHost, isSafeOrigin } from "../../open-sse/rtk/headroomGateway.js";

describe("Headroom pure stage selector", () => {
  it("selects TARGET_NATIVE for native target formats", () => {
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "openai", provider: "openai" }))
      .toEqual({ stage: HEADROOM_STAGES.TARGET_NATIVE, format: "openai" });

    expect(selectHeadroomStage({ sourceFormat: "openai-responses", targetFormat: "openai-responses", provider: "codex" }))
      .toEqual({ stage: HEADROOM_STAGES.TARGET_NATIVE, format: "openai-responses" });

    expect(selectHeadroomStage({ sourceFormat: "claude", targetFormat: "claude", provider: "anthropic" }))
      .toEqual({ stage: HEADROOM_STAGES.TARGET_NATIVE, format: "claude" });
  });

  it("selects SOURCE_NATIVE when target is non-native but source is native", () => {
    expect(selectHeadroomStage({ sourceFormat: "openai-responses", targetFormat: "antigravity", provider: "antigravity" }))
      .toEqual({ stage: HEADROOM_STAGES.SOURCE_NATIVE, format: "openai-responses" });

    expect(selectHeadroomStage({ sourceFormat: "claude", targetFormat: "gemini", provider: "gemini" }))
      .toEqual({ stage: HEADROOM_STAGES.SOURCE_NATIVE, format: "claude" });

    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "kiro", provider: "kiro" }))
      .toEqual({ stage: HEADROOM_STAGES.SOURCE_NATIVE, format: "openai" });
  });

  it("bypasses when both formats are non-native", () => {
    expect(selectHeadroomStage({ sourceFormat: "gemini", targetFormat: "antigravity", provider: "antigravity" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
  });

  it("bypasses cursor, binary streams, compact, and bridge", () => {
    expect(selectHeadroomStage({ sourceFormat: "cursor", targetFormat: "cursor", provider: "cursor" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "commandcode", provider: "commandcode" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "openai", isCompact: true }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "openai", isBridge: true }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
  });
});

describe("Headroom invariants wire contract", () => {
  it("accepts whole body message and tool compaction", () => {
    const orig = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello world long text" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            description: "Verbose description to be compacted",
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: { a: { type: "string" } },
            },
          },
        },
      ],
    };
    const comp = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            description: "Compacted",
            parameters: { type: "object", properties: { a: { type: "string" } } },
          },
        },
      ],
    };

    expect(validateBodyInvariants(orig, comp)).toEqual({ valid: true });
  });

  it("rejects non-object root payloads", () => {
    expect(validateBodyInvariants(null, {})).toEqual({ valid: false, reason: "gateway_invalid_body" });
    expect(validateBodyInvariants({}, null)).toEqual({ valid: false, reason: "gateway_invalid_body" });
    expect(validateBodyInvariants([], {})).toEqual({ valid: false, reason: "gateway_invalid_body" });
    expect(validateBodyInvariants({}, [])).toEqual({ valid: false, reason: "gateway_invalid_body" });
    expect(validateBodyInvariants("string", {})).toEqual({ valid: false, reason: "gateway_invalid_body" });
  });

  it("rejects model sovereignty violations on returned body or route", () => {
    const orig = { model: "gpt-4o", messages: [] };

    // Body model mismatch
    expect(validateBodyInvariants(orig, { model: "gpt-4o-mini", messages: [] })).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });

    // Route model mismatch
    expect(validateBodyInvariants(orig, { model: "gpt-4o", messages: [] }, { route: { model: "claude-3-5-sonnet" } })).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });

    // Provider is advisory; the router never uses it to select the upstream.
    expect(validateBodyInvariants(orig, { model: "gpt-4o", messages: [] }, { route: { model: "gpt-4o", provider: "openai" } })).toEqual({ valid: true });
    expect(validateBodyInvariants(orig, { model: "gpt-4o", messages: [] }, { route: "invalid" })).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });
    expect(validateBodyInvariants(orig, { model: "gpt-4o", messages: [] }, { route: { provider: 42 } })).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });
  });

  it("rejects control fields returned from gateway", () => {
    const orig = { model: "gpt-4o", messages: [] };
    for (const field of ["config", "gateway", "token_budget", "session_id", "_headroom_responses_view"]) {
      const comp = { model: "gpt-4o", messages: [], [field]: true };
      expect(validateBodyInvariants(orig, comp)).toEqual({
        valid: false,
        reason: "gateway_control_field",
      });
    }
  });

  it("rejects unsupported obligations and missing/malformed turn_id", () => {
    const orig = { model: "gpt-4o", messages: [] };
    const comp = { model: "gpt-4o", messages: [] };

    expect(validateBodyInvariants(orig, comp, { obligations: "not-an-array" })).toEqual({
      valid: false,
      reason: "unsupported_obligation",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["redrive"] })).toEqual({
      valid: false,
      reason: "unsupported_obligation",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["relay_usage", "unknown"] })).toEqual({
      valid: false,
      reason: "unsupported_obligation",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["relay_usage"], turnId: null })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["relay_usage"], turnId: "" })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["relay_usage"], turnId: "a".repeat(129) })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(orig, comp, { obligations: ["relay_usage"], turnId: "turn_ok" })).toEqual({
      valid: true,
    });
  });

  it("rejects invalid provider headers", () => {
    const orig = { model: "gpt-4o", messages: [] };
    const comp = { model: "gpt-4o", messages: [] };

    expect(validateBodyInvariants(orig, comp, { headers: "invalid" })).toEqual({
      valid: false,
      reason: "gateway_invalid_provider_headers",
    });

    expect(validateBodyInvariants(orig, comp, { headers: { "anthropic-beta": 123 } })).toEqual({
      valid: false,
      reason: "gateway_invalid_provider_headers",
    });

    expect(validateBodyInvariants(orig, comp, { headers: { "anthropic-beta": "valid-string" } })).toEqual({
      valid: true,
    });
  });
});

describe("Headroom security origin validation", () => {
  it("strictly whitelists internal and private hosts", () => {
    expect(isInternalHost("localhost")).toBe(true);
    expect(isInternalHost("127.0.0.1")).toBe(true);
    expect(isInternalHost("::1")).toBe(true);
    expect(isInternalHost("headroom")).toBe(true);
    expect(isInternalHost("9router-headroom")).toBe(true);
    expect(isInternalHost("host.docker.internal")).toBe(true);
    expect(isInternalHost("10.0.1.5")).toBe(true);
    expect(isInternalHost("172.16.0.1")).toBe(true);
    expect(isInternalHost("172.31.255.255")).toBe(true);
    expect(isInternalHost("192.168.1.1")).toBe(true);
  });

  it("rejects public domains, fake suffixes and invalid IPs", () => {
    expect(isInternalHost("example.com")).toBe(false);
    expect(isInternalHost("test.example")).toBe(false);
    expect(isInternalHost("local.lan")).toBe(false);
    expect(isInternalHost("attacker.internal")).toBe(false);
    expect(isInternalHost("172.32.0.1")).toBe(false);
    expect(isInternalHost("256.0.0.1")).toBe(false);
  });

  it("checks origin URLs safely and respects HEADROOM_ALLOW_EXTERNAL_ORIGIN override", () => {
    const originalEnv = process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN;
    try {
      delete process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN;
      expect(isSafeOrigin("http://127.0.0.1:8787")).toBe(true);
      expect(isSafeOrigin("http://headroom:8787/v1/compress")).toBe(true);
      expect(isSafeOrigin("https://example.com/v1/compress")).toBe(false);

      process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN = "1";
      expect(isSafeOrigin("https://example.com/v1/compress")).toBe(true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN = originalEnv;
      } else {
        delete process.env.HEADROOM_ALLOW_EXTERNAL_ORIGIN;
      }
    }
  });
});

describe("Headroom response relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles Headroom array obligations", () => {
    expect(hasRelayUsage(["relay_usage"])).toBe(true);
    expect(hasRelayUsage(["redrive", "relay_usage"])).toBe(true);
    expect(hasRelayUsage(["redrive"])).toBe(false);
    expect(hasRelayUsage([])).toBe(false);
    expect(hasRelayUsage(null)).toBe(false);
  });

  it("normalizes diverse provider usage without double-counting", () => {
    expect(normalizeRelayUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      .toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 0, total_tokens: 15 });

    expect(normalizeRelayUsage({
      input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 12 },
    })).toEqual({ input_tokens: 30, output_tokens: 4, cached_tokens: 12, total_tokens: 34 });

    expect(normalizeRelayUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 1000,
    })).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 5000,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 1000,
      total_tokens: 120,
    });
  });

  it("completes once and fires async relay request with integer status", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const ctx = createHeadroomTurnContext({
      url: "http://headroom:8787",
      proxyToken: "secret-token",
      turnId: "turn_999",
      obligations: ["relay_usage"],
      startTime: Date.now() - 100,
    });

    expect(ctx.isEligible).toBe(true);
    ctx.complete({ statusCode: 200, usage: { prompt_tokens: 50, completion_tokens: 25 } });
    ctx.complete({ statusCode: 500 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOptions] = global.fetch.mock.calls[0];
    expect(fetchUrl).toBe("http://headroom:8787/v1/compress/response");
    expect(fetchOptions.headers).toMatchObject({ "X-Headroom-Proxy-Token": "secret-token" });

    const sentPayload = JSON.parse(fetchOptions.body);
    expect(sentPayload).toEqual({
      turn_id: "turn_999",
      status: 200,
      latency_ms: expect.any(Number),
      usage: {
        input_tokens: 50,
        output_tokens: 25,
        cached_tokens: 0,
        total_tokens: 75,
      },
    });
  });

  it("relays error status as integer HTTP status code", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const ctx = createHeadroomTurnContext({
      url: "http://headroom:8787",
      proxyToken: "secret-token",
      turnId: "turn_err_1",
      obligations: ["relay_usage"],
      startTime: Date.now() - 50,
    });

    ctx.complete({ statusCode: 429, error: new Error("Rate limit exceeded") });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentPayload.status).toBe(429);
  });

  it("uses a failed status when relay completes with an error only", () => {
    global.fetch = vi.fn(async () => Response.json({ action: "done" }));
    const ctx = createHeadroomTurnContext({ url: "http://headroom:8787", turnId: "turn_error", obligations: ["relay_usage"] });
    ctx.complete({ error: new Error("provider unavailable") });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).status).toBe(502);
  });

  it("suppresses response relay when obligations does not include relay_usage", () => {
    global.fetch = vi.fn();
    const ctx = createHeadroomTurnContext({
      url: "http://headroom:8787",
      proxyToken: "secret-token",
      turnId: "turn_999",
      obligations: ["redrive"],
      startTime: Date.now() - 100,
    });

    expect(ctx.isEligible).toBe(false);
    ctx.complete({ statusCode: 200 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
