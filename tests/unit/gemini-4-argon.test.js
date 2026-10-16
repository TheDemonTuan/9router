import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { responsesToAntigravityRequest } from "../../open-sse/translator/request/responses-to-gemini.js";

describe("Gemini 4 Argon capabilities", () => {
  it.each(["gemini", "vertex", "antigravity"])("declares level-based always-on reasoning on %s", (provider) => {
    const model = provider === "antigravity" ? "gemini-4-argon-high" : "gemini-4-argon";
    const caps = getCapabilitiesForModel(provider, model);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels(provider, model)).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Argon thinking clamp", () => {
  // Argon rejects thinkingLevel "minimal" (and thinkingBudget) with HTTP 400 —
  // every path that would emit "minimal" must clamp to the lowest supported level.
  it("clamps an explicit reasoning_effort none to low", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("clamps a small thinking budget (minimal after conversion) to low", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 512 } };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("passes supported levels through untouched", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("keeps minimal for Gemini 3 models (regression guard)", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-3.8-flash", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: false });
  });
});

describe("Gemini 4 Argon Antigravity tier", () => {
  it("maps the high tier to the wire model with a high thinking level", () => {
    const upstreamModel = getModelUpstreamId("ag", "gemini-4-argon-high");
    expect(upstreamModel).toBe("gemini-4-argon-high(high)");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      "gemini-4-argon-high",
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });

  it.each([
    [{ reasoning_effort: "none" }, "low"],
    [{ reasoning_effort: "low" }, "low"],
    [{ reasoning: { effort: "medium" } }, "medium"],
    [{ thinking: { type: "enabled", budget_tokens: 512 } }, "low"],
    [{ request: { generationConfig: { thinkingConfig: { thinkingBudget: 512 } } } }, "low"],
    [{ reasoning_effort: "high" }, "high"],
  ])("honors explicit client intent over the registry high tier: %j", (body, level) => {
    applyThinking("antigravity", "gemini-4-argon-high(high)", body, "antigravity");
    const config = body.request?.generationConfig?.thinkingConfig || body.generationConfig?.thinkingConfig;
    expect(config).toEqual({ thinkingLevel: level, includeThoughts: true });
  });

  it("keeps Gemini 3 suffix precedence unchanged", () => {
    const body = { reasoning_effort: "low" };
    applyThinking("gemini", "gemini-3.8-flash(high)", body, "gemini");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });
});

describe("Gemini 4 final Antigravity payload", () => {
  const credentials = { projectId: "synthetic-project", connectionId: "synthetic-connection" };
  it.each(["chat", "responses", "native"])("strips sampling only for Argon on the %s path and keeps the output cap", (path) => {
    const model = "gemini-4-argon-high";
    let body;
    if (path === "chat") body = openaiToAntigravityRequest(model, {
      messages: [{ role: "user", content: "Reply OK" }], temperature: 0.2, top_p: 0.7, top_k: 4, max_tokens: 100000,
    }, false, credentials);
    else if (path === "responses") body = responsesToAntigravityRequest(model, {
      input: "Reply OK", temperature: 0.2, top_p: 0.7, top_k: 4, max_output_tokens: 100000,
    }, false, credentials);
    else body = { model, request: {
      contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
      generationConfig: { temperature: 0.2, topP: 0.7, topK: 4, maxOutputTokens: 100000 },
    } };
    body.reasoning_effort = "none";
    applyThinking("antigravity", model, body, "antigravity");
    const final = new AntigravityExecutor().transformRequest(model, body, false, credentials);
    expect(final.model).toBe(model);
    expect(final.request.generationConfig.maxOutputTokens).toBe(64000);
    for (const key of ["temperature", "topP", "topK"]) expect(final.request.generationConfig).not.toHaveProperty(key);
    expect(final.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("keeps native Gemini 3 sampling and Claude final model turn", () => {
    const executor = new AntigravityExecutor();
    const flash = executor.transformRequest("gemini-3.8-flash-high", { model: "gemini-3.8-flash-high", request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { temperature: 0.2, topP: 0.7, topK: 4 },
    } }, false, credentials);
    expect(flash.request.generationConfig).toMatchObject({ temperature: 0.2, topP: 0.7, topK: 4 });
    const claude = executor.transformRequest("claude-sonnet-5-5", { model: "claude-sonnet-5-5", request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "prefill" }] }],
    } }, false, credentials);
    expect(claude.request.contents.at(-1).role).toBe("model");
  });
});
