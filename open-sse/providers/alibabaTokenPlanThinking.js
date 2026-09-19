// Alibaba Token Plan thinking levels, model-specific mappings, and protocol normalization.
import { matchPattern } from "./pricing.js";
import { budgetToLevel } from "../translator/concerns/thinking.js";

const cleanModelName = (model) => {
  if (typeof model !== "string") return model;
  const stripped = model.replace(/\([^()]+\)\s*$/, "").trim();
  return stripped.includes("/") ? stripped.split("/").pop() : stripped;
};

export const ALITP_THINKING_RULES = [
  {
    pattern: "qwen3.8-max*",
    levels: ["none", "low", "medium", "xhigh"],
    defaultLevel: "xhigh",
    aliases: {
      minimal: "low",
      high: "xhigh",
      max: "xhigh",
    },
  },
  {
    pattern: "qwen3.8-flash*",
    levels: ["none", "low", "medium", "xhigh"],
    defaultLevel: "xhigh",
    aliases: {
      minimal: "low",
      high: "xhigh",
      max: "xhigh",
    },
  },
  {
    pattern: "deepseek-v4-pro-0813*",
    levels: ["none", "low", "high", "max"],
    chatAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
    },
    responsesAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "max",
    },
    aliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
    },
  },
  {
    pattern: "deepseek-v4-flash-0731*",
    levels: ["none", "low", "high", "max"],
    chatAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
    },
    responsesAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "max",
    },
    aliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
    },
  },
  {
    pattern: "deepseek-v4.1-flash*",
    levels: ["none", "low", "high", "max"],
    chatAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
      ultra: "max",
    },
    responsesAliases: {
      minimal: "low",
      medium: "high",
      xhigh: "max",
      ultra: "max",
    },
    aliases: {
      minimal: "low",
      medium: "high",
      xhigh: "high",
      ultra: "max",
    },
  },
  {
    pattern: "deepseek-v4-pro*",
    levels: ["none", "high", "max"],
    aliases: {
      minimal: "high",
      low: "high",
      medium: "high",
      xhigh: "max",
    },
  },
  {
    pattern: "glm-5.2*",
    levels: ["none", "high", "max"],
    aliases: {
      minimal: "high",
      low: "high",
      medium: "high",
      xhigh: "max",
    },
  },
];

export function getAlibabaTokenPlanThinkingRule(model) {
  if (!model) return null;
  const clean = cleanModelName(model);
  return ALITP_THINKING_RULES.find((r) => matchPattern(r.pattern, clean)) || null;
}

export function budgetToAlibabaEffort(model, budget) {
  if (budget === 0) return "none";
  if (!Number.isFinite(budget)) return null;
  const clean = cleanModelName(model);
  if (/qwen3\.8/i.test(clean)) {
    if (budget <= 4096) return "low";
    if (budget <= 16384) return "medium";
    return "xhigh";
  }
  return budgetToLevel(budget);
}

export function normalizeAlibabaEffort(model, requestedEffort, targetFormat = "openai") {
  if (!requestedEffort) return null;
  const raw = String(requestedEffort).toLowerCase().trim();
  if (raw === "off" || raw === "none") return "none";

  const rule = getAlibabaTokenPlanThinkingRule(model);
  if (!rule) return null;

  // Protocol-differentiated alias mappings (e.g. DeepSeek 0813/0731 Chat vs Responses)
  if (targetFormat === "openai-responses" && rule.responsesAliases?.[raw]) {
    return rule.responsesAliases[raw];
  }
  if (targetFormat !== "openai-responses" && rule.chatAliases?.[raw]) {
    return rule.chatAliases[raw];
  }
  if (rule.aliases?.[raw]) {
    return rule.aliases[raw];
  }

  // Canonical level check
  if (rule.levels.includes(raw)) {
    return raw;
  }

  // Unsupported reasoning effort -> reject
  return null;
}

export function applyAlibabaTokenPlanThinking(targetFormat, model, body, cfg, display = undefined) {
  if (!body || typeof body !== "object") return body;

  const clean = cleanModelName(model);
  if (typeof body.model === "string") {
    body.model = body.model.replace(/\([^()]+\)\s*$/, "").trim();
  }

  // Purge mutually exclusive legacy thinking fields
  delete body.thinking_budget;
  delete body.enable_thinking;
  delete body.thinkingConfig;

  let requestedEffort = null;
  if (cfg) {
    if (cfg.mode === "none") {
      requestedEffort = "none";
    } else if (cfg.mode === "level") {
      requestedEffort = cfg.level;
    } else if (cfg.mode === "budget") {
      requestedEffort = budgetToAlibabaEffort(clean, cfg.budget);
    } else if (cfg.mode === "auto") {
      // Base model default: do not force an override
      return body;
    }
  }

  if (!requestedEffort) return body;

  const normalized = normalizeAlibabaEffort(clean, requestedEffort, targetFormat);
  if (!normalized) {
    // Unsupported reasoning effort -> reject and strip fields
    delete body.reasoning_effort;
    delete body.reasoning;
    delete body.output_config;
    delete body.thinking;
    return body;
  }

  if (targetFormat === "openai") {
    delete body.reasoning;
    delete body.output_config;
    delete body.thinking;
    body.reasoning_effort = normalized;
  } else if (targetFormat === "openai-responses") {
    delete body.reasoning_effort;
    delete body.output_config;
    delete body.thinking;
    body.reasoning = { effort: normalized };
  } else if (targetFormat === "claude") {
    delete body.reasoning_effort;
    delete body.reasoning;
    if (normalized === "none") {
      body.thinking = { type: "disabled" };
      delete body.output_config;
    } else {
      body.thinking = { type: "enabled", ...(display ? { display } : {}) };
      body.output_config = { effort: normalized };
    }
  } else {
    body.reasoning_effort = normalized;
  }

  return body;
}
