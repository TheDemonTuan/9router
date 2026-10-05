import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("Antigravity wire thinking for Claude 5.5", () => {
  it("maps Claude Antigravity requests to gemini-budget inside generationConfig", () => {
    const request = {
      model: "claude-sonnet-5-5",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    };

    applyThinking("antigravity", "claude-sonnet-5-5(high)", request, "antigravity", { mode: "level", level: "high" });

    expect(request.generationConfig).toBeDefined();
    expect(request.generationConfig.thinkingConfig).toBeDefined();
    expect(request.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
    expect(request.generationConfig.thinkingConfig.includeThoughts).toBe(true);

    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });

  it("does not change native Claude thinking format", () => {
    const request = {
      model: "claude-3-7-sonnet-20250219",
      messages: [{ role: "user", content: "hello" }],
    };

    applyThinking("claude", "claude-3-7-sonnet-20250219", request, "claude", { mode: "level", level: "high" });

    expect(request.thinking).toBeDefined();
    expect(request.thinking.type).toBe("enabled");
    expect(request.generationConfig).toBeUndefined();
  });
});
