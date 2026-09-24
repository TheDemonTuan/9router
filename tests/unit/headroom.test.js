import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog } from "../../open-sse/rtk/headroom.js";

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
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        body: { messages: [{ role: "user", content: "short" }] },
        turn_id: "turn_1",
        obligations: { relay_usage: true },
        headers: { "x-provider-req": "header-val" },
      },
      tokens_before: 100,
      tokens_after: 20,
      tokens_saved: 80,
    }), { status: 200 }));
    const body = { messages: [{ role: "user", content: "long" }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://headroom:8787/", model: "gpt-4o" });

    expect(body.messages[0].content).toBe("short");
    expect(stats.tokens_saved).toBe(80);
    expect(stats.providerHeaders).toEqual({ "x-provider-req": "header-val" });
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/v1/compress", expect.objectContaining({ method: "POST" }));
  });

  it("compresses responses input in-place with Gateway v2 contract", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        body: { input: [{ role: "user", content: "short" }] },
      },
    }), { status: 200 }));
    const body = { input: [{ role: "user", content: "long" }] };

    await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787", format: "openai-responses" });

    expect(body.input[0].content).toBe("short");
  });

  it("compresses Kiro conversationState history/currentMessage in-place", async () => {
    let requestPayload;
    global.fetch = vi.fn(async (_url, init) => {
      requestPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        data: {
          body: {
            messages: [
              { role: "user", content: "compressed earlier user" },
              { role: "assistant", content: "compressed assistant", tool_calls: [{ id: "tool_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] },
              { role: "system", content: "compressed system instruction" },
              { role: "user", content: "compressed current user" },
              { role: "tool", content: [{ type: "text", text: "compressed tool output" }], tool_call_id: "tool_1" },
            ],
          },
        },
        tokens_before: 100,
        tokens_after: 40,
        tokens_saved: 60,
      }), { status: 200 });
    });
    const body = {
      profileArn: "arn:test",
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: "conv-1",
        history: [
          {
            userInputMessage: {
              content: "earlier user",
              modelId: "claude-sonnet-4.5",
            },
          },
          {
            assistantResponseMessage: {
              content: "assistant response",
              toolUses: [
                {
                  toolUseId: "tool_1",
                  name: "read_file",
                  input: { path: "a.js" },
                },
              ],
            },
          },
        ],
        currentMessage: {
          userInputMessage: {
            content: "current user",
            modelId: "claude-sonnet-4.5",
            systemInstruction: "native system instruction",
            userInputMessageContext: {
              tools: [{ toolSpecification: { name: "read_file" } }],
              toolResults: [
                {
                  toolUseId: "tool_1",
                  status: "success",
                  content: [{ text: "long tool output" }],
                },
              ],
            },
          },
        },
      },
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "claude-sonnet-4.5",
      format: "kiro",
      compressUserMessages: true,
    });

    expect(stats.tokens_saved).toBe(60);
    expect(requestPayload).toMatchObject({
      model: "claude-sonnet-4.5",
      config: { compress_user_messages: true },
      gateway: { can_redrive: false, can_relay_response: true, session_affinity: false },
      messages: [
        { role: "user", content: "earlier user" },
        {
          role: "assistant",
          content: "assistant response",
          tool_calls: [
            {
              id: "tool_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" },
            },
          ],
        },
        { role: "system", content: "native system instruction" },
        { role: "user", content: "current user" },
        { role: "tool", content: "long tool output", tool_call_id: "tool_1" },
      ],
    });
    expect(body.conversationState.history[0].userInputMessage.content).toBe("compressed earlier user");
    expect(body.conversationState.history[1].assistantResponseMessage.content).toBe("compressed assistant");
    expect(body.conversationState.currentMessage.userInputMessage.systemInstruction).toBe("compressed system instruction");
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("compressed current user");
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content[0].text)
      .toBe("compressed tool output");
  });

  it("fails open when Kiro Headroom output does not preserve message order", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        body: { messages: [{ role: "assistant", content: "wrong role" }] },
      },
      tokens_saved: 10,
    }), { status: 200 }));
    const body = {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "original",
            modelId: "claude-sonnet-4.5",
          },
        },
        history: [],
      },
    };
    const original = structuredClone(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "claude-sonnet-4.5",
      format: "kiro",
      diagnostics,
    });

    expect(stats).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toMatch(/order|mismatch/);
  });

  it("fails open on bad response", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 500 }));
    const body = { messages: [{ role: "user", content: "long" }] };

    const stats = await compressWithHeadroom(body, { enabled: true, url: "http://localhost:8787" });

    expect(stats).toBeNull();
    expect(body.messages[0].content).toBe("long");
  });

  it("bypasses when budget is exhausted", async () => {
    global.fetch = vi.fn();
    const body = { messages: [{ role: "user", content: "hello" }] };
    const diagnostics = {};

    // preResponse with less than 1500ms reserve
    const mockPreResponse = {
      remainingMs: () => 1000,
      signal: new AbortController().signal,
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      timeoutMs: 1000,
      preResponse: mockPreResponse,
      diagnostics,
    });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diagnostics.reason).toBe("budget_exhausted");
  });
});

describe("formatHeadroomLog", () => {
  it("formats reported token deltas without implying provider billing savings", () => {
    expect(formatHeadroomLog({ tokens_before: 100, tokens_after: 25, tokens_saved: 75 }))
      .toBe("reported token delta=75 before=100 after=25 (75.0%)");
  });

  it("reports effective payload, tool-schema, and tool-history sizes with byte delta", () => {
    expect(formatHeadroomSizeLog({
      before: { bodyBytes: 1000, messageBytes: 800, toolSchemaBytes: 100, toolHistoryBytes: 500 },
      after: { bodyBytes: 900, messageBytes: 700, toolSchemaBytes: 100, toolHistoryBytes: 400 },
    })).toContain("body=1000B→900B (Δ=100B, 10.0%)");
  });
});
