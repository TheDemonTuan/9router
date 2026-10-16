import { describe, it, expect, beforeEach, vi } from "vitest";

import { getRotatedModels, resetComboRotation, handleComboChat } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("zero-content fallback preserves terminal and cancellation guards", () => {
  const empty = { choices: [{ message: { content: "" }, finish_reason: "incomplete" }] };
  const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
  const run = (handleSingleModel, overrides = {}) => handleComboChat({ body: {}, models: ["a/one", "b/two"], handleSingleModel, log: { info: vi.fn(), warn: vi.fn() }, autoSwitch: false, ...overrides });

  it("falls through a nonfinal empty JSON response and does not consume a returned body", async () => {
    const fallback = json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    const call = vi.fn().mockResolvedValueOnce(json(empty)).mockResolvedValueOnce(fallback);
    expect(await run(call)).toBe(fallback);
    expect(call).toHaveBeenCalledTimes(2);
    expect((await fallback.json()).choices[0].message.content).toBe("OK");
  });

  it("returns 2xx no-fallback before peeking or replaying", async () => {
    const response = json(empty, { "x-9router-no-fallback": "true" });
    const clone = vi.spyOn(response, "clone");
    const call = vi.fn().mockResolvedValue(response);
    expect(await run(call)).toBe(response);
    expect(call).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    expect(await response.json()).toEqual(empty);
  });

  it.each([
    { choices: [{ message: { tool_calls: [{ id: "call", function: { name: "lookup" } }] } }] },
    { choices: [{ message: { reasoning_content: "thinking" } }] },
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "" }, finish_reason: "length" }] },
  ])("keeps usable tools/reasoning/normal finish", async data => {
    const response = json(data);
    const call = vi.fn().mockResolvedValue(response);
    expect(await run(call)).toBe(response);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not peek SSE, invalid JSON, or a final empty seat", async () => {
    for (const response of [new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }), new Response("not json", { headers: { "content-type": "application/json" } })]) {
      const call = vi.fn().mockResolvedValue(response);
      expect(await run(call)).toBe(response);
      expect(call).toHaveBeenCalledTimes(1);
    }
    const response = json(empty);
    const clone = vi.spyOn(response, "clone");
    expect(await run(vi.fn().mockResolvedValue(response), { models: ["a/last"] })).toBe(response);
    expect(clone).not.toHaveBeenCalled();
  });

  it.each(["PRE_RESPONSE_DEADLINE_EXCEEDED", "CLIENT_ABORT"])("never falls back when peek throws %s", async code => {
    const error = Object.assign(new Error(code), { code });
    const response = json(empty);
    vi.spyOn(response, "clone").mockReturnValue({ json: async () => { throw error; } });
    const call = vi.fn().mockResolvedValue(response);
    await expect(run(call)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("propagates the request-local abort reason during JSON peek", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const response = json(empty);
    vi.spyOn(response, "clone").mockReturnValue({ json: async () => { controller.abort(reason); throw new Error("read aborted"); } });
    const call = vi.fn().mockResolvedValue(response);
    await expect(run(call, { preResponse: { signal: controller.signal, remainingMs: () => 1000 } })).rejects.toBe(reason);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
