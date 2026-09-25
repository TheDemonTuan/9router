import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSummaryTag } from "../../open-sse/rtk/headroom.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compressWithHeadroom", () => {
  it("no-ops when disabled", async () => {
    global.fetch = vi.fn();
    const body = { messages: [{ role: "user", content: "hello" }] };

    const stats = await compressWithHeadroom(body, { enabled: false, url: "http://localhost:8787" });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.messages[0].content).toBe("hello");
  });

  it("compresses messages in-place with Gateway v2 contract", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse(init.body);
      return new Response(JSON.stringify({
        data: {
          body: { model: sent.model, messages: [{ role: "user", content: "short" }] },
          turn_id: "turn_1",
          obligations: ["relay_usage"],
          headers: { "Anthropic-Beta": "context-management-2025-06-27", authorization: "ignored" },
        },
        tokens_before: 100,
        tokens_after: 20,
        tokens_saved: 80,
      }), { status: 200 });
    });
    const body = { messages: [{ role: "user", content: "long" }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://headroom:8787/", model: "gpt-4o" });

    expect(body.messages[0].content).toBe("short");
    expect(stats.tokens_saved).toBe(80);
    expect(stats.providerHeaders).toEqual({ "anthropic-beta": "context-management-2025-06-27" });
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/v1/compress", expect.objectContaining({ method: "POST" }));
  });

  it("forwards the complete returned body, including added and removed fields", async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const sent = JSON.parse(init.body);
      return Response.json({
        body: {
          model: sent.model,
          messages: [{ role: "user", content: "short" }],
          stream: false,
          metadata: { upstream: "kept" },
          tools: [{ type: "function", function: { name: "search", description: "compact" } }],
        },
      });
    });
    const body = {
      model: "gpt-4o", stream: true, temperature: 0.7,
      messages: [{ role: "user", content: "long" }],
      tools: [{ type: "function", function: { name: "search", description: "long description" } }],
    };
    const originalRef = body;
    const result = await compressWithHeadroom(body, { url: "http://localhost:8787", model: "gpt-4o" });
    expect(result).toBeTruthy();
    expect(body).toBe(originalRef);
    expect(body).toEqual({
      model: "gpt-4o", stream: false, messages: [{ role: "user", content: "short" }],
      metadata: { upstream: "kept" },
      tools: [{ type: "function", function: { name: "search", description: "compact" } }],
    });
  });

  it("compresses responses input in-place with Gateway v2 contract", async () => {
    global.fetch = vi.fn(async (_url, init) => new Response(JSON.stringify({
      data: { body: { model: JSON.parse(init.body).model, input: [{ role: "user", content: "short" }] } },
    }), { status: 200 }));
    const body = { input: [{ role: "user", content: "long" }] };

    await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", format: "openai-responses" });

    expect(body.input[0].content).toBe("short");
  });

  it("stateless errors fail open", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 500 }));
    const body = { messages: [{ role: "user", content: "long" }] };
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", diagnostics });

    expect(stats).toBeNull();
    expect(body.messages[0].content).toBe("long");
    expect(diagnostics.reason).toBe("gateway_http_500");
  });

  it("stateless 200 compression_skipped returns body", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "short text" }] };
    const originalContent = body.messages[0].content;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      compression_skipped: true,
      skip_reason: "content_too_short",
      body,
    }), { status: 200 }));
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gpt-4o",
      diagnostics,
    });

    expect(stats).not.toBeNull();
    expect(stats.compressionSkipped).toBe(true);
    expect(body.messages[0].content).toBe(originalContent);
    expect(diagnostics.reason).toBe("gateway_compression_skipped");
    expect(diagnostics.skip_reason).toBe("content_too_short");
  });

  it("locks client control over gateway flags and config", async () => {
    let sentBody = null;
    global.fetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        data: {
          body: { model: sentBody.model, messages: [{ role: "user", content: "compressed output" }] },
          obligations: ["relay_usage"],
          turn_id: "turn-sec-1",
        },
      }), { status: 200 });
    });

    const maliciousBody = {
      messages: [{ role: "user", content: "hello" }],
      gateway: {
        can_redrive: true,
        session_affinity: true,
      },
      config: {
        mode: "ccr",
      },
      session_id: "attacker-session",
    };

    const stats = await compressWithHeadroom(maliciousBody, {
      enabled: true,
      url: "http://headroom:8787",
      model: "gpt-4o",
      compressUserMessages: false,
    });

    expect(stats).toBeTruthy();
    expect(sentBody.gateway).toEqual({
      can_redrive: false,
      can_relay_response: true,
      session_affinity: false,
    });
    expect(sentBody.config).toBeUndefined();
    expect(sentBody.session_id).toBeUndefined();
  });

  it("session HTTP 503 fails closed via HEADROOM_SESSION_FAILURE, status 503, retryable true", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: { type: "session_busy" },
    }), { status: 503 }));

    const body = { model: "gpt-4o", messages: [{ role: "user", content: "text" }] };
    let caught = null;
    try {
      await compressWithHeadroom(body, {
        enabled: true,
        url: "http://headroom:8787",
        model: "gpt-4o",
        sessionId: "session-123",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe("HEADROOM_SESSION_FAILURE");
    expect(caught.status).toBe(503);
    expect(caught.retryable).toBe(true);
    expect(caught.reason).toBe("session_busy");
  });

  it("invalid session body fails closed before gateway dispatch", async () => {
    global.fetch = vi.fn();
    await expect(compressWithHeadroom(null, {
      enabled: true, url: "http://headroom:8787", sessionId: "session-123",
    })).rejects.toMatchObject({ code: "HEADROOM_SESSION_FAILURE", status: 502, retryable: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("session connection failure fails closed via HEADROOM_SESSION_FAILURE", async () => {
    global.fetch = vi.fn(async () => {
      const err = new Error("ECONNREFUSED");
      err.code = "ECONNREFUSED";
      throw err;
    });

    const body = { model: "gpt-4o", messages: [{ role: "user", content: "text" }] };
    let caught = null;
    try {
      await compressWithHeadroom(body, {
        enabled: true,
        url: "http://headroom:8787",
        model: "gpt-4o",
        sessionId: "session-123",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe("HEADROOM_SESSION_FAILURE");
    expect(caught.status).toBe(503);
    expect(caught.retryable).toBe(true);
  });

  it("session invalid response fails closed via HEADROOM_SESSION_FAILURE, status 502", async () => {
    global.fetch = vi.fn(async () => new Response("not-valid-json", { status: 200 }));

    const body = { model: "gpt-4o", messages: [{ role: "user", content: "text" }] };
    let caught = null;
    try {
      await compressWithHeadroom(body, {
        enabled: true,
        url: "http://headroom:8787",
        model: "gpt-4o",
        sessionId: "session-123",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe("HEADROOM_SESSION_FAILURE");
    expect(caught.status).toBe(502);
  });

  it("session 200 compression_skipped fails closed via HEADROOM_SESSION_FAILURE, status 502", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "text" }] };
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      compression_skipped: true,
      body,
    }), { status: 200 }));

    let caught = null;
    try {
      await compressWithHeadroom(body, {
        enabled: true,
        url: "http://headroom:8787",
        model: "gpt-4o",
        sessionId: "session-123",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe("HEADROOM_SESSION_FAILURE");
    expect(caught.status).toBe(502);
    expect(caught.reason).toBe("session_compression_skipped");
  });

  it("propagates clientSignal abort immediately", async () => {
    const controller = new AbortController();
    controller.abort({ code: "CLIENT_ABORT" });
    const body = { messages: [{ role: "user", content: "test" }] };

    await expect(compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      clientSignal: controller.signal,
    })).rejects.toMatchObject({ code: "CLIENT_ABORT" });
  });

  it("propagates preResponse deadline exceeded immediately", async () => {
    const controller = new AbortController();
    const deadlineErr = new Error("Deadline exceeded");
    deadlineErr.code = "PRE_RESPONSE_DEADLINE_EXCEEDED";
    controller.abort(deadlineErr);
    const body = { messages: [{ role: "user", content: "test" }] };

    await expect(compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      preResponse: { signal: controller.signal },
    })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
  });
});

describe("formatHeadroomLog", () => {
  it("formats reported token deltas without implying provider billing savings", () => {
    expect(formatHeadroomLog({ tokens_before: 100, tokens_after: 25, tokens_saved: 75 }))
      .toBe("reported token delta=75 before=100 after=25 (75.0%)");
  });
});

describe("formatHeadroomSummaryTag", () => {
  it("formats compressed summary tag", () => {
    expect(formatHeadroomSummaryTag({ tokens_saved: 80, tokens_before: 100 }, { latencyMs: 50 }))
      .toBe("HEADROOM:80tok/80% 50ms");
  });

  it("formats skip summary tag", () => {
    expect(formatHeadroomSummaryTag({ compressionSkipped: true }, { skip_reason: "content_too_short", latencyMs: 12 }))
      .toBe("HEADROOM:BYPASS:content_too_short 12ms");
  });

  it("formats bypass diagnostic reason tag", () => {
    expect(formatHeadroomSummaryTag(null, { reason: "stage_bypass", latencyMs: 5 }))
      .toBe("HEADROOM:BYPASS:stage_bypass 5ms");
  });
});
