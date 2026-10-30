import { describe, expect, it } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

// Sonnet 5.5 keeps Sonnet 5's API price ($2 / $10 per 1M) and the 5.x
// adaptive-thinking family. Without explicit rows both fell through to the
// generic claude-sonnet-* pattern: $3 / $15 and budget thinking.
describe("Claude Sonnet 5.5", () => {
  it("is listed for the claude provider", () => {
    expect(getModelsByProviderId("claude").some((model) => model.id === "claude-sonnet-5-5")).toBe(true);
  });

  it("resolves to adaptive thinking with a 1M context", () => {
    expect(getCapabilitiesForModel("claude", "claude-sonnet-5-5")).toMatchObject({
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it.each(["claude-sonnet-5-5", "claude-sonnet-5"])("bills cached continuation and 1h writes at Sonnet 5 prices for %s", model => {
    const cost = calculateCostFromTokens({ prompt_tokens: 330, completion_tokens: 50, cached_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }, getPricingForModel("claude", model));
    expect(cost).toBeCloseTo((100 * 2 + 200 * 0.2 + 10 * 2.5 + 20 * 4 + 50 * 10) / 1e6, 12);
  });
});

// Sonnet 5.5 returns 400 for thinking.type "disabled" and for forced tool use.
describe("Claude Sonnet 5.5 request shape", () => {
  const prepare = (body) => prepareClaudeRequest({ max_tokens: 1024, messages: [{ role: "user", content: "hi" }], ...body }, "claude");

  it("turns thinking off with between_tools, clamping effort to high", () => {
    const body = prepare({ model: "claude-sonnet-5-5", thinking: { type: "disabled" }, output_config: { effort: "max" } });
    expect(body.thinking).toEqual({ type: "between_tools" });
    expect(body.output_config.effort).toBe("high");
  });

  it("maps forced tool_choice to auto", () => {
    expect(prepare({ model: "claude-sonnet-5-5", tool_choice: { type: "any" } }).tool_choice).toEqual({ type: "auto" });
    expect(prepare({ model: "claude-sonnet-5-5", tool_choice: { type: "tool", name: "run", disable_parallel_tool_use: true } }).tool_choice)
      .toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("leaves other models untouched", () => {
    const body = prepare({ model: "claude-sonnet-5", thinking: { type: "disabled" }, tool_choice: { type: "any" } });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tool_choice).toEqual({ type: "any" });
  });

  it("covers the native Claude passthrough path end to end", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-sonnet-5-5", {
      model: "claude-sonnet-5-5", max_tokens: 1000, thinking: { type: "disabled" }, tool_choice: { type: "any" },
      tools: [{ name: "run", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.thinking).toEqual({ type: "between_tools" });
    expect(out.tool_choice).toEqual({ type: "auto" });
  });

  it("covers the OpenAI-client path end to end", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-5-5", {
      model: "claude-sonnet-5-5", reasoning_effort: "none", tool_choice: "required",
      tools: [{ type: "function", function: { name: "run", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.thinking).toEqual({ type: "between_tools" });
    expect(out.tool_choice.type).toBe("auto");
  });
});
