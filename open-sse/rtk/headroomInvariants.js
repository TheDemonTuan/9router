const CONTROL_FIELDS = ["config", "gateway", "token_budget", "session_id", "_headroom_responses_view"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Wire contract only. Headroom owns the semantics of compressed messages and tools.
export function validateBodyInvariants(original, returned, { route, obligations = [], turnId, headers } = {}) {
  if (!object(original) || !object(returned)) return { valid: false, reason: "gateway_invalid_body" };
  if (CONTROL_FIELDS.some((field) => Object.hasOwn(returned, field))) return { valid: false, reason: "gateway_control_field" };
  if (returned.model !== original.model || (route != null && (!object(route) || (route.model !== undefined && route.model !== original.model) || route.provider != null))) {
    return { valid: false, reason: "model_sovereignty_violation" };
  }
  if (!Array.isArray(obligations) || obligations.some((value) => value !== "relay_usage")) {
    return { valid: false, reason: "unsupported_obligation" };
  }
  if (obligations.includes("relay_usage") && (typeof turnId !== "string" || !turnId.trim() || turnId.length > 128)) {
    return { valid: false, reason: "gateway_invalid_turn_id" };
  }
  if (headers !== null && headers !== undefined && (!object(headers) || Object.values(headers).some((value) => typeof value !== "string"))) {
    return { valid: false, reason: "gateway_invalid_provider_headers" };
  }
  return { valid: true };
}
