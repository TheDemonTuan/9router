import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

function transform(model, effort, supportedReasoningLevels) {
  const body = {
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    reasoning_effort: effort,
  };
  new CodexExecutor().transformRequest(model, body, true, {
    connectionId: "codex-test",
    codexModelMetadata: { supportedReasoningLevels },
  });
  return body;
}

describe("Codex live reasoning metadata", () => {
  it("keeps Ultra for Sol", () => {
    expect(transform("gpt-6-sol", "ultra", [{ effort: "low" }, { effort: "ultra" }]).reasoning.effort).toBe("ultra");
  });

  it("keeps auto as an account default instruction", () => {
    expect(transform("gpt-6-sol", "auto", [{ effort: "low" }, { effort: "ultra" }]).reasoning.effort).toBe("auto");
  });

  it("rejects Ultra for Luna when the live account catalog excludes it", () => {
    expect(() => transform("gpt-6-luna", "ultra", [{ effort: "low" }, { effort: "max" }]))
      .toThrow(/Unsupported Codex reasoning effort/);
  });
});
