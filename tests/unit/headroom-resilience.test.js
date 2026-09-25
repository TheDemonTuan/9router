import { describe, it, expect, vi, afterEach } from "vitest";
import { validateBodyInvariants } from "../../open-sse/rtk/headroomInvariants.js";
import { callHeadroomGateway } from "../../open-sse/rtk/headroomGateway.js";
import { mergeAnthropicBetaHeaders } from "../../open-sse/utils/anthropicBeta.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Headroom invariants wire contract", () => {
  it("accepts whole body and tools compaction", () => {
    const original = {
      model: "claude-sonnet",
      messages: [{ role: "user", content: "long context ".repeat(50) }],
      tools: [{ type: "function", function: { name: "test", parameters: { type: "object", properties: { a: { type: "string" } } } } }],
    };
    const returned = {
      model: "claude-sonnet",
      messages: [{ role: "user", content: "short" }],
      tools: [{ type: "function", function: { name: "test", parameters: { type: "object" } } }],
    };

    expect(validateBodyInvariants(original, returned)).toEqual({ valid: true });
  });

  it("rejects model sovereignty violations", () => {
    const original = { model: "claude-sonnet", messages: [] };
    const returnedDiffModel = { model: "gpt-4o", messages: [] };
    expect(validateBodyInvariants(original, returnedDiffModel)).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });

    const returnedSame = { model: "claude-sonnet", messages: [] };
    expect(validateBodyInvariants(original, returnedSame, { route: { model: "gpt-4o" } })).toEqual({
      valid: false,
      reason: "model_sovereignty_violation",
    });
  });

  it("rejects returned gateway control fields", () => {
    const original = { model: "gpt-4o", messages: [] };
    for (const field of ["config", "gateway", "token_budget", "session_id", "_headroom_responses_view"]) {
      const returned = { model: "gpt-4o", messages: [], [field]: {} };
      expect(validateBodyInvariants(original, returned)).toEqual({
        valid: false,
        reason: "gateway_control_field",
      });
    }
  });

  it("rejects unsupported obligations or missing/invalid turn_id", () => {
    const original = { model: "gpt-4o", messages: [] };
    const returned = { model: "gpt-4o", messages: [] };

    expect(validateBodyInvariants(original, returned, { obligations: ["redrive"] })).toEqual({
      valid: false,
      reason: "unsupported_obligation",
    });

    expect(validateBodyInvariants(original, returned, { obligations: ["relay_usage"], turnId: null })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(original, returned, { obligations: ["relay_usage"], turnId: "" })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(original, returned, { obligations: ["relay_usage"], turnId: "x".repeat(129) })).toEqual({
      valid: false,
      reason: "gateway_invalid_turn_id",
    });

    expect(validateBodyInvariants(original, returned, { obligations: ["relay_usage"], turnId: "valid_turn_1" })).toEqual({
      valid: true,
    });
  });

  it("rejects invalid provider headers", () => {
    const original = { model: "gpt-4o", messages: [] };
    const returned = { model: "gpt-4o", messages: [] };

    expect(validateBodyInvariants(original, returned, { headers: "not-an-object" })).toEqual({
      valid: false,
      reason: "gateway_invalid_provider_headers",
    });

    expect(validateBodyInvariants(original, returned, { headers: { "test-header": 123 } })).toEqual({
      valid: false,
      reason: "gateway_invalid_provider_headers",
    });

    expect(validateBodyInvariants(original, returned, { headers: { "test-header": "valid" } })).toEqual({
      valid: true,
    });
  });
});

