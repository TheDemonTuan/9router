import { describe, expect, it } from "vitest";
import { projectPublicModel } from "../../open-sse/providers/publicModel.js";

describe("public model projection", () => {
  it("keeps only grounded summary fields and preserves explicit capabilities", () => {
    const model = projectPublicModel({
      id: "p/model",
      object: "model",
      owned_by: "p",
      name: "Model",
      description: "internal",
      context_length: 100000,
      max_context_length: 200000,
      max_completion_tokens: 32000,
      input_modalities: ["text", "image"],
      publicCapabilityEvidence: { tools: false, structured_output: false },
      output_modalities: ["text"],
      supported_reasoning_levels: ["low", "high"],
      default_reasoning_level: "medium",
      capabilities: {
        tools: false,
        search: true,
        reasoning: true,
        vision: true,
        contextWindow: 100000,
        thinkingFormat: "openai",
        structured_output: false,
      },
      created: 1686935002,
      priority: 1,
      upstream_extra: "must not escape",
    });

    expect(Object.keys(model)).toEqual([
      "id", "object", "owned_by", "name", "context_length", "max_completion_tokens",
      "input_modalities", "supported_reasoning_levels", "capabilities", "created",
    ]);
    expect(model).toEqual({
      id: "p/model",
      object: "model",
      owned_by: "p",
      name: "Model",
      context_length: 100000,
      max_completion_tokens: 32000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: ["low", "high"],
      capabilities: { search: true, tools: false, structured_output: false },
      created: 1686935002,
    });
  });

  it("omits fabricated limits and default text output, infers only evidenced vision", () => {
    const model = projectPublicModel({
      id: "p/unknown",
      object: "model",
      owned_by: "p",
      context_length: 0,
      max_completion_tokens: -1,
      output_modalities: ["text"],
      default_reasoning_level: "ultra",
      supported_reasoning_levels: ["low", "high"],
      capabilities: { vision: true, contextWindow: 200000, maxOutput: 64000 },
    });

    expect(model).toEqual({
      id: "p/unknown",
      object: "model",
      owned_by: "p",
      input_modalities: ["text", "image"],
      supported_reasoning_levels: ["low", "high"],
    });
  });

  it("keeps created only when the source provides a valid timestamp", () => {
    const source = { id: "p/model", object: "model", owned_by: "p", created: 1686935002 };
    expect(projectPublicModel(source).created).toBe(1686935002);
    expect(projectPublicModel({ ...source, created: 0 })).not.toHaveProperty("created");
    expect(projectPublicModel({ ...source, created: 1790158968878 })).not.toHaveProperty("created");
  });

  it("projects reasoning aliases to their six-field form", () => {
    expect(projectPublicModel({
      id: "p/model(high)",
      object: "model",
      owned_by: "p",
      base_model: "p/model",
      reasoning_effort: "high",
      virtual: true,
      name: "Model high",
      context_length: 100000,
      capabilities: { tools: true },
    })).toEqual({
      id: "p/model(high)",
      object: "model",
      owned_by: "p",
      base_model: "p/model",
      reasoning_effort: "high",
      virtual: true,
    });
  });
});
