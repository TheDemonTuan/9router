import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const normalized = trimmed.toLowerCase();
  const providerByAlias = Object.values(AI_PROVIDERS).find(
    (entry) => entry.id?.toLowerCase() === normalized || entry.alias?.toLowerCase() === normalized
  );
  if (providerByAlias) return providerByAlias.id;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === normalized
  );
  return providerByName?.id || trimmed;
}

const SENSITIVE_PROVIDER_DATA_KEYS = new Set([
  "apikey", "accesstoken", "refreshtoken", "idtoken", "clientsecret",
  "copilottoken", "firebaseidtoken", "cloudidetoken", "mimopasstoken",
  "passtoken", "authtoken", "sessiontoken", "bearertoken", "token",
  "secret", "password", "cookie", "cookies", "authorization", "headers",
  "rawheaders", "customheaders", "credentials", "privatekey",
]);

function isSensitiveProviderDataKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_PROVIDER_DATA_KEYS.has(normalized) || normalized.endsWith("token") || normalized.endsWith("secret");
}

export function sanitizeProviderSpecificData(value) {
  if (Array.isArray(value)) return value.map(sanitizeProviderSpecificData);
  if (!value || typeof value !== "object") return value;

  const safe = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!isSensitiveProviderDataKey(key)) safe[key] = sanitizeProviderSpecificData(nestedValue);
  }
  return safe;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function mergeAntigravityModelLists(lists = []) {
  const merged = new Map();
  for (const list of lists || []) {
    for (const model of list || []) {
      if (!model?.id) continue;
      const existing = merged.get(model.id);
      if (!existing) {
        merged.set(model.id, {
          ...model,
          capabilities: model.capabilities ? { ...model.capabilities } : {},
        });
        continue;
      }
      const capabilities = { ...existing.capabilities };
      if (model.capabilities) {
        for (const [key, value] of Object.entries(model.capabilities)) {
          if (capabilities[key] !== undefined) {
            capabilities[key] = Boolean(capabilities[key] && value);
          } else {
            capabilities[key] = Boolean(value);
          }
        }
      }
      const combined = {
        ...existing,
        capabilities,
      };
      if (Number.isFinite(existing.contextLength) && Number.isFinite(model.contextLength)) {
        combined.contextLength = Math.min(existing.contextLength, model.contextLength);
      } else if (Number.isFinite(model.contextLength)) {
        combined.contextLength = model.contextLength;
      }
      if (Number.isFinite(existing.maxOutputTokens) && Number.isFinite(model.maxOutputTokens)) {
        combined.maxOutputTokens = Math.min(existing.maxOutputTokens, model.maxOutputTokens);
      } else if (Number.isFinite(model.maxOutputTokens)) {
        combined.maxOutputTokens = model.maxOutputTokens;
      }
      merged.set(model.id, combined);
    }
  }
  return [...merged.values()];
}
