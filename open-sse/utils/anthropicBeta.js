import { ANTHROPIC_BETA_HEAVY_AGENT, ANTHROPIC_BETA_REDACT_THINKING, wantsThinkingSummaries } from "../providers/shared.js";

export function normalizeAnthropicBeta(value) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return null;
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.some((token) => !/^[A-Za-z0-9._-]+$/.test(token))) return null;
  return [...new Set(tokens)].join(",");
}

export function mergeAnthropicBetaHeaders(headers, incoming, { model, body, stripClaudeCode = false } = {}) {
  const defaults = Object.entries(headers).filter(([key]) => key.toLowerCase() === "anthropic-beta");
  const tokens = [];
  for (const [key, value] of defaults) {
    delete headers[key];
    const normalized = normalizeAnthropicBeta(value);
    if (normalized) tokens.push(...normalized.split(","));
  }
  const normalizedIncoming = normalizeAnthropicBeta(incoming);
  if (normalizedIncoming) tokens.push(...normalizedIncoming.split(","));
  const excluded = new Set([
    ...(wantsThinkingSummaries(body) ? [ANTHROPIC_BETA_REDACT_THINKING] : []),
    ...(!/^claude-(opus|sonnet)/.test(model || "") ? ANTHROPIC_BETA_HEAVY_AGENT : []),
    ...(stripClaudeCode ? ["claude-code-20250219"] : []),
  ]);
  const merged = [...new Set(tokens.filter((token) => !excluded.has(token)))].join(",");
  if (merged) headers["anthropic-beta"] = merged;
  return headers;
}
