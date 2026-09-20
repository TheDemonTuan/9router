// Translation-pipeline integration tests. These drive shipped translateRequest
// (capture intent → source/target conversion → applyThinking → final wire body),
// not the mapper in isolation. No network/inference calls.
import { describe, expect, it } from "vitest";

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const P = "alitp-intl";
const openaiBody = (extra = {}) => ({
  model: "ignored-by-translator",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});
const claudeBody = (extra = {}) => ({
  model: "ignored-by-translator",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

describe("Alibaba Token Plan shipped translation pipeline", () => {
  it("OpenAI Chat → Alibaba Chat: suffix applies Chat reasoning_effort", () => {
    const body = openaiBody({ reasoning_effort: "medium", thinking_budget: 999 });
    const original = JSON.stringify(body);
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "qwen3.8-max(xhigh)", body, true, null, P);
    expect(out.reasoning_effort).toBe("xhigh");
    expect(out.thinking_budget).toBeUndefined();
    expect(out.enable_thinking).toBeUndefined();
    // Mapper copy-on-write means combo retries retain the original source body.
    expect(JSON.stringify(body)).toBe(original);
  });

  it("Responses → Alibaba Responses: merges effort without dropping summary", () => {
    const body = openaiBody({
      input: "hello",
      reasoning: { effort: "high", summary: "auto" },
      previous_response_id: "resp_continuation",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "qwen3.8-max(medium)", body, true, null, P);
    expect(out.reasoning).toEqual({ summary: "auto", effort: "medium" });
    expect(out.thinking_budget).toBeUndefined();
    expect(out.previous_response_id).toBe("resp_continuation");
    expect(out.tools).toEqual(body.tools);
  });

  it("Claude → Alibaba Claude: output_config.format and thinking.display survive", () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    const body = claudeBody({
      thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
      output_config: { format },
      tools: [{ name: "tool", input_schema: { type: "object" } }],
    });
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "qwen3.8-max(high)", body, true, null, P);
    expect(out.thinking).toEqual({ type: "enabled", display: "summarized" });
    expect(out.output_config).toEqual({ format, effort: "xhigh" });
    // prepareClaudeRequest may add cache_control, so check the client tool's
    // semantic fields rather than requiring byte-identical wrapper metadata.
    expect(out.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tool", input_schema: { type: "object" } }),
    ]));
  });

  it("OpenAI Chat → Alibaba Responses fallback emits reasoning.effort, never Qwen budget fields", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "qwen3.7-plus(xhigh)", openaiBody({ reasoning_effort: "high" }), true, null, P);
    expect(out.reasoning?.effort).toBe("xhigh");
    expect(out.enable_thinking).toBeUndefined();
    expect(out.thinking_budget).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("cross-protocol fallback preserves Responses summary and Claude output format", () => {
    const fromResponses = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI,
      "qwen3.8-max(low)",
      openaiBody({ reasoning: { effort: "xhigh", summary: "detailed" } }),
      true, null, P,
    );
    expect(fromResponses.reasoning).toEqual({ summary: "detailed" });
    expect(fromResponses.reasoning_effort).toBe("low");

    const format = { type: "json_schema", schema: { type: "object" } };
    const fromClaude = translateRequest(
      FORMATS.CLAUDE, FORMATS.OPENAI,
      "qwen3.8-max(low)",
      claudeBody({ output_config: { format, effort: "xhigh" } }),
      true, null, P,
    );
    expect(fromClaude.output_config).toEqual({ format });
    expect(fromClaude.reasoning_effort).toBe("low");
  });

  it("Claude → Alibaba Chat fallback applies Chat disable wire", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "qwen3.8-max(none)", claudeBody({ thinking: { type: "disabled" } }), true, null, P);
    expect(out.enable_thinking).toBe(false);
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("qwen3.8 auto removes source controls after source/target conversion", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "qwen3.8-max(auto)", openaiBody({ reasoning: { effort: "low", summary: "auto" } }), true, null, P);
    expect(out.reasoning).toEqual({ summary: "auto" });
    // summary:"auto" is client data and must survive; only effort:auto is forbidden.
    expect(out.reasoning.effort).toBeUndefined();
  });

  it("deepseek-v4.1-flash(ultra) errors before executor dispatch on Responses", () => {
    expect(() => translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "deepseek-v4.1-flash(ultra)",
      openaiBody({ input: "hello" }),
      true,
      null,
      P,
    )).toThrowError(expect.objectContaining({ code: "invalid_thinking_level" }));
  });

  it("invalid suffix errors before executor dispatch with supported levels", () => {
    try {
      translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "qwen3.8-max(bogus)", openaiBody(), true, null, P);
      expect.unreachable("expected invalid suffix error");
    } catch (error) {
      expect(error.code).toBe("invalid_thinking_level");
      expect(error.message).toContain("none, low, medium, xhigh");
    }
  });

  it("GLM-5.3 none errors through pipeline on every target protocol", () => {
    for (const format of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE]) {
      expect(() => translateRequest(format, format, "glm-5.3(none)",
        format === FORMATS.CLAUDE ? claudeBody() : openaiBody(), true, null, P,
      )).toThrowError(expect.objectContaining({ code: "invalid_thinking_level" }));
    }
  });

  it("deprecated preview remains routable to canonical upstream id through pipeline", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "qwen3.8-max-preview(xhigh)", openaiBody({ model: "qwen3.8-max-preview(xhigh)" }), true, null, P);
    expect(out.model).toBe("qwen3.8-max");
    expect(out.reasoning_effort).toBe("xhigh");
  });
});
