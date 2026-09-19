import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [
    { id: "alitp", provider: "alitp-intl", isActive: true },
    { id: "deepseek", provider: "deepseek", isActive: true },
  ]),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { normalizeAlibabaEffort } from "../../open-sse/providers/alibabaTokenPlanThinking.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { buildModelsList } from "../../src/app/api/v1/models/route.js";

describe("Alibaba Token Plan catalog & transports", () => {
  const entry = REGISTRY.find((e) => e.id === "alitp-intl");

  it("contains updated Token Plan models and exposeThinkingVariants flag", () => {
    expect(entry).toBeDefined();
    expect(entry.exposeThinkingVariants).toBe(true);

    const modelIds = (PROVIDER_MODELS["alitp-intl"] || []).map((m) => m.id);
    const expected = [
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-flash",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "deepseek-v4-flash-0731",
      "glm-5.2",
      "qwen3.8-max-preview",
    ];
    for (const id of expected) {
      expect(modelIds).toContain(id);
    }

    const previewModel = (entry.models || []).find((m) => m.id === "qwen3.8-max-preview");
    expect(previewModel).toBeDefined();
    expect(previewModel.deprecated).toBe(true);
    expect(previewModel.upstreamModelId).toBe("qwen3.8-max");
  });

  it("defines multi-transport endpoints: Chat, Responses, and Claude Messages", () => {
    expect(entry.transports).toBeDefined();
    const formats = entry.transports.map((t) => t.format);
    expect(formats).toContain("openai");
    expect(formats).toContain("openai-responses");
    expect(formats).toContain("claude");

    const chat = entry.transports.find((t) => t.format === "openai");
    const responses = entry.transports.find((t) => t.format === "openai-responses");
    const claude = entry.transports.find((t) => t.format === "claude");

    expect(chat.baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(responses.baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses",
    );
    expect(claude.baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
    );
  });

  it("selects Responses and Claude transports in the server runtime", () => {
    expect(resolveTransport("alitp-intl", "openai-responses")?.baseUrl).toContain("/responses");
    expect(resolveTransport("alitp-intl", "claude")?.baseUrl).toContain("/messages");
  });
});

describe("getThinkingLevels for alitp-intl models", () => {
  it("yields canonical levels for Qwen 3.8", () => {
    expect(getThinkingLevels("alitp-intl", "qwen3.8-max")).toEqual([
      "none",
      "low",
      "medium",
      "xhigh",
    ]);
    expect(getThinkingLevels("alitp-intl", "qwen3.8-flash")).toEqual([
      "none",
      "low",
      "medium",
      "xhigh",
    ]);
  });

  it("yields canonical levels for dated DeepSeek variants", () => {
    expect(getThinkingLevels("alitp-intl", "deepseek-v4-pro-0813")).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(getThinkingLevels("alitp-intl", "deepseek-v4-flash-0731")).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
  });

  it("yields canonical levels for GLM-5.2", () => {
    expect(getThinkingLevels("alitp-intl", "glm-5.2")).toEqual([
      "none",
      "high",
      "max",
    ]);
  });

  it("does not mutate non-alitp-intl providers", () => {
    const dsLevels = getThinkingLevels("deepseek", "deepseek-v4-pro");
    expect(dsLevels).toBeDefined();
    expect(dsLevels).not.toEqual(["none", "low", "medium", "xhigh"]);
  });
});

describe("normalizeAlibabaEffort", () => {
  it("normalizes Qwen 3.8 canonical levels and aliases", () => {
    expect(normalizeAlibabaEffort("qwen3.8-max", "minimal")).toBe("low");
    expect(normalizeAlibabaEffort("qwen3.8-max", "low")).toBe("low");
    expect(normalizeAlibabaEffort("qwen3.8-max", "medium")).toBe("medium");
    expect(normalizeAlibabaEffort("qwen3.8-max", "high")).toBe("xhigh");
    expect(normalizeAlibabaEffort("qwen3.8-max", "xhigh")).toBe("xhigh");
    expect(normalizeAlibabaEffort("qwen3.8-max", "max")).toBe("xhigh");
    expect(normalizeAlibabaEffort("qwen3.8-max", "none")).toBe("none");
    expect(normalizeAlibabaEffort("qwen3.8-max", "off")).toBe("none");
    expect(normalizeAlibabaEffort("qwen3.8-max", "ultra")).toBeNull();
  });

  it("protocol-differentiates DeepSeek 0813 and 0731 Chat vs Responses", () => {
    // Chat format (openai)
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "minimal", "openai")).toBe("low");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "low", "openai")).toBe("low");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "medium", "openai")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "high", "openai")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "xhigh", "openai")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "max", "openai")).toBe("max");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "none", "openai")).toBe("none");

    // Responses format (openai-responses)
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "minimal", "openai-responses")).toBe("low");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "low", "openai-responses")).toBe("low");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "medium", "openai-responses")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "high", "openai-responses")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "xhigh", "openai-responses")).toBe("max");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "max", "openai-responses")).toBe("max");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "none", "openai-responses")).toBe("none");
  });

  it("normalizes GLM-5.2 effort and rejects unsupported levels", () => {
    expect(normalizeAlibabaEffort("glm-5.2", "minimal")).toBe("high");
    expect(normalizeAlibabaEffort("glm-5.2", "low")).toBe("high");
    expect(normalizeAlibabaEffort("glm-5.2", "medium")).toBe("high");
    expect(normalizeAlibabaEffort("glm-5.2", "high")).toBe("high");
    expect(normalizeAlibabaEffort("glm-5.2", "xhigh")).toBe("max");
    expect(normalizeAlibabaEffort("glm-5.2", "max")).toBe("max");
    expect(normalizeAlibabaEffort("glm-5.2", "none")).toBe("none");
    expect(normalizeAlibabaEffort("glm-5.2", "bogus")).toBeNull();
  });
});

