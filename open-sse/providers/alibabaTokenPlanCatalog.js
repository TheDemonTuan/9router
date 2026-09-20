// Alibaba Token Plan (alitp-intl) catalog — single source of truth for model
// membership (Personal/Team), transport support, limits, and per-protocol
// thinking contracts. Pure data: no Node-only imports (browser-bundled via
// capabilities.js). Values verified against official Alibaba Cloud Model Studio
// docs (see https://www.alibabacloud.com/help/en/model-studio/token-plan-overview
// and the per-protocol references in alibaba_fixer.md). Unknown cells are left
// unmapped (advertised: null) instead of copied from a neighboring family.

export const ALITP_PROVIDER_ID = "alitp-intl";
export const ALITP_CATALOG_VERSION = "2026-09-19";
export const ALITP_CATALOG_SOURCE = "alibaba-official";
export const ALITP_EDITIONS = ["personal", "team"];
// Legacy connections without an explicit edition keep Personal compatibility.
export const ALITP_DEFAULT_EDITION = "personal";

export const ALITP_DISCOVERY = {
  resolver: "alibaba-token-plan",
  ttlMs: 900000, // 15 minutes in-process cache
  fallbackCatalog: ALITP_DEFAULT_EDITION,
  // Live discovery probe path (OpenAI-compatible). 403/404/405 → negative cache,
  // the connection is NOT considered broken; fallback catalog is used instead.
  modelsPath: "/compatible-mode/v1/models",
};

// Default endpoint origin. Team Edition connections may override the base URL
// (validated https *.maas.aliyuncs.com); see applyAlitpBaseOrigin below.
export const ALITP_BASE_ORIGIN = "https://token-plan.ap-southeast-1.maas.aliyuncs.com";

const ALL_FORMATS = ["openai", "openai-responses", "claude"];
const CHAT_ONLY = ["openai"];
const CHAT_CLAUDE = ["openai", "claude"];

// Chat wire strategies:
//   effort   — reasoning_effort level; "none" via enable_thinking:false.
//              Sending reasoning_effort together with thinking_budget is an
//              upstream ERROR, so the mapper must never emit both.
//   qwen     — native enable_thinking + thinking_budget (Qwen 3.7/3.6).
//   kimi     — enable_thinking toggle + optional thinking_budget.
//   minimax  — MiniMax `thinking:{type:"enabled"}` param (adaptive only).
//   toggle   — enable_thinking on/off only; discrete levels are a 400.
// Responses wire strategies:
//   effort       — reasoning.effort (merged, keeps summary); never thinking_budget.
//   passthrough  — generic reasoning.effort levels, passed through as documented
//                  for models absent from the per-model Responses table.
// Claude wire strategies:
//   effort — thinking:{type:"enabled"} + output_config.effort (merged, keeps
//            output_config.format); "none" → thinking:{type:"disabled"} and
//            delete ONLY output_config.effort.
//   budget — thinking:{type:"enabled",budget_tokens} / {type:"disabled"} for
//            models not covered by the Claude output_config.effort table.

// Shared protocol contract builders (doc-verified tables only).
const qwen38Chat = {
  wire: "effort",
  accepted: ["low", "medium", "xhigh"],
  aliases: { minimal: "low", high: "xhigh", max: "xhigh" },
  default: "xhigh",
  // Doc budget↔effort mapping (Chat): low=4096, medium=16384, xhigh=262144.
  levelBudgets: { low: 4096, medium: 16384, xhigh: 262144 },
};
const qwen38Responses = {
  wire: "effort",
  accepted: ["none", "low", "medium", "xhigh"],
  aliases: { minimal: "low", high: "xhigh", max: "xhigh" },
  default: "xhigh",
};
const qwen38Claude = {
  wire: "effort",
  accepted: ["low", "medium", "xhigh"],
  aliases: { minimal: "low", high: "xhigh", max: "xhigh" },
  default: "xhigh",
};

