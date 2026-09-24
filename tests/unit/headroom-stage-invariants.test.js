import { describe, it, expect, vi, afterEach } from "vitest";
import { selectHeadroomStage, HEADROOM_STAGES } from "../../open-sse/rtk/headroomStage.js";
import { validateBodyInvariants, deepEqual } from "../../open-sse/rtk/headroomInvariants.js";
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
    // Codex Responses -> Antigravity (Google contents[])
    expect(selectHeadroomStage({ sourceFormat: "openai-responses", targetFormat: "antigravity", provider: "antigravity" }))
      .toEqual({ stage: HEADROOM_STAGES.SOURCE_NATIVE, format: "openai-responses" });

    // Claude -> Gemini
    expect(selectHeadroomStage({ sourceFormat: "claude", targetFormat: "gemini", provider: "gemini" }))
      .toEqual({ stage: HEADROOM_STAGES.SOURCE_NATIVE, format: "claude" });
  });

  it("bypasses when both formats are non-native", () => {
    expect(selectHeadroomStage({ sourceFormat: "gemini", targetFormat: "antigravity", provider: "antigravity" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
  });

  it("selects PROJECTED for Kiro format", () => {
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "kiro", provider: "kiro" }))
      .toEqual({ stage: HEADROOM_STAGES.PROJECTED, format: "kiro" });
  });

  it("bypasses cursor and special streams", () => {
    expect(selectHeadroomStage({ sourceFormat: "cursor", targetFormat: "cursor", provider: "cursor" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
    expect(selectHeadroomStage({ sourceFormat: "openai", targetFormat: "commandcode", provider: "commandcode" }).stage)
      .toBe(HEADROOM_STAGES.BYPASS);
  });
});

describe("Headroom invariants guard", () => {
  it("accepts valid text compression in messages", () => {
    const orig = { messages: [{ role: "user", content: "hello world" }] };
    const comp = { messages: [{ role: "user", content: "hello" }] };
    expect(validateBodyInvariants(orig, comp, "openai")).toEqual({ valid: true });
  });

  it("rejects message count mismatch", () => {
    const orig = { messages: [{ role: "user", content: "1" }, { role: "assistant", content: "2" }] };
    const comp = { messages: [{ role: "user", content: "1" }] };
    expect(validateBodyInvariants(orig, comp, "openai").valid).toBe(false);
  });

  it("rejects altered tool_call_id or corrupted tool arguments JSON", () => {
    const orig = {
      messages: [{
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{\"a\":1}" } }],
      }],
    };
    const compBadId = {
      messages: [{
        role: "assistant",
        tool_calls: [{ id: "call_different", type: "function", function: { name: "test", arguments: "{\"a\":1}" } }],
      }],
    };
    expect(validateBodyInvariants(orig, compBadId, "openai").valid).toBe(false);

    const compBadJson = {
      messages: [{
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{corrupted json" } }],
      }],
    };
    expect(validateBodyInvariants(orig, compBadJson, "openai").valid).toBe(false);
  });

  it("preserves Responses encrypted_content", () => {
    const orig = {
      input: [{
        type: "reasoning",
        encrypted_content: "enc_123",
      }],
    };
    const compTampered = {
      input: [{
        type: "reasoning",
        encrypted_content: "enc_tampered",
      }],
    };
    expect(validateBodyInvariants(orig, compTampered, "openai-responses").valid).toBe(false);
  });

  it("rejects Responses item id and status mismatches", () => {
    const orig = {
      input: [{
        type: "message",
        id: "msg_orig_123",
        status: "in_progress",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
    };
    const compAlteredId = {
      input: [{
        type: "message",
        id: "msg_tampered_456",
        status: "in_progress",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
    };
    expect(validateBodyInvariants(orig, compAlteredId, "openai-responses").valid).toBe(false);

    const compAlteredStatus = {
      input: [{
        type: "message",
        id: "msg_orig_123",
        status: "completed",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
    };
    expect(validateBodyInvariants(orig, compAlteredStatus, "openai-responses").valid).toBe(false);
  });

  it("guards unknown Responses items with deep equality", () => {
    const orig = {
      input: [{
        type: "local_shell_call",
        id: "shell_1",
        command: "ls -la",
        env: { FOO: "bar" },
      }],
    };
    const compSame = {
      input: [{
        type: "local_shell_call",
        id: "shell_1",
        command: "ls -la",
        env: { FOO: "bar" },
      }],
    };
    expect(validateBodyInvariants(orig, compSame, "openai-responses")).toEqual({ valid: true });

    const compAltered = {
      input: [{
        type: "local_shell_call",
        id: "shell_1",
        command: "rm -rf /",
        env: { FOO: "bar" },
      }],
    };
    expect(validateBodyInvariants(orig, compAltered, "openai-responses").valid).toBe(false);
  });

  it("preserves Claude thinking blocks and signatures", () => {
    const orig = {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thoughts", signature: "sig_abc" },
          { type: "text", text: "result" },
        ],
      }],
    };
    const compValid = {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thoughts", signature: "sig_abc" },
          { type: "text", text: "compressed result" },
        ],
      }],
    };
    expect(validateBodyInvariants(orig, compValid, "claude")).toEqual({ valid: true });

    const compDropped = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "compressed result" }],
      }],
    };
    expect(validateBodyInvariants(orig, compDropped, "claude").valid).toBe(false);

    const compAlteredSig = {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thoughts", signature: "sig_corrupted" },
          { type: "text", text: "compressed result" },
        ],
      }],
    };
    expect(validateBodyInvariants(orig, compAlteredSig, "claude").valid).toBe(false);
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

  it("handles Headroom 0.38 array obligations and legacy objects", () => {
    expect(hasRelayUsage(["relay_usage"])).toBe(true);
    expect(hasRelayUsage(["redrive", "relay_usage"])).toBe(true);
    expect(hasRelayUsage(["redrive"])).toBe(false);
    expect(hasRelayUsage({ relay_usage: true })).toBe(true);
    expect(hasRelayUsage({ relay_usage: false })).toBe(false);
    expect(hasRelayUsage(null)).toBe(false);
  });

  it("normalizes diverse provider usage without double-counting", () => {
    // OpenAI usage
    expect(normalizeRelayUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      .toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 0, total_tokens: 15 });

    // Anthropic cache counters
    expect(normalizeRelayUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30 }))
      .toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 30, total_tokens: 15 });
  });

  it("completes once and fires async relay request with Headroom 0.38 integer status and no ttl_seconds", async () => {
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
    // Second complete is ignored (complete-once)
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
    expect(sentPayload.ttl_seconds).toBeUndefined();
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
