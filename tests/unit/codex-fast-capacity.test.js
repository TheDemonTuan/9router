import { describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { createPreResponseBudget } from "../../open-sse/utils/preResponseBudget.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("cancels a pending peek read on the shared deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel }), {
      headers: { "content-type": "text/event-stream" },
    });
    const budget = createPreResponseBudget({ budgetMs: 20 });
    await expect(new CodexExecutor()._peekSseTransientError(response, { preResponse: budget })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
    expect(cancel).toHaveBeenCalledTimes(1);
    budget.dispose();
  });

  it("does not issue another transport attempt when retry delay exceeds the shared deadline", async () => {
    const transport = vi.spyOn(BaseExecutor.prototype, "execute").mockImplementation(async () => ({
      response: new Response(streamFromText('event: error\ndata: {"error":{"message":"server_is_overloaded"}}\n\n'), {
        headers: { "content-type": "text/event-stream" },
      }),
    }));
    const budget = createPreResponseBudget({ budgetMs: 100 });
    try {
      await expect(new CodexExecutor().execute({ body: {}, preResponse: budget })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
      transport.mockRestore();
    }
  });

  it("replays split prefix and remainder byte-for-byte", async () => {
    const chunks = ["event: response.output_", "text.delta\ndata: {\"delta\":\"yes\"}\n\n", "data: [DONE]\n\n"];
    const stream = new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
    });
    const result = await new CodexExecutor()._peekSseTransientError(new Response(stream));
    expect(await new Response(result.replacementBody).text()).toBe(chunks.join(""));
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});
