export const PROTOCOL_VERSION = 1;
export const SERVICE_NAME = "9router-cgw-runtime";
export const UPSTREAM_REVISION = "fa2d2c6c24926078b46eedb2186f69f2e8d548d7";
export const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MODEL_SLUG_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const AUTHORITY_HEADER = "x-9router-cgw-attestation";
export const AUTHORITY_AUDIENCE = "9router-cgw";
export const MAX_AUTHORITY_BYTES = 8192;
export const AUTHORITY_LIFETIME_SECONDS = 60;
export const AUTHORITY_CLOCK_SKEW_SECONDS = 15;
export const MAX_BROWSER_TURNS = 5;
export const REASONING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const PUBLIC_PATHS = Object.freeze({
  responses: "/v1/responses",
  compact: "/v1/responses/compact",
  interrupt: "/v1/cgw/interrupt-turn",
});
export const RUNTIME_PATHS = Object.freeze({
  health: "/healthz", ready: "/readyz", models: "/v1/web-models",
  bindings: "/v1/thread-bindings/resolve", responses: "/v1/responses",
  compact: "/v1/responses/compact", interrupt: "/v1/interrupt-turn",
});
export function validateProfileId(value) {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid ChatGPT Web profile ID");
  }
  return value;
}
export function canonicalPublicPath(path) {
  for (const allowed of Object.values(PUBLIC_PATHS)) {
    if (path === allowed || path === `/api${allowed}`) return allowed;
  }
  throw new TypeError("Unsupported ChatGPT Web authority path");
}
export function isCanonicalCgwModel(value) {
  const prefix = "cgw/chatgpt-web/";
  return typeof value === "string" && value.startsWith(prefix)
    && value.length <= prefix.length + 128 && MODEL_SLUG_PATTERN.test(value.slice(prefix.length));
}
