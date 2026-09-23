import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { createPreResponseBudget } = await import("../../open-sse/utils/preResponseBudget.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleFusionChat } = await import("../../open-sse/services/combo.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (status = 200, body = "{}") => new Response(body, {
  status,
  headers: { "content-type": "application/json" },
});

describe("pre-response budget end-to-end boundaries", () => {
  it("keeps fast headers but bounds a slow non-stream body read", async () => {
    fetchMock.mockReset();
    const budget = createPreResponseBudget({ budgetMs: 500 });
    const body = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        }, 700);
      },
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
    budget.dispose();
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

  it("returns controlled 504 before route initialization finishes", async () => {
    const deadline = Object.assign(new Error("expired"), {
      code: "PRE_RESPONSE_DEADLINE_EXCEEDED",
      status: 504,
      retryable: true,
    });
    vi.doMock("../../open-sse/utils/preResponseBudget.js", () => ({
      createPreResponseBudget: () => ({
        run: () => Promise.reject(deadline),
        dispose: vi.fn(),
      }),
    }));
    vi.doMock("../../src/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
    vi.doMock("../../open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
    const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
    const result = await POST(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
      headers: { "content-type": "application/json" },
    }));
    expect(result.status).toBe(504);
    expect(result.headers.get("x-9router-no-fallback")).toBe("true");
  });
});