describe("callHeadroomGateway resilience & session semantics", () => {
  it("sanitizes gateway headers, rejects malformed beta, strips client controls", async () => {
    const body = {
      model: "claude-haiku",
      messages: [{ role: "user", content: "original" }],
      config: { evil: true },
      session_id: "fake",
    };
    let captured;
    global.fetch = vi.fn(async (_, options) => {
      captured = JSON.parse(options.body);
      return Response.json({
        body: { model: body.model, messages: [{ role: "user", content: "short" }] },
        headers: { "Anthropic-Beta": "context-management-2025-06-27", cookie: "ignored" },
      });
    });
    const diagnostics = {};
    const data = await callHeadroomGateway({
      url: "http://127.0.0.1:54322",
      model: body.model,
      body,
      requestHeaders: { "ANTHROPIC-BETA": "a,b,a", cookie: "private" },
      diagnostics,
    });

    expect(data.providerHeaders).toEqual({ "anthropic-beta": "context-management-2025-06-27" });
    expect(captured.gateway.request_headers).toEqual({ "anthropic-beta": "a,b" });
    expect(captured.config).toBeUndefined();
    expect(captured.session_id).toBeUndefined();

    const headers = { "Anthropic-Beta": "claude-code-20250219,effort-2025-11-24" };
    mergeAnthropicBetaHeaders(headers, data.providerHeaders["anthropic-beta"], { model: "claude-haiku", stripClaudeCode: true });
    expect(headers).toEqual({ "anthropic-beta": "context-management-2025-06-27" });

    global.fetch = vi.fn(async () => Response.json({
      body: { model: body.model, messages: [] },
      headers: { "anthropic-beta": "a\r\nb" },
    }));
    const rejected = {};
    expect(await callHeadroomGateway({ url: "http://127.0.0.1:54323", model: body.model, body, diagnostics: rejected })).toBeNull();
    expect(rejected.reason).toBe("gateway_invalid_provider_headers");
  });

  it("stateless errors fail open (returns null, sets diagnostics.reason)", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };

    // 500 error
    global.fetch = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
    const diag500 = {};
    const res500 = await callHeadroomGateway({ url: "http://127.0.0.1:54324", body, model: body.model, diagnostics: diag500 });
    expect(res500).toBeNull();
    expect(diag500.reason).toBe("gateway_http_500");

    // Network ECONNREFUSED
    global.fetch = vi.fn(async () => {
      const err = new Error("ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    });
    const diagConn = {};
    const resConn = await callHeadroomGateway({ url: "http://127.0.0.1:54325", body, model: body.model, diagnostics: diagConn });
    expect(resConn).toBeNull();
    expect(diagConn.reason).toBe("gateway_connection_refused");
  });

  it("stateless 200 compression_skipped returns body and sets skip diagnostics", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => Response.json({
      compression_skipped: true,
      skip_reason: "content_too_short",
      body,
    }));
    const diagnostics = {};
    const res = await callHeadroomGateway({ url: "http://127.0.0.1:54326", body, model: body.model, diagnostics });
    expect(res).not.toBeNull();
    expect(res.compressionSkipped).toBe(true);
    expect(diagnostics.reason).toBe("gateway_compression_skipped");
    expect(diagnostics.skip_reason).toBe("content_too_short");
  });

  it("session HTTP 503 fails closed via HEADROOM_SESSION_FAILURE, status 503, retryable true", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: { type: "session_busy" },
    }), { status: 503 }));

    await expect(callHeadroomGateway({
      url: "http://127.0.0.1:54327",
      body,
      model: body.model,
      sessionId: "sess-resilience-1",
    })).rejects.toMatchObject({
      code: "HEADROOM_SESSION_FAILURE",
      status: 503,
      retryable: true,
      reason: "session_busy",
    });
  });

  it("session connection error fails closed via HEADROOM_SESSION_FAILURE, status 503, retryable true", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    });

    await expect(callHeadroomGateway({
      url: "http://127.0.0.1:54328",
      body,
      model: body.model,
      sessionId: "sess-resilience-2",
    })).rejects.toMatchObject({
      code: "HEADROOM_SESSION_FAILURE",
      status: 503,
      retryable: true,
      reason: "gateway_connection_refused",
    });
  });

  it("session invalid response fails closed via HEADROOM_SESSION_FAILURE, status 502, retryable false", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => new Response("{invalid-json", { status: 200 }));

    await expect(callHeadroomGateway({
      url: "http://127.0.0.1:54329",
      body,
      model: body.model,
      sessionId: "sess-resilience-3",
    })).rejects.toMatchObject({
      code: "HEADROOM_SESSION_FAILURE",
      status: 502,
      retryable: false,
      reason: "gateway_invalid_json_response",
    });
  });

  it("handles concurrent sessions without state cross-talk", async () => {
    const bodies = Array.from({ length: 4 }, (_, i) => ({
      model: "gpt-4o",
      messages: [{ role: "user", content: `msg-${i}` }],
    }));

    global.fetch = vi.fn(async (_url, init) => {
      const parsed = JSON.parse(init.body);
      return Response.json({
        body: {
          model: parsed.model,
          messages: [{ role: "user", content: `compressed-${parsed.config.session_id}` }],
        },
        turn_id: `turn-${parsed.config.session_id}`,
        obligations: ["relay_usage"],
      });
    });

    const results = await Promise.all(
      bodies.map((b, i) => callHeadroomGateway({
        url: "http://127.0.0.1:54330",
        body: b,
        model: b.model,
        sessionId: `sess-${i}`,
      }))
    );

    for (let i = 0; i < 4; i++) {
      expect(results[i].compressedBody.messages[0].content).toBe(`compressed-sess-${i}`);
      expect(results[i].turnId).toBe(`turn-sess-${i}`);
    }
  });

  it("fails closed on session compression_skipped", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short" }] };
    global.fetch = vi.fn(async () => Response.json({
      compression_skipped: true,
      body,
    }));

    await expect(callHeadroomGateway({
      url: "http://127.0.0.1:54331",
      body,
      model: body.model,
      sessionId: "sess-skip-fail",
    })).rejects.toMatchObject({
      code: "HEADROOM_SESSION_FAILURE",
      status: 502,
      retryable: false,
      reason: "session_compression_skipped",
    });
  });
});
