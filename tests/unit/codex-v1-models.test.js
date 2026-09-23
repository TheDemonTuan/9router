import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as getModelById } from "@/app/api/v1/models/[...model]/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import {
  normalizeCodexCatalog,
  mergeCodexModelLists,
  resolveCodexModels,
} from "../../open-sse/services/codexModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("GPT-6 Codex /v1/models and capabilities", () => {
  it("advertises correct GPT-6 models with reasoning, thinking and token limits without connection", async () => {
    const models = await buildModelsList(["llm"]);

    const astra = models.find((m) => m.id === "cx/gpt-6-astra");
    expect(astra).toBeDefined();
    expect(Object.keys(astra)).toEqual([
      "id", "object", "owned_by", "name", "context_length", "max_completion_tokens",
      "input_modalities", "default_reasoning_level", "supported_reasoning_levels", "capabilities",
    ]);
    expect(astra.context_length).toBe(272000);
    expect(astra.max_completion_tokens).toBe(128000);
    expect(astra.default_reasoning_level).toBe("low");
    expect(astra.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(astra.capabilities).toEqual({ search: true, tools: true });
    expect(astra.input_modalities).toEqual(["text", "image"]);

    const sol = models.find((m) => m.id === "cx/gpt-6-sol");
    expect(sol).toBeDefined();
    expect(Object.keys(sol)).toEqual([
      "id", "object", "owned_by", "name", "context_length", "max_completion_tokens",
      "input_modalities", "default_reasoning_level", "supported_reasoning_levels", "capabilities",
    ]);
    expect(sol.context_length).toBe(272000);
    expect(sol.max_completion_tokens).toBe(128000);
    expect(sol.default_reasoning_level).toBe("medium");
    expect(sol.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(sol).not.toHaveProperty("description");
    expect(sol).not.toHaveProperty("minimal_client_version");
    expect(sol).not.toHaveProperty("max_context_length");
    expect(sol.input_modalities).toEqual(["text", "image"]);
    expect(sol.capabilities).toEqual({ search: true, tools: true });

    const luna = models.find((m) => m.id === "cx/gpt-6-luna");
    expect(luna).toBeDefined();
    expect(luna.context_length).toBe(272000);
    expect(luna.max_completion_tokens).toBe(128000);
    expect(luna.default_reasoning_level).toBe("medium");
    expect(luna.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(luna.input_modalities).toEqual(["text", "image"]);
    expect(luna.capabilities).toEqual({ search: true, tools: true });

    // Virtual thinking variants
    const solUltra = models.find((m) => m.id === "cx/gpt-6-sol(ultra)");
    expect(solUltra).toBeDefined();
    expect(solUltra.virtual).toBe(true);
    expect(solUltra).toEqual({
      id: "cx/gpt-6-sol(ultra)",
      object: "model",
      owned_by: "cx",
      base_model: "cx/gpt-6-sol",
      reasoning_effort: "ultra",
      virtual: true,
    });

    const lunaMax = models.find((m) => m.id === "cx/gpt-6-luna(max)");
    expect(lunaMax).toBeDefined();
    expect(lunaMax.virtual).toBe(true);

    const lunaUltra = models.find((m) => m.id === "cx/gpt-6-luna(ultra)");
    expect(lunaUltra).toBeUndefined();

    // Review variants are no longer advertised
    expect(models.find((m) => m.id === "cx/gpt-6-sol-review")).toBeUndefined();
    expect(models.find((m) => m.id === "cx/gpt-6-luna-review")).toBeUndefined();

    const response = await getModelById(
      new Request("http://localhost/v1/models/cx/gpt-6-sol(ultra)"),
      { params: Promise.resolve({ model: ["cx", "gpt-6-sol(ultra)"] }) },
    );
    expect(await response.json()).toEqual(solUltra);
  });

  it("handles partial upstream catalog without max_output_tokens without fabricating limits for unknown models", () => {
    const rawCatalog = [
      {
        id: "gpt-6-sol",
        context_window: 272000,
        max_context_window: 872000,
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_reasoning_level: "medium",
      },
      {
        id: "gpt-future-model",
        context_window: 500000,
        supported_reasoning_levels: ["medium", "high"],
        default_reasoning_level: "medium",
      },
    ];

    const normalized = normalizeCodexCatalog(rawCatalog);
    const sol = normalized.find((m) => m.id === "gpt-6-sol");
    expect(sol.contextLength).toBe(272000);
    expect(sol.maxOutputTokens).toBeUndefined(); // raw upstream has no max_output_tokens
    expect(sol.capabilities.thinkingCanDisable).toBe(false);

    const future = normalized.find((m) => m.id === "gpt-future-model");
    expect(future.contextLength).toBe(500000);
    expect(future.maxOutputTokens).toBeUndefined(); // do NOT fabricate 128000
    expect(future.capabilities.maxOutput).toBeUndefined();
  });

  it("merges multi-account lists with min positive limits, unioned reasoning levels and revalidated defaults", () => {
    const account1 = [
      {
        id: "gpt-6-sol",
        contextLength: 272000,
        maxOutputTokens: 128000,
        supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningLevel: "medium",
      },
    ];
    const account2 = [
      {
        id: "gpt-6-sol",
        contextLength: 400000,
        maxOutputTokens: 64000,
        supportedReasoningLevels: ["medium", "high", "xhigh"],
        defaultReasoningLevel: "high",
      },
    ];

    const merged = mergeCodexModelLists([account1, account2]);
    expect(merged.length).toBe(1);
    const sol = merged[0];
    expect(sol.contextLength).toBe(272000); // min positive
    expect(sol.maxOutputTokens).toBe(64000); // min positive
    expect(sol.supportedReasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(sol.defaultReasoningLevel).toBe("medium"); // revalidated: original default remains supported by the union
    expect(sol.capabilities.contextWindow).toBe(272000);
    expect(sol.capabilities.maxOutput).toBe(64000);
    expect(sol.capabilities.thinkingCanDisable).toBe(false);
  });

  it("observes executor effort priority: suffix > request > default (medium/low)", () => {
    const executor = new CodexExecutor();

    // 1. Suffix variant overrides client request
    const body1 = {
      model: "gpt-6-sol(ultra)",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning_effort: "low",
    };
    executor.transformRequest("gpt-6-sol(ultra)", body1, true, { connectionId: "cx-test" });
    expect(body1.model).toBe("gpt-6-sol");
    expect(body1.reasoning.effort).toBe("ultra");

    // 2. Client request overrides catalog default
    const body2 = {
      model: "gpt-6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning_effort: "high",
    };
    executor.transformRequest("gpt-6-sol", body2, true, { connectionId: "cx-test" });
    expect(body2.reasoning.effort).toBe("high");

    // 3. Sol defaults to medium when neither is provided
    const body3 = {
      model: "gpt-6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    executor.transformRequest("gpt-6-sol", body3, true, { connectionId: "cx-test" });
    expect(body3.reasoning.effort).toBe("medium");

    // 4. Astra defaults to low
    const body4 = {
      model: "gpt-6-astra",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    executor.transformRequest("gpt-6-astra", body4, true, { connectionId: "cx-test" });
    expect(body4.reasoning.effort).toBe("low");

    // 5. Clamps ultra to max for Luna
    const body5 = {
      model: "gpt-6-luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning_effort: "ultra",
    };
    executor.transformRequest("gpt-6-luna", body5, true, { connectionId: "cx-test" });
    expect(body5.reasoning.effort).toBe("max");

    // 6. Strips wire tokens
    const body6 = {
      model: "gpt-6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_tokens: 1000,
      max_completion_tokens: 2000,
      max_output_tokens: 3000,
    };
    executor.transformRequest("gpt-6-sol", body6, true, { connectionId: "cx-test" });
    expect(body6.max_tokens).toBeUndefined();
    expect(body6.max_completion_tokens).toBeUndefined();
    expect(body6.max_output_tokens).toBeUndefined();
  });

  it("serves consistent metadata in /v1/models/info for base model and suffix variant", async () => {
    const baseRes = await getModelInfo(new Request("http://localhost/v1/models/info?id=cx/gpt-6-sol"));
    expect(baseRes.status).toBe(200);
    const baseData = await baseRes.json();
    expect(baseData.id).toBe("cx/gpt-6-sol");
    expect(baseData.contextWindow).toBe(272000);
    expect(baseData.maxOutput).toBe(128000);
    expect(baseData.defaultReasoningLevel).toBe("medium");
    expect(baseData.supportedReasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    const astraInfo = await getModelInfo(new Request("http://localhost/v1/models/info?id=cx/gpt-6-astra"));
    expect((await astraInfo.json()).description).toBeTruthy();
    expect(baseData.maxContextLength).toBe(872000);
    expect(baseData.minimalClientVersion).toBe("0.155.0");
    expect(baseData.description).toBeUndefined();

    const variantRes = await getModelInfo(new Request("http://localhost/v1/models/info?id=cx/gpt-6-sol(ultra)"));
    expect(variantRes.status).toBe(200);
    const variantData = await variantRes.json();
    expect(variantData.id).toBe("cx/gpt-6-sol(ultra)");
    expect(variantData.virtual).toBe(true);
    expect(variantData.base_model).toBe("cx/gpt-6-sol");
    expect(variantData.reasoning_effort).toBe("ultra");
    expect(variantData.contextWindow).toBe(272000);
    expect(variantData.maxOutput).toBe(128000);

    // Luna doesn't support ultra -> 404
    const invalidRes = await getModelInfo(new Request("http://localhost/v1/models/info?id=cx/gpt-6-luna(ultra)"));
    expect(invalidRes.status).toBe(404);
  });
});