describe("applyThinking for alitp-intl across target formats", () => {
  const models = ["qwen3.8-max", "deepseek-v4-pro-0813", "glm-5.2"];
  const formats = ["openai", "openai-responses", "claude"];
  const levels = ["low", "medium", "high", "xhigh", "max", "none"];

  it("transforms all models, formats, and levels into valid protocol payloads", () => {
    for (const model of models) {
      for (const format of formats) {
        for (const level of levels) {
          const body = {
            model: `${model}(${level})`,
            enable_thinking: true,
            thinking_budget: 32768,
          };

          const out = applyThinking(format, `${model}(${level})`, body, "alitp-intl");

          // Model ID purity: no leaking (level) suffix
          expect(out.model).toBe(model);

          // Purge of legacy mutually exclusive params
          expect(out.enable_thinking).toBeUndefined();
          expect(out.thinking_budget).toBeUndefined();

          if (format === "openai") {
            expect(out.reasoning_effort).toBeDefined();
            expect(out.reasoning).toBeUndefined();
            expect(out.output_config).toBeUndefined();

            if (level === "none") {
              expect(out.reasoning_effort).toBe("none");
            } else if (model === "qwen3.8-max") {
              if (level === "low") expect(out.reasoning_effort).toBe("low");
              else if (level === "medium") expect(out.reasoning_effort).toBe("medium");
              else if (level === "high" || level === "xhigh" || level === "max") {
                expect(out.reasoning_effort).toBe("xhigh");
              }
            } else if (model === "deepseek-v4-pro-0813") {
              if (level === "low") expect(out.reasoning_effort).toBe("low");
              else if (level === "medium" || level === "high" || level === "xhigh") {
                expect(out.reasoning_effort).toBe("high");
              } else if (level === "max") {
                expect(out.reasoning_effort).toBe("max");
              }
            } else if (model === "glm-5.2") {
              if (level === "low" || level === "medium" || level === "high") {
                expect(out.reasoning_effort).toBe("high");
              } else if (level === "xhigh" || level === "max") {
                expect(out.reasoning_effort).toBe("max");
              }
            }
          } else if (format === "openai-responses") {
            expect(out.reasoning).toBeDefined();
            expect(out.reasoning.effort).toBeDefined();
            expect(out.reasoning_effort).toBeUndefined();
            expect(out.output_config).toBeUndefined();

            if (level === "none") {
              expect(out.reasoning.effort).toBe("none");
            } else if (model === "qwen3.8-max") {
              if (level === "low") expect(out.reasoning.effort).toBe("low");
              else if (level === "medium") expect(out.reasoning.effort).toBe("medium");
              else if (level === "high" || level === "xhigh" || level === "max") {
                expect(out.reasoning.effort).toBe("xhigh");
              }
            } else if (model === "deepseek-v4-pro-0813") {
              if (level === "low") expect(out.reasoning.effort).toBe("low");
              else if (level === "medium" || level === "high") {
                expect(out.reasoning.effort).toBe("high");
              } else if (level === "xhigh" || level === "max") {
                expect(out.reasoning.effort).toBe("max");
              }
            } else if (model === "glm-5.2") {
              if (level === "low" || level === "medium" || level === "high") {
                expect(out.reasoning.effort).toBe("high");
              } else if (level === "xhigh" || level === "max") {
                expect(out.reasoning.effort).toBe("max");
              }
            }
          } else if (format === "claude") {
            expect(out.reasoning_effort).toBeUndefined();
            expect(out.reasoning).toBeUndefined();

            if (level === "none") {
              expect(out.thinking).toEqual({ type: "disabled" });
              expect(out.output_config).toBeUndefined();
            } else {
              expect(out.thinking).toEqual({ type: "enabled" });
              expect(out.output_config).toBeDefined();
              expect(out.output_config.effort).toBeDefined();

              if (model === "qwen3.8-max") {
                if (level === "low") expect(out.output_config.effort).toBe("low");
                else if (level === "medium") expect(out.output_config.effort).toBe("medium");
                else if (level === "high" || level === "xhigh" || level === "max") {
                  expect(out.output_config.effort).toBe("xhigh");
                }
              } else if (model === "deepseek-v4-pro-0813") {
                if (level === "low") expect(out.output_config.effort).toBe("low");
                else if (level === "medium" || level === "high" || level === "xhigh") {
                  expect(out.output_config.effort).toBe("high");
                } else if (level === "max") {
                  expect(out.output_config.effort).toBe("max");
                }
              } else if (model === "glm-5.2") {
                if (level === "low" || level === "medium" || level === "high") {
                  expect(out.output_config.effort).toBe("high");
                } else if (level === "xhigh" || level === "max") {
                  expect(out.output_config.effort).toBe("max");
                }
              }
            }
          }
        }
      }
    }
  });

  it("rejects unsupported reasoning efforts by deleting fields", () => {
    const body = { reasoning_effort: "invalid_effort" };
    const out = applyThinking("openai", "qwen3.8-max", body, "alitp-intl");
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe("/v1/models virtual model expansion", () => {
  it("expands canonical virtual models for alitp-intl without duplicate aliases", async () => {
    const models = await buildModelsList(["llm"]);

    const alitpModels = models.filter((m) => m.id.startsWith("alitp-intl/"));
    expect(alitpModels.length).toBeGreaterThan(0);

    // Canonical virtual models exist
    const qwenNone = alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(none)");
    const qwenLow = alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(low)");
    const qwenMed = alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(medium)");
    const qwenXHigh = alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(xhigh)");

    expect(qwenNone).toBeDefined();
    expect(qwenNone.virtual).toBe(true);
    expect(qwenNone.base_model).toBe("alitp-intl/qwen3.8-max");
    expect(qwenNone.reasoning_effort).toBe("none");

    expect(qwenLow).toBeDefined();
    expect(qwenLow.virtual).toBe(true);
    expect(qwenLow.reasoning_effort).toBe("low");

    expect(qwenMed).toBeDefined();
    expect(qwenMed.virtual).toBe(true);
    expect(qwenMed.reasoning_effort).toBe("medium");

    expect(qwenXHigh).toBeDefined();
    expect(qwenXHigh.virtual).toBe(true);
    expect(qwenXHigh.reasoning_effort).toBe("xhigh");

    // Non-canonical aliases are NOT expanded
    expect(alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(high)")).toBeUndefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(max)")).toBeUndefined();

    // DeepSeek dated variants expanded with canonicals only
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(low)")).toBeDefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(high)")).toBeDefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(max)")).toBeDefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(medium)")).toBeUndefined();

    // Other providers without exposeThinkingVariants remain unexpanded
    const dsModels = models.filter((m) => m.id.startsWith("deepseek/"));
    expect(dsModels.some((m) => m.virtual === true)).toBe(false);
    const oaModels = models.filter((m) => m.id.startsWith("openai/"));
    expect(oaModels.some((m) => m.virtual === true)).toBe(false);
  });
});
