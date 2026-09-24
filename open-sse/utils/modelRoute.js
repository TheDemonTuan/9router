import { parseModel } from "../services/model.js";

/**
 * Check if two model strings resolve to the exact same canonical provider and model.
 * E.g. "ag/gemini-3.8-flash-high" and "antigravity/gemini-3.8-flash-high" -> true
 */
export function isSameRoute(modelA, modelB) {
  if (!modelA || !modelB) return false;
  if (modelA === modelB) return true;

  const pA = parseModel(modelA);
  const pB = parseModel(modelB);

  if (pA?.provider && pB?.provider) {
    return pA.provider === pB.provider && pA.model === pB.model;
  }
  return false;
}

/**
 * Create structured routeContext object.
 *
 * @param {Object} params
 * @param {string} params.clientModel - Model requested by client (e.g. "ag/gemini-3.8-flash-high", "coding-best")
 * @param {string|null} [params.requestedProviderAlias] - Provider alias requested by client (e.g. "ag")
 * @param {string} params.provider - Canonical provider ID (e.g. "antigravity")
 * @param {string} params.requestedModel - Model name without provider prefix
 * @param {string} [params.effectiveModel] - Model selected to execute (e.g. "ag/gemini-3.8-flash-high" or "cx/gpt-6-sol")
 * @param {string} [params.wireModel] - Upstream wire model without thinking suffix
 * @param {string} [params.reason="direct"] - "direct" | "alias" | "combo" | "fallback" | "capacity-adapter" | "model-alias"
 */
export function createRouteContext({
  clientModel,
  requestedProviderAlias = null,
  provider = null,
  requestedModel = null,
  effectiveModel = null,
  wireModel = null,
  reason = "direct",
} = {}) {
  const parsedClient = parseModel(clientModel);
  const resolvedProvider = provider || parsedClient.provider || null;
  const alias = requestedProviderAlias || parsedClient.providerAlias || null;
  const modelName = requestedModel || parsedClient.model || null;

  const effModel = effectiveModel
    || (alias && modelName ? `${alias}/${modelName}` : null)
    || (resolvedProvider && modelName ? `${resolvedProvider}/${modelName}` : null)
    || clientModel;

  return {
    clientModel: clientModel || effModel,
    requestedProviderAlias: alias,
    provider: resolvedProvider,
    requestedModel: modelName,
    effectiveModel: effModel,
    wireModel: wireModel || modelName,
    reason: reason || "direct",
  };
}

/**
 * Format route for request log line.
 * Uses arrow (→) only when effectiveModel is truly a different route/model than clientModel.
 * Provider alias resolution (e.g. ag → antigravity) is NEVER rendered as an arrow.
 */
export function formatRoute(routeContext) {
  if (!routeContext) return "";
  const clientModel = routeContext.clientModel;
  const effectiveModel = routeContext.effectiveModel;

  if (!effectiveModel || !clientModel) return clientModel || effectiveModel || "";
  if (isSameRoute(clientModel, effectiveModel)) {
    return clientModel;
  }
  return `${clientModel} → ${effectiveModel}`;
}

/**
 * Format fallback notice.
 */
export function formatFallback(fromModel, toModel, reason) {
  const parts = [`${fromModel} → ${toModel}`];
  if (reason) parts.push(`reason: ${reason}`);
  return parts.join(" · ");
}

/**
 * Format capacity adapter notice.
 */
export function formatAdapter(fromModel, toModel, reason) {
  const parts = [`${fromModel} → ${toModel}`];
  if (reason) parts.push(`reason: ${reason}`);
  return parts.join(" · ");
}