const deepseekBaseChat = {
  wire: "effort",
  accepted: ["high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "high",
};
const deepseekBaseResponses = {
  wire: "effort",
  accepted: ["none", "high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "high",
};
const deepseekBaseClaude = {
  wire: "effort",
  accepted: ["high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "max",
};

const deepseekDatedChat = {
  wire: "effort",
  accepted: ["low", "high", "max"],
  aliases: { minimal: "low", medium: "high", xhigh: "high" },
  default: "high",
};
const deepseekDatedResponses = {
  wire: "effort",
  accepted: ["none", "low", "high", "max"],
  aliases: { minimal: "low", medium: "high", xhigh: "max" },
  default: "high",
};

const glm52Chat = {
  wire: "effort",
  accepted: ["high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "high",
};
const glm52Responses = {
  wire: "effort",
  accepted: ["none", "high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "high",
};
const glm52Claude = {
  wire: "effort",
  accepted: ["high", "max"],
  aliases: { minimal: "high", low: "high", medium: "high", xhigh: "max" },
  default: "max",
};

const glm53Protocol = {
  wire: "effort",
  accepted: ["low", "high", "max"],
  aliases: { minimal: "low", medium: "high", xhigh: "max" },
  default: "max",
};

// Qwen 3.7/3.6: Chat keeps native enable_thinking/thinking_budget; Responses
// uses reasoning.effort (never thinking_budget) but the models are absent from
// the per-model Responses table → generic passthrough, NOT advertised.
const qwenLegacyChat = { wire: "qwen" };
const qwenLegacyResponses = {
  wire: "passthrough",
  accepted: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};
const claudeBudget = { wire: "budget" };

export const ALITP_MODELS = [
  {
    id: "qwen3.8-max", name: "Qwen3.8 Max",
    contextWindow: 1000000, maxOutput: 65536, vision: true, videoInput: true,
    formats: ALL_FORMATS, levels: ["none", "low", "medium", "xhigh"],
    advertised: ["none", "low", "medium", "xhigh"],
    protocols: { openai: qwen38Chat, "openai-responses": qwen38Responses, claude: qwen38Claude },
  },
  {
    id: "qwen3.8-flash", name: "Qwen3.8 Flash",
    contextWindow: 1000000, maxOutput: 65536, vision: true, videoInput: true,
    formats: ALL_FORMATS, levels: ["none", "low", "medium", "xhigh"],
    advertised: ["none", "low", "medium", "xhigh"],
    protocols: { openai: qwen38Chat, "openai-responses": qwen38Responses, claude: qwen38Claude },
  },
  {
    // Deprecated compatibility alias: routable (maps to qwen3.8-max upstream)
    // but hidden from /v1/models, dashboard pickers, and variant generation.
    id: "qwen3.8-max-preview", name: "Qwen3.8 Max Preview", upstreamId: "qwen3.8-max", deprecated: true,
  },
  {
    id: "qwen3.7-max", name: "Qwen3.7 Max",
    contextWindow: 1000000, maxOutput: 65536, vision: false,
    formats: ALL_FORMATS, levels: null, advertised: null,
    protocols: { openai: qwenLegacyChat, "openai-responses": qwenLegacyResponses, claude: claudeBudget },
  },
  {
    id: "qwen3.7-plus", name: "Qwen3.7 Plus",
    contextWindow: 1000000, maxOutput: 65536, vision: true, videoInput: true,
    formats: ALL_FORMATS, levels: null, advertised: null,
    protocols: { openai: qwenLegacyChat, "openai-responses": qwenLegacyResponses, claude: claudeBudget },
  },
  {
    id: "qwen3.6-plus", name: "Qwen3.6 Plus", teamOnly: true,
    contextWindow: 1000000, maxOutput: 65536, vision: true, videoInput: true,
    formats: ALL_FORMATS, levels: null, advertised: null,
    protocols: { openai: qwenLegacyChat, "openai-responses": qwenLegacyResponses, claude: claudeBudget },
  },
  {
    id: "qwen3.6-flash", name: "Qwen3.6 Flash",
    contextWindow: 1000000, maxOutput: 65536, vision: true, videoInput: true,
    formats: ALL_FORMATS, levels: null, advertised: null,
    protocols: { openai: qwenLegacyChat, "openai-responses": qwenLegacyResponses, claude: claudeBudget },
  },
  {
    id: "deepseek-v4-pro", name: "DeepSeek V4 Pro",
    contextWindow: 1000000, maxOutput: 65536, vision: false,
    formats: ALL_FORMATS, levels: ["none", "high", "max"],
    advertised: ["none", "high", "max"],
    protocols: { openai: deepseekBaseChat, "openai-responses": deepseekBaseResponses, claude: deepseekBaseClaude },
  },
  {
    id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", teamOnly: true,
    contextWindow: 1000000, maxOutput: 65536, vision: false,
    formats: ALL_FORMATS, levels: ["none", "high", "max"],
    advertised: ["none", "high", "max"],
    protocols: { openai: deepseekBaseChat, "openai-responses": deepseekBaseResponses, claude: deepseekBaseClaude },
  },
  {
    id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro (0813)",
    contextWindow: 1000000, maxOutput: 65536, vision: false,
    formats: ALL_FORMATS, levels: ["none", "low", "high", "max"],
    advertised: ["none", "low", "high", "max"],
    // Not covered by the Claude output_config.effort table → budget wire.
    protocols: { openai: deepseekDatedChat, "openai-responses": deepseekDatedResponses, claude: claudeBudget },
  },
  {
    id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash (0731)",
    contextWindow: 1000000, maxOutput: 65536, vision: false,
    formats: ALL_FORMATS, levels: ["none", "low", "high", "max"],
    advertised: ["none", "low", "high", "max"],
    protocols: { openai: deepseekDatedChat, "openai-responses": deepseekDatedResponses, claude: claudeBudget },
  },
  {
    // Multimodal text/image, 1M context, 393216 max output (model info page).
    // Chat accepts ultra→max; Responses REJECTS ultra (400) — encoded by the
    // absence of an ultra alias in the responses contract.
    id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
    contextWindow: 1000000, maxOutput: 393216, vision: true,
    formats: ALL_FORMATS, levels: ["none", "low", "high", "max"],
    advertised: ["none", "low", "high", "max"],
    protocols: {
      openai: {
        wire: "effort",
        accepted: ["low", "high", "max"],
        aliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
        default: "high",
      },
      "openai-responses": {
        wire: "effort",
        accepted: ["none", "low", "high", "max"],
        aliases: { minimal: "low", medium: "high", xhigh: "high" },
        default: "high",
      },
      claude: claudeBudget,
    },
  },
  {
    id: "deepseek-v3.2", name: "DeepSeek V3.2", teamOnly: true,
    contextWindow: 131072, maxOutput: 65536, vision: false,
    formats: CHAT_ONLY, levels: null, advertised: null,
    protocols: { openai: { wire: "toggle" } },
  },
  {
    // GLM-5.3: thinking-only (enable_thinking:false / none is an upstream
    // error). 1M context, 128K output per the model info page.
    id: "glm-5.3", name: "GLM 5.3", canDisable: false,
    contextWindow: 1000000, maxOutput: 131072, vision: false,
    formats: ALL_FORMATS, levels: ["low", "high", "max"],
    advertised: ["low", "high", "max"],
    protocols: { openai: glm53Protocol, "openai-responses": glm53Protocol, claude: glm53Protocol },
  },
  {
    id: "glm-5.2", name: "GLM 5.2",
    contextWindow: 200000, maxOutput: 128000, vision: false,
    formats: ALL_FORMATS, levels: ["none", "high", "max"],
    advertised: ["none", "high", "max"],
    protocols: { openai: glm52Chat, "openai-responses": glm52Responses, claude: glm52Claude },
  },
  {
    id: "glm-5.1", name: "GLM 5.1", teamOnly: true,
    contextWindow: 200000, maxOutput: 128000, vision: false,
    formats: CHAT_CLAUDE, levels: ["none", "high", "max"], advertised: null,
    protocols: { openai: glm52Chat, claude: claudeBudget },
  },
  {
    id: "glm-5", name: "GLM 5", teamOnly: true,
    contextWindow: 200000, maxOutput: 128000, vision: false,
    formats: CHAT_CLAUDE, levels: ["none", "high", "max"], advertised: null,
    protocols: { openai: glm52Chat, claude: claudeBudget },
  },
  {
    // Kimi K2.7 Code: deep-thinking (thinking-only) model; cannot disable.
    id: "kimi-k2.7-code", name: "Kimi K2.7 Code", teamOnly: true, canDisable: false,
    contextWindow: 262144, maxOutput: 65536, vision: true,
    formats: CHAT_CLAUDE, levels: null, advertised: null,
    protocols: { openai: { wire: "kimi" }, claude: claudeBudget },
  },
  {
    id: "kimi-k2.6", name: "Kimi K2.6", teamOnly: true,
    contextWindow: 262144, maxOutput: 65536, vision: true,
    formats: CHAT_ONLY, levels: null, advertised: null,
    protocols: { openai: { wire: "kimi" } },
  },
  {
    id: "kimi-k2.5", name: "Kimi K2.5", teamOnly: true,
    contextWindow: 262144, maxOutput: 65536, vision: true,
    formats: CHAT_CLAUDE, levels: null, advertised: null,
    protocols: { openai: { wire: "kimi" }, claude: claudeBudget },
  },
  {
    // MiniMax-M2.5: thinking-only (adaptive); `thinking` param on Chat,
    // budget wire on Claude. 192K context per the Token Plan model page.
    id: "MiniMax-M2.5", name: "MiniMax M2.5", teamOnly: true, canDisable: false,
    contextWindow: 192000, maxOutput: 131072, vision: false,
    formats: CHAT_CLAUDE, levels: null, advertised: null,
    protocols: { openai: { wire: "minimax" }, claude: claudeBudget },
  },
];

const BY_ID = new Map(ALITP_MODELS.map((m) => [m.id, m]));

// Models available to an edition (fallback catalog). Deprecated aliases are
// routable but never part of discovery results.
export function getAlitpFallbackCatalog(edition) {
  const ed = ALITP_EDITIONS.includes(edition) ? edition : ALITP_DEFAULT_EDITION;
  return ALITP_MODELS.filter(
    (m) => !m.deprecated && (ed === "team" || !m.teamOnly)
  );
}

// Exact catalog lookup (no pattern matching). Returns undefined for unknown ids.
export function getAlitpCatalogEntry(modelId) {
  if (typeof modelId !== "string" || !modelId) return undefined;
  return BY_ID.get(modelId);
}

// Resolve deprecated alias → canonical entry (qwen3.8-max-preview → qwen3.8-max).
export function resolveAlitpCatalogEntry(modelId) {
  const entry = getAlitpCatalogEntry(modelId);
  if (!entry) return undefined;
  if (entry.upstreamId) return BY_ID.get(entry.upstreamId) || entry;
  return entry;
}

// Upstream model id for a catalog id (alias → real upstream name).
export function getAlitpUpstreamModelId(modelId) {
  const entry = getAlitpCatalogEntry(modelId);
  return entry?.upstreamId || modelId;
}

export function isAlitpModelDeprecated(modelId) {
  return getAlitpCatalogEntry(modelId)?.deprecated === true;
}

// Team-only models require a Team Edition connection. Models unknown to the
// curated catalog (e.g. live-discovered additions) are not gated — live
// discovery already proved the account can see them.
export function isAlitpModelAvailableForEdition(modelId, edition) {
  if (typeof modelId !== "string" || !modelId) return true;
  const bare = modelId.replace(/\([^()]+\)\s*$/, "").trim().split("/").pop();
  const entry = resolveAlitpCatalogEntry(bare);
  if (!entry) return true;
  const ed = ALITP_EDITIONS.includes(edition) ? edition : ALITP_DEFAULT_EDITION;
  return ed === "team" || !entry.teamOnly;
}

// Validate a Team-Edition console Base URL override. Only https origins under
// *.maas.aliyuncs.com are accepted; anything else is ignored (fallback to the
// default Singapore origin) so a bad value can never redirect credentials.
export function sanitizeAlitpBaseOrigin(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/(^|\.)maas\.aliyuncs\.com$/i.test(url.hostname)) return null;
  return url.origin;
}

// Swap a transport URL's origin (keeps path) for a Team-Edition base origin.
export function applyAlitpBaseOrigin(transportUrl, baseOrigin) {
  const origin = sanitizeAlitpBaseOrigin(baseOrigin);
  if (!origin || typeof transportUrl !== "string") return transportUrl;
  try {
    const url = new URL(transportUrl);
    return origin + url.pathname + url.search;
  } catch {
    return transportUrl;
  }
}
