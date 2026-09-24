import { describe, it, expect, vi, afterEach } from "vitest";
import { selectHeadroomStage, HEADROOM_STAGES } from "../../open-sse/rtk/headroomStage.js";
import { validateBodyInvariants } from "../../open-sse/rtk/headroomInvariants.js";
import { normalizeRelayUsage, createHeadroomTurnContext } from "../../open-sse/rtk/headroomRelay.js";

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

describe("Headroom response relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes diverse provider usage without double-counting", () => {
    // OpenAI usage
    expect(normalizeRelayUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
      .toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 0, total_tokens: 15 });

    // Anthropic cache counters
    expect(normalizeRelayUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30 }))
      .toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 30, total_tokens: 15 });
  });

  it("completes once and fires async relay request", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const ctx = createHeadroomTurnContext({
      url: "http://headroom:8787",
      proxyToken: "secret-token",
      turnId: "turn_999",
      obligations: { relay_usage: true },
      startTime: Date.now() - 100,
    });

    expect(ctx.isEligible).toBe(true);
    ctx.complete({ usage: { prompt_tokens: 50, completion_tokens: 25 }, status: "completed" });
    // Second complete is ignored (complete-once)
    ctx.complete({ usage: { prompt_tokens: 50, completion_tokens: 25 }, status: "completed" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://headroom:8787/v1/compress/response",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Headroom-Proxy-Token": "secret-token" }),
      })
    );
  });

  it("suppresses response relay when obligations.relay_usage is not true", () => {
    global.fetch = vi.fn();
    const ctx = createHeadroomTurnContext({
      url: "http://headroom:8787",
      proxyToken: "secret-token",
      turnId: "turn_999",
      obligations: { relay_usage: false },
      startTime: Date.now() - 100,
    });

    expect(ctx.isEligible).toBe(false);
    ctx.complete({ usage: { prompt_tokens: 50, completion_tokens: 25 }, status: "completed" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
