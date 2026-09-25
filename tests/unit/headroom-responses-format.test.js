// tests/unit/headroom-responses-format.test.js
// Modernized for Headroom 0.38.0 Native Gateway v2 contract.
// Preserves Responses input structure, reasoning, tools, and call_ids safely.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998, #2132)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Gateway v2 contract returns top-level { body: { input: [...] }, turn_id, obligations, headers }
    global.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      expect(payload.gateway).toEqual({
        can_redrive: false,
        can_relay_response: true,
        session_affinity: false,
      });
      return new Response(JSON.stringify({
        body: { model: payload.model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compressed text" }] }] },
        turn_id: "turn_123",
        obligations: ["relay_usage"],
        headers: { "openai-beta": "responses-2025" },
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }), { status: 200 });
    });

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(body.input[0].content[0].text).toBe("compressed text");
  });

  it("natively compresses Responses tool/reasoning history preserving invariants (0.38 Gateway v2)", async () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "{\"patch\":\"unified diff\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: "ok",
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
        encrypted_content: "opaque_ciphertext",
      },
    ];

    global.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      expect(payload.input).toBeDefined();
      expect(payload.gateway).toEqual({
        can_redrive: false,
        can_relay_response: true,
        session_affinity: false,
      });
      return new Response(JSON.stringify({
        body: { model: payload.model, input: [
          { ...payload.input[0], content: [{ type: "input_text", text: "investigate" }] },
          payload.input[1], payload.input[2], payload.input[3],
        ], tools: payload.tools },
        turn_id: "turn_abc",
        obligations: ["relay_usage"],
        tokens_before: 200,
        tokens_after: 120,
        tokens_saved: 80,
      }), { status: 200 });
    });

    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    expect(data.tokens_saved).toBe(80);
    expect(body.input[0].content[0].text).toBe("investigate");
    expect(body.input[1].call_id).toBe("call_apply_patch_123");
    expect(body.input[3].encrypted_content).toBe("opaque_ciphertext");
  });

  it("updates instructions and compresses arguments/tool-outputs cleanly (Headroom 0.38 upstream)", async () => {
    const origBody = {
      instructions: "You are an expert engineer. Follow all instructions carefully.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please apply the patch and verify output." }],
        },
        {
          type: "function_call",
          call_id: "call_tool_1",
          name: "exec_cmd",
          arguments: "{\"cmd\":\"ls -la /workspace\",\"timeout\":30}",
        },
        {
          type: "function_call_output",
          call_id: "call_tool_1",
          output: "total 128\ndrwxr-xr-x 1 root root 4096 Jan 1 00:00 .\n",
        },
        {
          type: "apply_patch_call",
          call_id: "call_patch_1",
          name: "apply_patch",
          input: "*** old.js\n--- new.js\n+console.log('patched');",
        },
        {
          type: "apply_patch_call_output",
          call_id: "call_patch_1",
          output: "Applied patch successfully to new.js",
        },
      ],
    };

    global.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        body: {
          model: payload.model,
          instructions: "Expert engineer. Follow instructions.",
          input: [
            { ...payload.input[0], content: [{ type: "input_text", text: "Apply patch and verify." }] },
            { ...payload.input[1], arguments: "{\"cmd\":\"ls -la\"}" },
            { ...payload.input[2], output: "total 128\n" },
            { ...payload.input[3], input: "+console.log('patched');" },
            { ...payload.input[4], output: "Patch applied." },
          ],
        },
        turn_id: "turn_full_flow",
        obligations: ["relay_usage"],
        tokens_before: 500,
        tokens_after: 250,
        tokens_saved: 250,
      }), { status: 200 });
    });

    const body = structuredClone(origBody);
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: "gpt-4o",
      format: "openai-responses",
      diagnostics,
    });

    expect(result).not.toBeNull();
    expect(result.tokens_saved).toBe(250);
    expect(body.instructions).toBe("Expert engineer. Follow instructions.");
    expect(body.input[0].content[0].text).toBe("Apply patch and verify.");
    expect(body.input[1].arguments).toBe("{\"cmd\":\"ls -la\"}");
    expect(body.input[2].output).toBe("total 128\n");
    expect(body.input[3].input).toBe("+console.log('patched');");
    expect(body.input[4].output).toBe("Patch applied.");
  });

  it("fails open and captures invariant detail when upstream returns corrupted arguments JSON", async () => {
    const origBody = {
      instructions: "Instructions",
      input: [
        {
          type: "message",
          role: "user",
          content: "Run command",
        },
        {
          type: "function_call",
          call_id: "call_bad_1",
          name: "exec_cmd",
          arguments: "{\"cmd\":\"echo 1\"}",
        },
      ],
    };

    global.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        body: {
          model: payload.model,
          instructions: payload.instructions,
          input: [
            payload.input[0],
            { ...payload.input[1], arguments: "{broken-json" },
          ],
        },
        turn_id: "turn_bad",
        obligations: [],
      }), { status: 200 });
    });

    const body = structuredClone(origBody);
    const diagnostics = {};
    const result = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom:8787",
      model: "gpt-4o",
      format: "openai-responses",
      diagnostics,
    });

    expect(result).toBeNull();
    expect(diagnostics.reason).toBe("invariant_violation");
    expect(diagnostics.detail).toBe("input.1.arguments");
    // Body remains untouched (fail-open)
    expect(body.input[1].arguments).toBe("{\"cmd\":\"echo 1\"}");
  });
});
