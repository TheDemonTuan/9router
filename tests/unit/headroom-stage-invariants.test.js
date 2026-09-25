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

describe("Headroom 0.38 Responses upstream mutation invariants", () => {
  const createBaseResponsesBody = () => ({
    model: "gpt-4o",
    instructions: "You are a helpful coding assistant.",
    input: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "user",
        content: [{ type: "input_text", text: "Please inspect the repo and fix the bug." }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_read_1",
        name: "readFile",
        arguments: JSON.stringify({ path: "src/index.js", lines: 100 }),
      },
      {
        type: "function_call_output",
        id: "fco_1",
        call_id: "call_read_1",
        output: "function output long contents",
      },
      {
        type: "local_shell_call",
        id: "lsc_1",
        call_id: "call_sh_1",
        name: "bash",
        input: "git status --porcelain",
      },
      {
        type: "local_shell_call_output",
        id: "lsco_1",
        call_id: "call_sh_1",
        output: "M open-sse/rtk/headroomInvariants.js\n",
      },
      {
        type: "apply_patch_call",
        id: "apc_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: "*** patch line 1 ***\n*** patch line 2 ***",
      },
      {
        type: "apply_patch_call_output",
        id: "apco_1",
        call_id: "call_patch_1",
        output: "patch applied successfully",
      },
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_custom_1",
        name: "special_tool",
        input: "custom command with arguments",
      },
      {
        type: "custom_tool_call_output",
        id: "ctco_1",
        call_id: "call_custom_1",
        output: "custom tool execution output",
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Planning the next steps..." }],
        encrypted_content: "opaque_encrypted_token_stream",
      },
      {
        type: "message",
        id: "msg_2",
        status: "completed",
        role: "assistant",
        content: "Here is the summary.",
        internal_chat_message_metadata_passthrough: { traceId: "tr_abc123" },
      },
    ],
    tools: [{ type: "function", name: "readFile" }],
  });

  it("1. allows instructions to be compressed (string -> string)", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.instructions = "Helpful assistant.";
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });
  });

  it("2. allows function_call_output.output to be compressed (text/text-array)", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[2].output = "compressed output";
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });

    // Text array form
    const origArray = createBaseResponsesBody();
    origArray.input[2].output = [{ type: "output_text", text: "long output text" }];
    const compArray = structuredClone(origArray);
    compArray.input[2].output = [{ type: "output_text", text: "short output" }];
    expect(validateBodyInvariants(origArray, compArray, "openai-responses")).toEqual({ valid: true });
  });

  it("3. allows local_shell_call_output.output to be compressed", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[4].output = "M headroomInvariants.js\n";
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });
  });

  it("4. allows apply_patch_call_output.output to be compressed", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[6].output = "ok";
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });
  });

  it("5. allows custom_tool_call.input, local_shell_call.input, apply_patch_call.input to be compressed", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[3].input = "git status"; // local_shell_call.input
    comp.input[5].input = "patch diff"; // apply_patch_call.input
    comp.input[7].input = "custom command"; // custom_tool_call.input
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });
  });

  it("6. allows function_call.arguments when compressed to valid JSON", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[1].arguments = JSON.stringify({ path: "src/index.js" });
    expect(validateBodyInvariants(orig, comp, "openai-responses")).toEqual({ valid: true });
  });

  it("7. rejects function_call.arguments when compressed to corrupted JSON", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[1].arguments = "{broken json, missing brace";
    const res = validateBodyInvariants(orig, comp, "openai-responses");
    expect(res.valid).toBe(false);
    expect(res.detail).toBe("input.1.arguments");
  });

  it("8. rejects reasoning.encrypted_content mutation", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[9].encrypted_content = "altered_ciphertext";
    const res = validateBodyInvariants(orig, comp, "openai-responses");
    expect(res.valid).toBe(false);
    expect(res.detail).toBe("input.9.encrypted_content");
  });

  it("9. rejects call_id mutation on function_call or outputs", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[1].call_id = "call_different";
    const res = validateBodyInvariants(orig, comp, "openai-responses");
    expect(res.valid).toBe(false);
    expect(res.detail).toBe("input.1.call_id");
  });

  it("10. rejects item ID, order, type, or status mutations", () => {
    const orig = createBaseResponsesBody();
    // ID mutation
    const compId = structuredClone(orig);
    compId.input[0].id = "msg_tampered";
    expect(validateBodyInvariants(orig, compId, "openai-responses")).toEqual({
      valid: false,
      reason: "immutable_field_changed",
      detail: "input.0.id",
    });

    // Status mutation
    const compStatus = structuredClone(orig);
    compStatus.input[0].status = "in_progress";
    expect(validateBodyInvariants(orig, compStatus, "openai-responses")).toEqual({
      valid: false,
      reason: "immutable_field_changed",
      detail: "input.0.status",
    });

    // Type mutation
    const compType = structuredClone(orig);
    compType.input[0].type = "reasoning";
    expect(validateBodyInvariants(orig, compType, "openai-responses").valid).toBe(false);

    // Order mutation
    const compOrder = structuredClone(orig);
    const tmp = compOrder.input[0];
    compOrder.input[0] = compOrder.input[1];
    compOrder.input[1] = tmp;
    expect(validateBodyInvariants(orig, compOrder, "openai-responses").valid).toBe(false);

    // Item count mutation
    const compCount = structuredClone(orig);
    compCount.input.pop();
    expect(validateBodyInvariants(orig, compCount, "openai-responses").valid).toBe(false);
  });

  it("11. rejects metadata / internal_chat_message_metadata_passthrough changes", () => {
    const orig = createBaseResponsesBody();
    const comp = structuredClone(orig);
    comp.input[10].internal_chat_message_metadata_passthrough.traceId = "tr_tampered";
    const res = validateBodyInvariants(orig, comp, "openai-responses");
    expect(res.valid).toBe(false);
    expect(res.detail).toContain("internal_chat_message_metadata_passthrough");
  });

  it("12. allows tools schema compaction when transform tool_schema_compaction is present", () => {
    const orig = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "   Get current weather for location   ",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: "https://example.com/weather.json",
            $comment: "weather comment",
            title: "WeatherParams",
            type: "object",
            properties: {
              location: {
                type: "string",
                title: "City Name",
                description: "The city, e.g. San Francisco",
                examples: ["San Francisco", "Tokyo"],
                deprecated: false,
                readOnly: false,
                writeOnly: false,
                markdownDescription: "City name in English",
              },
            },
            required: ["location"],
          },
        },
      ],
    };
    const comp = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get current weather for location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city, e.g. San Francisco",
              },
            },
            required: ["location"],
          },
        },
      ],
    };

    const res = validateBodyInvariants(orig, comp, "openai-responses", {
      transforms: ["tool_schema_compaction"],
    });
    expect(res).toEqual({ valid: true });
  });

  it("13. rejects tools schema changes when transforms does not include tool_schema_compaction", () => {
    const orig = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            title: "WeatherParams",
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    };
    const comp = structuredClone(orig);
    delete comp.tools[0].parameters.title;

    const res = validateBodyInvariants(orig, comp, "openai-responses");
    expect(res.valid).toBe(false);
    expect(res.detail).toBe("tools");
  });

  it("14. rejects tool mutations breaking name, ordering, required or properties", () => {
    const orig = {
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
    };

    // 1. Tool name changed
    const compName = structuredClone(orig);
    compName.tools[0].name = "fetch_weather";
    expect(validateBodyInvariants(orig, compName, "openai-responses", { transforms: ["tool_schema_compaction"] }).valid).toBe(false);

    // 2. Required array changed
    const compReq = structuredClone(orig);
    compReq.tools[0].parameters.required = [];
    expect(validateBodyInvariants(orig, compReq, "openai-responses", { transforms: ["tool_schema_compaction"] }).valid).toBe(false);

    // 3. Properties key changed
    const compProp = structuredClone(orig);
    compProp.tools[0].parameters.properties = { city: { type: "string" } };
    expect(validateBodyInvariants(orig, compProp, "openai-responses", { transforms: ["tool_schema_compaction"] }).valid).toBe(false);

    // 4. Type changed
    const compType = structuredClone(orig);
    compType.tools[0].parameters.properties.location.type = "number";
    expect(validateBodyInvariants(orig, compType, "openai-responses", { transforms: ["tool_schema_compaction"] }).valid).toBe(false);
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

    // Anthropic cache counters with creation and read
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
