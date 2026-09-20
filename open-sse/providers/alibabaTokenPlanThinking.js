// Alibaba Token Plan thinking: per-model × per-protocol contracts (data lives in
// alibabaTokenPlanCatalog.js) + the non-destructive wire mapper.
//
// Mapper rules (fixer contract):
// - Copy-on-write: never mutates the incoming body; returns a new object so
//   retries/combo fallbacks still see the original request.
// - Owns ONLY thinking controls (reasoning_effort, enable_thinking,
//   thinking_budget, thinking, reasoning.effort, output_config.effort).
//   Preserves reasoning.summary, output_config.format, thinking.display, tools,
//   structured outputs, cache controls, continuation ids, everything else.
// - Invalid level/suffix → structured 400 (error.code = "invalid_thinking_level")
//   listing supported levels. No silent fallback.
// - auto → remove explicit thinking overrides, let Alibaba apply its default.
import { budgetToLevel, effortToBudget, LEVEL_TO_BUDGET } from "../translator/concerns/thinking.js";
import {
  resolveAlitpCatalogEntry,
  getAlitpUpstreamModelId,
} from "./alibabaTokenPlanCatalog.js";

const cleanModelName = (model) => {
  if (typeof model !== "string") return model;
  const stripped = model.replace(/\([^()]+\)\s*$/, "").trim();
  return stripped.includes("/") ? stripped.split("/").pop() : stripped;
};

// Protocol key per target wire format (catalog protocols are keyed the same).
const protocolKey = (targetFormat) =>
  targetFormat === "openai-responses" || targetFormat === "claude" ? targetFormat : "openai";

function invalidLevelError(model, protocol, raw, supported) {
  const error = new Error(
    `Invalid thinking level "${raw}" for alitp-intl/${model} on ${protocol}. ` +
    `Supported levels: ${supported.length ? supported.join(", ") : "none (model does not support discrete thinking levels)"}.`
  );
  error.code = "invalid_thinking_level";
  return error;
}

// Catalog entry for a model (deprecated aliases resolve to their base model).
// Null when the model is unknown to the curated catalog (e.g. live-discovered)
// — callers then keep the generic thinking path instead of hard-failing.
export function getAlibabaTokenPlanThinkingRule(model) {
  if (!model) return null;
  return resolveAlitpCatalogEntry(cleanModelName(model)) || null;
}

// Budget → canonical effort for a model using its documented Chat budgets when
// available (qwen3.8: low=4096, medium=16384, xhigh=262144), else the generic
// budget→level thresholds. 0 → "none".
export function budgetToAlibabaEffort(model, budget, targetFormat = "openai") {
  if (budget === 0) return "none";
  if (!Number.isFinite(budget)) return null;
  const rule = getAlibabaTokenPlanThinkingRule(model);
  const contract = rule?.protocols?.[protocolKey(targetFormat)];
  const levelBudgets = contract?.levelBudgets;
  if (levelBudgets) {
    const entries = Object.entries(levelBudgets).sort((a, b) => a[1] - b[1]);
    for (const [level, max] of entries) {
      if (budget <= max) return level;
    }
    return entries[entries.length - 1][0];
  }
  return budgetToLevel(budget);
}

// Normalize a requested effort to the canonical level for model+protocol.
// Returns null when the model has no catalog contract; THROWS
// invalid_thinking_level when the level is not accepted (no silent fallback).
export function normalizeAlibabaEffort(model, requestedEffort, targetFormat = "openai") {
  if (!requestedEffort) return null;
  const raw = String(requestedEffort).toLowerCase().trim();
  if (raw === "off" || raw === "none") return "none";

  const rule = getAlibabaTokenPlanThinkingRule(model);
  if (!rule) return null;
  const contract = rule.protocols?.[protocolKey(targetFormat)];
  if (!contract) return null;
  const { accepted, aliases } = contract;

  if (!accepted) {
    // Toggle/minimax wires have no discrete levels — anything beyond none/auto
    // is invalid rather than silently ignored.
    if (contract.wire === "toggle" || contract.wire === "minimax") {
      if (raw === "thinking" && contract.wire === "toggle") return "thinking";
      throw invalidLevelError(rule.id, targetFormat, raw, rule.levels || []);
    }
    // Budget-based wires (qwen native / kimi / claude budget) accept the generic
    // level names and map them through effortToBudget at apply time.
    if (LEVEL_TO_BUDGET[raw] !== undefined && raw !== "none") return raw;
    throw invalidLevelError(rule.id, targetFormat, raw, rule.levels || []);
  }
  if (aliases?.[raw]) return aliases[raw];
  if (accepted.includes(raw)) return raw;
  throw invalidLevelError(rule.id, targetFormat, raw, rule.levels || accepted);
}

// --- wire appliers (each receives the shallow copy and mutates ONLY that) ---

function omitEffortFromReasoning(next) {
  if (next.reasoning && typeof next.reasoning === "object") {
    const { effort, ...rest } = next.reasoning;
    if (Object.keys(rest).length > 0) next.reasoning = rest;
    else delete next.reasoning;
  }
}

function omitEffortFromOutputConfig(next) {
  if (next.output_config && typeof next.output_config === "object") {
    const { effort, ...rest } = next.output_config;
    // Keep output_config even when only format remains; never delete the object.
    next.output_config = rest;
  }
}

