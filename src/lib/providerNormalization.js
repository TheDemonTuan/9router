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

  if (provider === "chatgpt-web") {
    const rawProfileId = next.profileId ?? body.profileId;
    return { profileId: typeof rawProfileId === "string" ? rawProfileId.trim() : rawProfileId };
  }

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

export function validateChatGptWebConnectionInput(body) {
  const allowed = new Set(["provider", "profileId", "providerSpecificData", "name", "displayName", "priority", "globalPriority", "defaultModel", "testStatus", "isActive", "lastError", "lastErrorAt", "id", "allowOverwrite", "overwrite"]);
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) && !(key === "apiKey" && !value)) throw new Error(`ChatGPT Web connection does not accept ${key}; configure runtime settings and secrets with the operator runtime instead`);
  }
  if (body.providerSpecificData !== undefined && (!body.providerSpecificData || typeof body.providerSpecificData !== "object" || Array.isArray(body.providerSpecificData)
    || Object.keys(body.providerSpecificData).some(key => key !== "profileId"))) {
    throw new Error("ChatGPT Web providerSpecificData accepts only profileId");
  }
  if (body.profileId !== undefined && body.providerSpecificData?.profileId !== undefined
    && body.profileId !== body.providerSpecificData.profileId) throw new Error("Conflicting ChatGPT Web profile selectors; provide only one profileId");
}

// Discovery is a union, not authorization. Execution rechecks the bound profile.
export function mergeChatGptWebPublicModels(catalogs) {
  const merged = new Map();
  for (const catalog of catalogs) {
    if (!catalog || catalog.stale) continue;
    for (const model of catalog.models || []) {
      if (model.legacy !== false || !Array.isArray(model.supported_reasoning_levels)
        || model.supported_reasoning_levels.includes("ultra")
        || (model.capabilities?.native_responses !== true && model.capabilities?.generic_responses !== true)) continue;
      const existing = merged.get(model.id);
      if (!existing) {
        merged.set(model.id, { ...model, capabilities: { ...model.capabilities, tools: model.capabilities.tools === true || model.capabilities.generic_tools === true }, supported_reasoning_levels: [...model.supported_reasoning_levels] });
        continue;
      }
      const capabilities = { ...existing.capabilities };
      for (const [key, value] of Object.entries(model.capabilities)) {
        if (value === true) capabilities[key] = true;
        else if (!(key in capabilities) && value === false) capabilities[key] = false;
      }
      capabilities.tools = capabilities.tools === true || capabilities.generic_tools === true;
      const combined = {
        ...existing,
        capabilities,
        supported_reasoning_levels: [...new Set([...existing.supported_reasoning_levels, ...model.supported_reasoning_levels])],
        context_window: Math.min(existing.context_window, model.context_window),
        auto_compact_token_limit: Math.min(existing.auto_compact_token_limit, model.auto_compact_token_limit),
      };
      if (existing.max_output !== undefined && model.max_output !== undefined) combined.max_output = Math.min(existing.max_output, model.max_output);
      else delete combined.max_output;
      if (existing.model_family !== model.model_family) delete combined.model_family;
      merged.set(model.id, combined);
    }
  }
  return [...merged.values()];
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
