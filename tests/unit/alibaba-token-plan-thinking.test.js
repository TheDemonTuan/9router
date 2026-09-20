// Contract tests for Alibaba Token Plan thinking — derived independently from
// the Alibaba Model Studio docs (Chat reasoning_effort tables, Responses
// reasoning.effort tables, Anthropic Messages output_config.effort table), NOT
// from the production rule tables. Oracle legend:
//   "effort:low"                 → reasoning_effort / reasoning.effort / output_config.effort = low
//   "enable_thinking:false"      → chat disable wire
//   "disabled"                   → claude thinking:{type:"disabled"}
//   "budget"                     → budget-based wire (thinking_budget / budget_tokens)
//   "throw"                      → structured 400 (invalid_thinking_level)
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
import { getThinkingLevels, getAdvertisedThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { normalizeAlibabaEffort, applyAlibabaTokenPlanThinking } from "../../open-sse/providers/alibabaTokenPlanThinking.js";
import { applyThinking, parseSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { buildModelsList } from "../../src/app/api/v1/models/route.js";

const P = "alitp-intl";
const mkBody = (extra = {}) => ({
  model: "placeholder",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

// Doc-derived wire expectations per model × protocol × requested level.
const DOC_CONTRACTS = {
  "qwen3.8-max": {
    openai: {
      low: "effort:low", medium: "effort:medium", xhigh: "effort:xhigh",
      minimal: "effort:low", high: "effort:xhigh", max: "effort:xhigh",
      none: "enable_thinking:false", ultra: "throw",
    },
    "openai-responses": {
      none: "effort:none", low: "effort:low", medium: "effort:medium", xhigh: "effort:xhigh",
      minimal: "effort:low", high: "effort:xhigh", max: "effort:xhigh", ultra: "throw",
    },
    claude: {
      low: "effort:low", medium: "effort:medium", xhigh: "effort:xhigh",
      minimal: "effort:low", high: "effort:xhigh", max: "effort:xhigh",
      none: "disabled", ultra: "throw",
    },
  },
  "glm-5.2": {
    openai: {
      minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max",
      none: "enable_thinking:false",
    },
    "openai-responses": {
      none: "effort:none", minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max",
    },
    claude: {
      minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max", none: "disabled",
    },
  },
  "glm-5.3": {
    openai: { low: "effort:low", high: "effort:high", max: "effort:max", minimal: "effort:low", medium: "effort:high", xhigh: "effort:max", none: "throw" },
    "openai-responses": { low: "effort:low", high: "effort:high", max: "effort:max", minimal: "effort:low", medium: "effort:high", xhigh: "effort:max", none: "throw" },
    claude: { low: "effort:low", high: "effort:high", max: "effort:max", minimal: "effort:low", medium: "effort:high", xhigh: "effort:max", none: "throw" },
  },
  "deepseek-v4-pro": {
    openai: {
      minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max", none: "enable_thinking:false",
    },
    "openai-responses": {
      none: "effort:none", minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max",
    },
    claude: {
      minimal: "effort:high", low: "effort:high", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max", none: "disabled",
    },
  },
  "deepseek-v4-pro-0813": {
    openai: {
      minimal: "effort:low", low: "effort:low", medium: "effort:high", high: "effort:high",
      xhigh: "effort:high", max: "effort:max", none: "enable_thinking:false",
    },
    "openai-responses": {
      none: "effort:none", minimal: "effort:low", low: "effort:low", medium: "effort:high",
      high: "effort:high", xhigh: "effort:max", max: "effort:max",
    },
    // Dated DeepSeek is NOT covered by the Claude output_config.effort table → budget wire.
    claude: { low: "budget", high: "budget", max: "budget", none: "disabled" },
  },
  "deepseek-v4.1-flash": {
    openai: {
      minimal: "effort:low", low: "effort:low", medium: "effort:high", high: "effort:high",
      xhigh: "effort:high", max: "effort:max", ultra: "effort:max", none: "enable_thinking:false",
    },
    "openai-responses": {
      none: "effort:none", minimal: "effort:low", low: "effort:low", medium: "effort:high",
      high: "effort:high", xhigh: "effort:high", max: "effort:max",
      // ultra must be a structured 400 on Responses — NOT silently mapped to max.
      ultra: "throw",
    },
    claude: { low: "budget", high: "budget", max: "budget", none: "disabled" },
  },
};

function assertWire(format, out, expected) {
  if (expected === "effort:none" || expected.startsWith("effort:")) {
    const level = expected.slice("effort:".length);
    if (format === "openai") {
      expect(out.reasoning_effort).toBe(level);
      // Chat: reasoning_effort + thinking_budget together is an upstream error.
      expect(out.thinking_budget).toBeUndefined();
    } else if (format === "openai-responses") {
      expect(out.reasoning?.effort).toBe(level);
      expect(out.reasoning_effort).toBeUndefined();
      // Responses never receives thinking_budget.
      expect(out.thinking_budget).toBeUndefined();
      expect(out.enable_thinking).toBeUndefined();
    } else {
      expect(out.output_config?.effort).toBe(level);
      expect(out.thinking?.type).toBe("enabled");
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning).toBeUndefined();
    }
    return;
  }
  if (expected === "enable_thinking:false") {
    expect(out.enable_thinking).toBe(false);
    expect(out.reasoning_effort).toBeUndefined();
    return;
  }
  if (expected === "disabled") {
    expect(out.thinking).toMatchObject({ type: "disabled" });
    expect(out.output_config?.effort).toBeUndefined();
    return;
  }
  if (expected === "budget") {
    if (format === "claude") {
      expect(out.thinking?.type).toBe("enabled");
      expect(out.thinking?.budget_tokens).toBeGreaterThan(0);
      expect(out.output_config?.effort).toBeUndefined();
    } else {
      expect(out.enable_thinking).toBe(true);
      expect(out.thinking_budget).toBeGreaterThan(0);
    }
  }
}

describe("doc-derived wire contracts: model × protocol × level", () => {
  for (const [model, protocols] of Object.entries(DOC_CONTRACTS)) {
    for (const [format, cases] of Object.entries(protocols)) {
      for (const [level, expected] of Object.entries(cases)) {
        it(`${model} on ${format} with (${level})`, () => {
          const body = mkBody({ enable_thinking: true, thinking_budget: 1234 });
          if (expected === "throw") {
            expect(() => applyThinking(format, `${model}(${level})`, body, P)).toThrowError(
              expect.objectContaining({ code: "invalid_thinking_level" }),
            );
            return;
          }
          const out = applyThinking(format, `${model}(${level})`, body, P);
          // Legacy mutually-exclusive chat fields are purged on every wire.
          if (expected !== "enable_thinking:false") expect(out.enable_thinking === true && out.reasoning_effort ? "both" : "ok").toBe("ok");
          assertWire(format, out, expected);
        });
      }
    }
  }
});

describe("models without doc-verified effort tables", () => {
  it("qwen3.7/3.6 chat keeps native enable_thinking + thinking_budget", () => {
    for (const model of ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"]) {
      const out = applyThinking("openai", `${model}(high)`, mkBody(), P);
      expect(out.enable_thinking).toBe(true);
      expect(out.thinking_budget).toBeGreaterThan(0);
      expect(out.reasoning_effort).toBeUndefined();
      const off = applyThinking("openai", `${model}(none)`, mkBody(), P);
      expect(off.enable_thinking).toBe(false);
    }
  });

  it("qwen3.7/3.6 responses uses reasoning.effort, never thinking_budget", () => {
    const out = applyThinking("openai-responses", "qwen3.7-plus(xhigh)", mkBody({ thinking_budget: 5 }), P);
    expect(out.reasoning?.effort).toBe("xhigh");
    expect(out.thinking_budget).toBeUndefined();
    expect(out.enable_thinking).toBeUndefined();
  });

  it("deepseek-v3.2 is toggle-only: levels are a 400, none disables", () => {
    expect(() => applyThinking("openai", "deepseek-v3.2(high)", mkBody(), P)).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
    const off = applyThinking("openai", "deepseek-v3.2(none)", mkBody(), P);
    expect(off.enable_thinking).toBe(false);
  });

  it("kimi-k2.7-code is thinking-only: none is a 400 on chat and claude", () => {
    expect(() => applyThinking("openai", "kimi-k2.7-code(none)", mkBody(), P)).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
    expect(() => applyThinking("claude", "kimi-k2.7-code(none)", mkBody(), P)).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
    const on = applyThinking("openai", "kimi-k2.7-code(high)", mkBody(), P);
    expect(on.enable_thinking).toBe(true);
  });

  it("kimi-k2.6 can disable via enable_thinking:false", () => {
    const off = applyThinking("openai", "kimi-k2.6(none)", mkBody(), P);
    expect(off.enable_thinking).toBe(false);
  });

  it("MiniMax-M2.5 is thinking-only: none and levels are 400 on chat", () => {
    expect(() => applyThinking("openai", "MiniMax-M2.5(none)", mkBody(), P)).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
    expect(() => applyThinking("openai", "MiniMax-M2.5(high)", mkBody(), P)).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
  });
});

describe("mapper preservation invariants (fixer point 13)", () => {
  it("responses: reasoning.summary survives effort normalization", () => {
    const out = applyThinking("openai-responses", "qwen3.8-max(medium)", mkBody({
      reasoning: { effort: "high", summary: "auto" },
    }), P);
    expect(out.reasoning).toEqual({ summary: "auto", effort: "medium" });
  });

  it("claude: output_config.format survives effort and none", () => {
    const fmt = { type: "json_schema", json_schema: { name: "s", schema: {} } };
    const leveled = applyThinking("claude", "qwen3.8-max(xhigh)", mkBody({
      output_config: { format: fmt, effort: "low" },
    }), P);
    expect(leveled.output_config).toEqual({ format: fmt, effort: "xhigh" });
    const off = applyThinking("claude", "qwen3.8-max(none)", mkBody({
      output_config: { format: fmt, effort: "low" },
    }), P);
    expect(off.output_config).toEqual({ format: fmt });
    expect(off.thinking).toEqual({ type: "disabled" });
  });

  it("claude: thinking.display survives", () => {
    const out = applyThinking("claude", "qwen3.8-max(high)", mkBody({
      thinking: { type: "enabled", display: "summarized" },
    }), P);
    expect(out.thinking).toEqual({ type: "enabled", display: "summarized" });
  });

  it("keeps tools, tool_choice, response format, cache control untouched", () => {
    const body = mkBody({
      tools: [{ type: "function", function: { name: "t" } }],
      tool_choice: { type: "function", function: { name: "t" } },
      response_format: { type: "json_object" },
      previous_response_id: "resp_123",
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    });
    const out = applyThinking("openai-responses", "qwen3.8-max(xhigh)", body, P);
    expect(out.tools).toEqual(body.tools);
    expect(out.tool_choice).toEqual(body.tool_choice);
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.previous_response_id).toBe("resp_123");
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("never emits reasoning_effort + thinking_budget together on chat", () => {
    for (const model of Object.keys(DOC_CONTRACTS)) {
      const res = applyThinking("openai", `${model}(low)`, mkBody({ thinking_budget: 999, enable_thinking: true }), P);
      expect(res.reasoning_effort && res.thinking_budget ? "both" : "ok").toBe("ok");
    }
  });
});

describe("non-mutation (copy-on-write)", () => {
  const deepFreeze = (obj) => {
    for (const value of Object.values(obj || {})) {
      if (value && typeof value === "object") deepFreeze(value);
    }
    return Object.freeze(obj);
  };

  it("does not mutate the incoming body on any protocol", () => {
    for (const format of ["openai", "openai-responses", "claude"]) {
      const body = deepFreeze(mkBody({
        reasoning: { effort: "high", summary: "auto" },
        output_config: { format: { type: "text" } },
        thinking: { type: "enabled", display: "summarized" },
        enable_thinking: true,
        thinking_budget: 100,
      }));
      const snapshot = JSON.stringify(body);
      const out = applyThinking(format, "qwen3.8-max(medium)", body, P);
      expect(JSON.stringify(body)).toBe(snapshot);
      expect(out).not.toBe(body);
    }
  });

  it("deep-frozen bodies do not throw inside the mapper", () => {
    const body = deepFreeze(mkBody({ reasoning_effort: "high" }));
    expect(() => applyThinking("openai", "glm-5.2(max)", body, P)).not.toThrow();
  });
});

describe("auto and precedence", () => {
  it("auto removes explicit overrides on every protocol (no literal 'auto' sent)", () => {
    const chat = applyThinking("openai", "qwen3.8-max(auto)", mkBody({ reasoning_effort: "low", enable_thinking: true, thinking_budget: 5 }), P);
    expect(chat.reasoning_effort).toBeUndefined();
    expect(chat.enable_thinking).toBeUndefined();
    expect(chat.thinking_budget).toBeUndefined();
    const responses = applyThinking("openai-responses", "qwen3.8-max(auto)", mkBody({ reasoning: { effort: "low", summary: "auto" } }), P);
    expect(responses.reasoning).toEqual({ summary: "auto" });
    const claude = applyThinking("claude", "qwen3.8-max(auto)", mkBody({ output_config: { format: { type: "text" }, effort: "low" }, thinking: { type: "enabled" } }), P);
    expect(claude.output_config).toEqual({ format: { type: "text" } });
    expect(claude.thinking).toBeUndefined();
  });

  it("suffix override beats explicit client effort (precedence)", () => {
    const out = applyThinking("openai", "qwen3.8-max(low)", mkBody({ reasoning_effort: "xhigh" }), P);
    expect(out.reasoning_effort).toBe("low");
  });

  it("explicit client effort applies when no suffix", () => {
    const out = applyThinking("openai-responses", "qwen3.8-max", mkBody({ reasoning: { effort: "medium" } }), P);
    expect(out.reasoning?.effort).toBe("medium");
  });
});

describe("strict 400 validation (alitp-intl only)", () => {
  it("invalid suffix throws with the supported level list", () => {
    try {
      applyThinking("openai", "qwen3.8-max(bogus)", mkBody(), P);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e.code).toBe("invalid_thinking_level");
      expect(e.message).toContain("none, low, medium, xhigh");
    }
  });

  it("deepseek-v4.1-flash(ultra) is a 400 on Responses with a clear message", () => {
    try {
      applyThinking("openai-responses", "deepseek-v4.1-flash(ultra)", mkBody(), P);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e.code).toBe("invalid_thinking_level");
      expect(e.message).toContain("ultra");
    }
  });

  it("glm-5.3(none) is a 400 on all three protocols", () => {
    for (const format of ["openai", "openai-responses", "claude"]) {
      expect(() => applyThinking(format, "glm-5.3(none)", mkBody(), P)).toThrowError(
        expect.objectContaining({ code: "invalid_thinking_level" }),
      );
    }
  });

  it("client-body invalid effort is rejected, not silently stripped", () => {
    expect(() => applyThinking("openai", "qwen3.8-max", mkBody({ reasoning_effort: "invalid_effort" }), P))
      .toThrowError(expect.objectContaining({ code: "invalid_thinking_level" }));
  });

  it("other providers keep lenient suffix behavior", () => {
    const out = applyThinking("openai", "gpt-5.6-sol(bogus)", mkBody(), "codex");
    expect(out).toBeDefined();
  });

  it("parseSuffix distinguishes absent from invalid suffixes", () => {
    expect(parseSuffix("qwen3.8-max")).toEqual({ cleanModel: "qwen3.8-max", override: null });
    const invalid = parseSuffix("qwen3.8-max(bogus)");
    expect(invalid.cleanModel).toBe("qwen3.8-max");
    expect(invalid.override).toBeNull();
    expect(invalid.invalidSuffix).toBe("bogus");
    expect(parseSuffix("qwen3.8-max(high)").override).toEqual({ mode: "level", level: "high" });
  });
});

describe("normalizeAlibabaEffort is protocol-aware", () => {
  it("maps the same input differently per protocol (dated deepseek, v4.1-flash)", () => {
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "xhigh", "openai")).toBe("high");
    expect(normalizeAlibabaEffort("deepseek-v4-pro-0813", "xhigh", "openai-responses")).toBe("max");
    expect(normalizeAlibabaEffort("deepseek-v4.1-flash", "ultra", "openai")).toBe("max");
    expect(() => normalizeAlibabaEffort("deepseek-v4.1-flash", "ultra", "openai-responses")).toThrowError(
      expect.objectContaining({ code: "invalid_thinking_level" }),
    );
  });

  it("returns null for unknown models (generic path keeps working)", () => {
    expect(normalizeAlibabaEffort("brand-new-live-model", "high", "openai")).toBeNull();
  });
});