// Remove every thinking override this mapper owns, keeping unrelated fields
// (reasoning.summary, output_config.format) intact.
export function clearAlibabaThinkingControls(next, targetFormat) {
  delete next.enable_thinking;
  delete next.thinking_budget;
  delete next.thinkingConfig;
  delete next.reasoning_effort;
  // Preserve sibling data across cross-protocol fallbacks. `summary` and
  // `output_config.format` are client data, not mapper-owned controls.
  omitEffortFromReasoning(next);
  omitEffortFromOutputConfig(next);
  const key = protocolKey(targetFormat);
  // `thinking` itself is a target-specific control object; its display value is
  // captured before clearing and re-applied for enabled Claude thinking.
  if (key === "openai" || key === "openai-responses" || key === "claude") delete next.thinking;
  if (next.output_config && Object.keys(next.output_config).length === 0) delete next.output_config;
}

function applyChat(next, contract, canonical, display) {
  if (canonical === "none") {
    // Documented disable path on Chat is enable_thinking:false.
    next.enable_thinking = false;
    delete next.reasoning_effort;
    return;
  }
  switch (contract.wire) {
    case "effort":
      // reasoning_effort together with thinking_budget is an upstream error.
      next.reasoning_effort = canonical;
      delete next.enable_thinking;
      delete next.thinking_budget;
      break;
    case "qwen":
    case "kimi":
      next.enable_thinking = true;
      delete next.reasoning_effort;
      if (canonical !== "thinking") {
        const budget = contract.levelBudgets?.[canonical] ?? effortToBudget(canonical);
        if (Number.isFinite(budget) && budget > 0) next.thinking_budget = budget;
      }
      break;
    case "toggle":
      next.enable_thinking = true;
      break;
    case "minimax":
      next.thinking = { type: "enabled" };
      break;
    default:
      break;
  }
}

function applyResponses(next, canonical) {
  if (canonical === "none") {
    // Responses disables via reasoning.effort:"none" (merged, keeps summary).
    next.reasoning = { ...(next.reasoning || {}), effort: "none" };
    return;
  }
  // Responses never accepts thinking_budget.
  delete next.thinking_budget;
  delete next.enable_thinking;
  next.reasoning = { ...(next.reasoning || {}), effort: canonical };
}

// Public mapper. Returns a NEW body; throws invalid_thinking_level (400) on
// unsupported levels instead of silently stripping them.
export function applyAlibabaTokenPlanThinking(targetFormat, model, body, cfg, display = undefined) {
  if (!body || typeof body !== "object") return body;

  const clean = cleanModelName(model);
  const rule = getAlibabaTokenPlanThinkingRule(clean);
  if (!rule) return body;
  const key = protocolKey(targetFormat);
  const contract = rule.protocols?.[key];
  if (!contract) return body;

  const next = { ...body };
  if (typeof next.model === "string") {
    const bare = next.model.replace(/\([^()]+\)\s*$/, "").trim();
    if (bare !== next.model) next.model = bare;
  }
  // Deprecated/alias ids route to the real upstream model.
  const upstream = getAlitpUpstreamModelId(clean);
  if (typeof next.model === "string" && cleanModelName(next.model) === clean && upstream !== clean) {
    next.model = next.model.replace(clean, upstream);
  }

  const canDisable = rule.canDisable !== false;

  // auto (or no explicit intent) → drop overrides, keep Alibaba's default.
  if (!cfg || cfg.mode === "auto") {
    clearAlibabaThinkingControls(next, targetFormat);
    return next;
  }

  let canonical;
  if (cfg.mode === "none") {
    canonical = "none";
  } else if (cfg.mode === "level") {
    canonical = normalizeAlibabaEffort(clean, cfg.level, targetFormat);
  } else if (cfg.mode === "budget") {
    canonical = budgetToAlibabaEffort(clean, cfg.budget, targetFormat);
    if (canonical && canonical !== "none" && (contract.wire === "effort" || contract.wire === "passthrough")) {
      // Effort wires must land on an accepted canonical level.
      canonical = normalizeAlibabaEffort(clean, canonical, targetFormat);
    }
  }
  if (!canonical) return next;

  if (canonical === "none" && !canDisable) {
    throw invalidLevelError(rule.id, targetFormat, "none", rule.levels || []);
  }
  // Toggle/minimax chat wires: discrete levels are invalid (400), not ignored.
  if (canonical !== "none" && canonical !== "thinking" && (contract.wire === "toggle" || contract.wire === "minimax")) {
    throw invalidLevelError(rule.id, targetFormat, canonical, rule.levels || []);
  }
  // Budget mode on a wire that only takes budgets.
  if (cfg.mode === "budget" && (contract.wire === "qwen" || contract.wire === "kimi" || (key === "claude" && contract.wire === "budget"))) {
    clearAlibabaThinkingControls(next, targetFormat);
    if (key === "claude") {
      next.thinking = { type: "enabled", budget_tokens: cfg.budget, ...(display ? { display } : {}) };
    } else {
      next.enable_thinking = true;
      next.thinking_budget = cfg.budget;
    }
    return next;
  }

  clearAlibabaThinkingControls(next, targetFormat);

  if (key === "openai") {
    applyChat(next, contract, canonical, display);
  } else if (key === "openai-responses") {
    applyResponses(next, canonical);
  } else {
    if (canonical === "none") {
      next.thinking = { type: "disabled" };
      omitEffortFromOutputConfig(next);
    } else if (contract.wire === "effort") {
      next.thinking = { type: "enabled", ...(display ? { display } : {}) };
      // Merge into output_config so a client-provided format survives.
      next.output_config = { ...(next.output_config || {}), effort: canonical };
    } else {
      const budget = effortToBudget(canonical) || 8192;
      next.thinking = { type: "enabled", budget_tokens: budget, ...(display ? { display } : {}) };
    }
  }
  return next;
}
