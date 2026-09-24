import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { createPreResponseBudget } = await import("../../open-sse/utils/preResponseBudget.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleFusionChat } = await import("../../open-sse/services/combo.js");
const { bindResponseBody } = await import("../../open-sse/utils/responseLifecycle.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (status = 200, body = "{}") => new Response(body, {
  status,
  headers: { "content-type": "application/json" },
});

describe("pre-response budget end-to-end boundaries", () => {
  it("keeps fast headers but bounds a slow non-stream body read", async () => {
    fetchMock.mockReset();
    const budget = createPreResponseBudget({ budgetMs: 500 });
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          if (cancelled) return;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        }, 700);
      },
      cancel() { cancelled = true; },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const executor = new BaseExecutor("test", { baseUrl: "https://provider.test", timeoutMs: 100 });
    const upstream = await executor.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: { apiKey: "k" },
      preResponse: budget,
    });
    expect(upstream.response.status).toBe(200);
    await expect(budget.run(() => upstream.response.json())).rejects.toMatchObject({ status: 504 });
    expect(cancelled).toBe(true);
    budget.dispose();
  });
  it("cancels HTTP error body reads instead of retrying after deadline", async () => {
    fetchMock.mockReset();
    const cancel = vi.fn();
    let upstreamSignal;
    fetchMock.mockImplementation((_url, options) => {
      upstreamSignal = options.signal;
      return Promise.resolve(new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel }), { status: 429 }));
    });
    const budget = createPreResponseBudget({ budgetMs: 25 });
    const executor = new BaseExecutor("test", { baseUrl: "https://provider.test" });
    await expect(executor.execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" }, preResponse: budget })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
    expect(upstreamSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    budget.dispose();
  });

  it("cancels a transport response that resolves after client cancellation", async () => {
    fetchMock.mockReset();
    let resolveFetch;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const client = new AbortController();
    const budget = createPreResponseBudget({ clientSignal: client.signal, budgetMs: 500 });
    try {
      const executor = new BaseExecutor("test", { baseUrl: "https://provider.test" });
      const pending = executor.execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" }, signal: client.signal, preResponse: budget });
      client.abort(new Error("closed"));
      await expect(pending).rejects.toMatchObject({ code: "CLIENT_ABORT" });
      const cancel = vi.fn();
      resolveFetch(new Response(new ReadableStream({ pull() {}, cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
    }
  });
  it("cancels a forced SSE-to-JSON read instead of returning a synthetic 502", async () => {
    const cancel = vi.fn();
    const budget = createPreResponseBudget({ budgetMs: 20 });
    try {
      const upstream = new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel }), {
        headers: { "content-type": "text/event-stream" },
      });
      const pending = handleForcedSSEToJson({
        providerResponse: bindResponseBody(upstream, { signal: budget.signal }),
        provider: "test", model: "m", sourceFormat: "openai", targetFormat: "openai", body: {}, stream: true,
        trackDone: vi.fn(), appendLog: vi.fn(), requestStartTime: Date.now(), preResponse: budget,
      });
      await expect(pending).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
    }
  });



  it("shares one deadline across two account attempts", async () => {
    const budget = createPreResponseBudget({ budgetMs: 80 });
    await budget.run(() => wait(25));
    await expect(budget.run(() => wait(70))).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });
    expect(budget.remainingMs()).toBe(0);
    budget.dispose();
  });

  it("allows one 504 retry (60s + 3s + 37s scaled) but never starts a third request", async () => {
    fetchMock.mockReset();
    const budget = createPreResponseBudget({ budgetMs: 400 });
    const executor = new BaseExecutor("test", {
      baseUrl: "https://provider.test",
      timeoutMs: 150,
      retry: { 504: { attempts: 1, delayMs: 3 } },
    });
    let attempts = 0;
    fetchMock.mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        return new Promise((resolve, reject) => {
          const error = new Error("Upstream connect timeout");
          error.code = "UPSTREAM_CONNECT_TIMEOUT";
          error.status = 504;
          setTimeout(() => reject(error), 150);
        });
      }
      return new Promise(() => {});
    });
    await expect(executor.execute({
      model: "m",
      body: {},
      stream: false,
      credentials: { apiKey: "k" },
      preResponse: budget,
    })).rejects.toMatchObject({ status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    budget.dispose();
  });
  it("maps client abort to terminal 499", async () => {
    fetchMock.mockReset();
    const client = new AbortController();
    const budget = createPreResponseBudget({ clientSignal: client.signal, budgetMs: 500 });
    const executor = new BaseExecutor("test", { baseUrl: "https://provider.test", timeoutMs: 100 });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = executor.execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" }, signal: client.signal, preResponse: budget });
    setTimeout(() => client.abort(), 2);
    await expect(pending).rejects.toMatchObject({ code: "CLIENT_ABORT", status: 499 });
    budget.dispose();
  });

  it("never starts the fusion judge after the shared budget expires", async () => {
    const budget = createPreResponseBudget({ budgetMs: 5 });
    const calls = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn((body, model) => {
      calls.push(model);
      return wait(30).then(() => response(200, JSON.stringify({ choices: [{ message: { content: model } }] })));
    });
    await expect(handleFusionChat({
      body: { model: "combo", messages: [{ role: "user", content: "x" }] },
      models: ["panel-a", "panel-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      judgeModel: "judge",
      preResponse: budget,
      tuning: { panelHardTimeoutMs: 20, stragglerGraceMs: 1 },
    })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED", status: 504 });
    expect(calls).not.toContain("judge");
    budget.dispose();
  });

  it("stops combo fallback when preResponse deadline expires during retry cooldown", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const budget = createPreResponseBudget({ budgetMs: 30 });
    const calls = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return new Response(JSON.stringify({ error: { message: "Server overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(handleComboChat({
      body: { model: "combo-test", messages: [{ role: "user", content: "hi" }] },
      models: ["model-a", "model-b"],
      handleSingleModel,
      log,
      comboName: "combo-test",
      comboStrategy: "fallback",
      preResponse: budget,
    })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });

    expect(calls).toEqual(["model-a"]);
    budget.dispose();
  });

  it("passes preResponse to nested combo and halts child combo when budget expires", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const budget = createPreResponseBudget({ budgetMs: 30 });
    const log = { info: vi.fn(), warn: vi.fn() };
    const childCalls = [];

    const childHandleSingleModel = vi.fn(async (_body, model) => {
      childCalls.push(model);
      return new Response(JSON.stringify({ error: { message: "Server overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });

    const parentHandleSingleModel = vi.fn(async (body, model) => {
      if (model === "nested-child-combo") {
        return handleComboChat({
          body,
          models: ["child-model-1", "child-model-2"],
          handleSingleModel: childHandleSingleModel,
          log,
          comboName: "nested-child-combo",
          comboStrategy: "fallback",
          preResponse: budget,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(handleComboChat({
      body: { model: "parent-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["nested-child-combo", "parent-backup"],
      handleSingleModel: parentHandleSingleModel,
      log,
      comboName: "parent-combo",
      comboStrategy: "fallback",
      preResponse: budget,
    })).rejects.toMatchObject({ code: "PRE_RESPONSE_DEADLINE_EXCEEDED" });

    expect(childCalls).toEqual(["child-model-1"]);
    budget.dispose();
  });

  it("returns controlled 504 before route initialization finishes", async () => {
    vi.useFakeTimers();
    vi.doMock("../../src/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
    vi.doMock("../../open-sse/translator/index.js", () => ({ initTranslators: () => new Promise(() => {}) }));
    try {
      const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
      const pending = POST(new Request("http://localhost/v1/chat/completions", {
        method: "POST", body: JSON.stringify({ model: "m", messages: [] }),
        headers: { "content-type": "application/json" },
      }));
      await vi.advanceTimersByTimeAsync(100_001);
      const result = await pending;
      expect(result.status).toBe(504);
      expect(result.headers.get("x-9router-no-fallback")).toBe("true");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("../../src/sse/handlers/chat.js");
      vi.doUnmock("../../open-sse/translator/index.js");
      vi.resetModules();
    }
  });

  it("restores unmocked modules cleanly after route initialization test", async () => {
    const chat = await import("../../src/sse/handlers/chat.js");
    const translator = await import("../../open-sse/translator/index.js");
    expect(typeof chat.handleChat).toBe("function");
    expect(vi.isMockFunction(chat.handleChat)).toBe(false);
    expect(typeof translator.initTranslators).toBe("function");
    expect(vi.isMockFunction(translator.initTranslators)).toBe(false);
  });
});

describe("response body ownership", () => {
  it("rejects a pending body read immediately and cancels its source once", async () => {
    const { bindResponseBody } = await import("../../open-sse/utils/responseLifecycle.js");
    const abort = new AbortController();
    const reason = new Error("deadline");
    const cancel = vi.fn(() => new Promise(() => {}));
    const finalize = vi.fn();
    const source = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel });
    const response = bindResponseBody(new Response(source), { signal: abort.signal, onFinalize: finalize });
    const pending = response.text();
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("forwards downstream cancellation and handles abort before reading", async () => {
    const { bindResponseBody } = await import("../../open-sse/utils/responseLifecycle.js");
    const cancel = vi.fn();
    const source = () => new ReadableStream({ pull() { return new Promise(() => {}); }, cancel });
    const abort = new AbortController();
    const reason = new Error("closed");
    abort.abort(reason);
    const response = bindResponseBody(new Response(source()), { signal: abort.signal });
    await expect(response.text()).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    const reader = bindResponseBody(new Response(source())).body.getReader();
    await reader.cancel("reader closed");
    expect(cancel).toHaveBeenCalledWith("reader closed");
  });

  it("finalizes at ordinary EOF without cancelling the source", async () => {
    const { bindResponseBody } = await import("../../open-sse/utils/responseLifecycle.js");
    const cancel = vi.fn();
    const finalize = vi.fn();
    const response = bindResponseBody(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("ok")); controller.close(); }, cancel,
    })), { onFinalize: finalize });
    expect(await response.text()).toBe("ok");
    expect(cancel).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });
});