describe("deprecated preview alias routing", () => {
  it("qwen3.8-max-preview routes to qwen3.8-max and strips suffixes", () => {
    const out = applyThinking("openai", "qwen3.8-max-preview(xhigh)", mkBody({ model: "qwen3.8-max-preview(xhigh)" }), P);
    expect(out.model).toBe("qwen3.8-max");
    expect(out.reasoning_effort).toBe("xhigh");
  });
});

describe("levels and advertised variants", () => {
  it("getThinkingLevels serves canonical picker levels", () => {
    expect(getThinkingLevels(P, "qwen3.8-max")).toEqual(["none", "low", "medium", "xhigh"]);
    expect(getThinkingLevels(P, "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels(P, "deepseek-v4.1-flash")).toEqual(["none", "low", "high", "max"]);
    expect(getThinkingLevels(P, "qwen3.7-plus")).toBeNull();
  });

  it("getAdvertisedThinkingLevels: canonical only, no aliases, nothing for deprecated/unverified", () => {
    expect(getAdvertisedThinkingLevels(P, "qwen3.8-max")).toEqual(["none", "low", "medium", "xhigh"]);
    expect(getAdvertisedThinkingLevels(P, "qwen3.8-max-preview")).toBeNull();
    expect(getAdvertisedThinkingLevels(P, "qwen3.7-plus")).toBeNull();
    expect(getAdvertisedThinkingLevels(P, "kimi-k2.7-code")).toBeNull();
    // Aliases never leak into advertised levels.
    expect(getAdvertisedThinkingLevels(P, "glm-5.2")).not.toContain("xhigh");
  });

  it("non-alitp providers delegate unchanged", () => {
    expect(getAdvertisedThinkingLevels("codex", "gpt-5.6-sol")).toEqual(getThinkingLevels("codex", "gpt-5.6-sol"));
  });
});

describe("catalog & transports (registry shape)", () => {
  const entry = REGISTRY.find((e) => e.id === "alitp-intl");

  it("keeps multi-transport endpoints: Chat, Responses, Claude Messages", () => {
    const formats = entry.transports.map((t) => t.format);
    expect(formats).toEqual(expect.arrayContaining(["openai", "openai-responses", "claude"]));
    expect(entry.transports.find((t) => t.format === "openai").baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(resolveTransport("alitp-intl", "openai-responses")?.baseUrl).toContain("/responses");
    expect(resolveTransport("alitp-intl", "claude")?.baseUrl).toContain("/messages");
  });

  it("declares per-model supportedFormats guards", () => {
    const models = PROVIDER_MODELS["alitp-intl"] || [];
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["deepseek-v3.2"].supportedFormats).toEqual(["openai"]);
    expect(byId["kimi-k2.6"].supportedFormats).toEqual(["openai"]);
    expect(byId["kimi-k2.7-code"].supportedFormats).toEqual(["openai", "claude"]);
    expect(byId["qwen3.8-max"].supportedFormats).toEqual(["openai", "openai-responses", "claude"]);
  });

  it("keeps the deprecated preview alias routable in the registry", () => {
    const preview = (entry.models || []).find((m) => m.id === "qwen3.8-max-preview");
    expect(preview).toBeDefined();
    expect(preview.deprecated).toBe(true);
    expect(preview.upstreamModelId).toBe("qwen3.8-max");
  });
});

describe("/v1/models virtual model expansion", () => {
  it("expands canonical variants only and hides the deprecated preview", async () => {
    const models = await buildModelsList(["llm"]);
    const alitpModels = models.filter((m) => m.id.startsWith("alitp-intl/"));
    expect(alitpModels.length).toBeGreaterThan(0);

    for (const level of ["none", "low", "medium", "xhigh"]) {
      const variant = alitpModels.find((m) => m.id === `alitp-intl/qwen3.8-max(${level})`);
      expect(variant).toBeDefined();
      expect(variant.virtual).toBe(true);
      expect(variant.base_model).toBe("alitp-intl/qwen3.8-max");
      expect(variant.reasoning_effort).toBe(level);
    }
    // Wire aliases are accepted at request time but never advertised as models.
    expect(alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(high)")).toBeUndefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max(max)")).toBeUndefined();
    // Unverified families produce no virtual models.
    expect(alitpModels.find((m) => m.id.startsWith("alitp-intl/qwen3.7-plus("))).toBeUndefined();
    // Deprecated preview is not discoverable (base model still is).
    expect(alitpModels.find((m) => m.id.startsWith("alitp-intl/qwen3.8-max-preview"))).toBeUndefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/qwen3.8-max")).toBeDefined();
    // Dated deepseek: canonical none/low/high/max, no (medium)/(xhigh).
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(low)")).toBeDefined();
    expect(alitpModels.find((m) => m.id === "alitp-intl/deepseek-v4-pro-0813(medium)")).toBeUndefined();
  });
});

describe("applyAlibabaTokenPlanThinking direct mapper behavior", () => {
  it("returns a new body and never mutates for budget intents", () => {
    const body = mkBody({ thinking: { type: "enabled", budget_tokens: 8192 } });
    const snapshot = JSON.stringify(body);
    const out = applyAlibabaTokenPlanThinking("claude", "deepseek-v4-pro-0813", body, { mode: "budget", budget: 8192 });
    expect(out).not.toBe(body);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("passes unknown models through untouched", () => {
    const body = mkBody({ reasoning_effort: "high" });
    const out = applyAlibabaTokenPlanThinking("openai", "brand-new-live-model", body, { mode: "level", level: "low" });
    expect(out).toBe(body);
  });
});
