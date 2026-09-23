import { createHash } from "crypto";
import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../config/codexClient.js";
import { getModelsByProviderId } from "../config/providerModels.js";
import { withCodexReviewModels } from "../providers/models/helpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { refreshProviderCredentials } from "./oauthCredentialManager.js";

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const CODEX_OFFICIAL_MODELS_URL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
export const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const CODEX_MODEL_STALE_TTL_MS = 24 * 60 * 60 * 1000;
export const CODEX_MODEL_RETRY_MS = 30 * 1000;
export const CODEX_MODEL_FETCH_TIMEOUT_MS = 5 * 1000;

const liveCache = new Map();
const liveLastKnownGood = new Map();
const liveInflight = new Map();
const liveFailures = new Map();
let officialCache = null;
let officialInflight = null;
let officialFailureAt = 0;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function firstPositive(...values) {
  return values.map(finitePositive).find(Boolean);
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function versionParts(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareCodexVersions(left, right) {
  const a = versionParts(left) || [0, 0, 0];
  const b = versionParts(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function getRawModels(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["models", "data", "results"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function getRecordId(record) {
  for (const key of ["slug", "id", "model", "name"]) {
    if (typeof record?.[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}

function getReasoningLevels(record) {
  const raw = record?.supported_reasoning_levels ?? record?.supportedReasoningLevels;
  if (!Array.isArray(raw)) return undefined;
  const levels = raw
    .map((item) => typeof item === "string" ? item.trim() : item?.effort?.trim?.())
    .filter(Boolean);
  return [...new Set(levels)];
}

function inferKind(id, record) {
  const declared = record?.kind || record?.type;
  if (declared) return declared;
  const lower = id.toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/image|imagen|dall-e|flux|stable-diffusion/.test(lower)) return "image";
  return "llm";
}

function buildCapabilities({ kind, inputModalities, reasoningLevels, contextLength, maxOutputTokens, record }) {
  const hasInputModalities = Array.isArray(inputModalities);
  const input = hasInputModalities ? inputModalities.map((value) => String(value).toLowerCase()) : [];
  const hasReasoning = Array.isArray(reasoningLevels)
    ? reasoningLevels.length > 0
    : Boolean(record?.default_reasoning_level || record?.defaultReasoningLevel);
  const hasSearchType = Object.prototype.hasOwnProperty.call(record || {}, "web_search_tool_type")
    || Object.prototype.hasOwnProperty.call(record || {}, "webSearchToolType");
  const searchType = record?.web_search_tool_type ?? record?.webSearchToolType;
  const supportsTools = record?.supports_tools ?? record?.supportsTools;
  return {
    ...(supportsTools !== undefined
      ? { tools: Boolean(supportsTools) }
      : kind === "llm" || kind === "imageToText" ? { tools: true } : {}),
    ...(hasInputModalities ? { vision: input.includes("image") } : {}),
    ...(hasSearchType ? { search: Boolean(searchType) } : {}),
    ...(hasReasoning ? { reasoning: true, thinkingFormat: "openai" } : Array.isArray(reasoningLevels) ? { reasoning: false } : {}),
    ...(contextLength ? { contextWindow: contextLength } : {}),
    ...(maxOutputTokens ? { maxOutput: maxOutputTokens } : {}),
  };
}

export function normalizeCodexModel(record) {
  if (!record || typeof record !== "object") return null;
  const id = getRecordId(record);
  if (!id) return null;

  const kind = inferKind(id, record);
  const inputModalities = record.input_modalities || record.inputModalities;
  const reasoningLevels = getReasoningLevels(record);
  const contextLength = firstPositive(
    record.context_window,
    record.contextWindow,
    record.context_length,
    record.contextLength,
    record.max_context_window,
    record.maxContextWindow,
  );
  const maxContextLength = firstPositive(record.max_context_window, record.maxContextWindow);
  const effectiveContextLength = maxContextLength && contextLength
    ? Math.min(contextLength, maxContextLength)
    : contextLength || maxContextLength;
  const maxOutputTokens = firstPositive(
    record.max_output_tokens,
    record.maxOutputTokens,
    record.max_output,
    record.maxOutput,
  );
  const minimalClientVersion = record.minimal_client_version || record.minimalClientVersion;
  const model = {
    id,
    name: record.display_name || record.displayName || record.name || id,
    ...(record.description ? { description: record.description } : {}),
    kind,
    ...(effectiveContextLength ? { contextLength: effectiveContextLength } : {}),
    ...(maxContextLength ? { maxContextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(Array.isArray(inputModalities) ? { inputModalities } : {}),
    ...(Array.isArray(record.output_modalities || record.outputModalities)
      ? { outputModalities: record.output_modalities || record.outputModalities }
      : {}),
    ...(record.default_reasoning_level || record.defaultReasoningLevel
      ? { defaultReasoningLevel: record.default_reasoning_level || record.defaultReasoningLevel }
      : {}),
    ...(reasoningLevels ? { supportedReasoningLevels: reasoningLevels } : {}),
    ...(minimalClientVersion ? { minimalClientVersion } : {}),
    ...(Number.isFinite(Number(record.priority)) ? { priority: Number(record.priority) } : {}),
    ...(record.upstream_model_id || record.upstreamModelId
      ? { upstreamModelId: record.upstream_model_id || record.upstreamModelId }
      : {}),
    capabilities: buildCapabilities({ kind, inputModalities, reasoningLevels, contextLength: effectiveContextLength, maxOutputTokens, record }),
  };
  return model;
}

function isAdvertisable(record) {
  const visibility = String(record?.visibility ?? "").toLowerCase();
  if (visibility === "hide") return false;
  if (record?.supported_in_api === false || record?.supportedInApi === false) return false;
  return true;
}

export function normalizeCodexCatalog(payload, { includeCandidates = false } = {}) {
  const records = getRawModels(payload);
  if (!records) throw new Error("Codex model catalog has an invalid shape");
  const models = [];
  const candidateModels = [];
  const seen = new Set();

  for (const record of records) {
    if (!isAdvertisable(record)) continue;
    const model = normalizeCodexModel(record);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    if (model.minimalClientVersion && compareCodexVersions(model.minimalClientVersion, CODEX_CLIENT_VERSION) > 0) {
      candidateModels.push({ ...model, discoveryStatus: "candidate", compatibilityReason: "minimal_client_version" });
      continue;
    }
    models.push(model);
  }
  return includeCandidates ? { models, candidateModels } : models;
}

function staticModels() {
  return getModelsByProviderId("codex").map((model) => ({ ...model }));
}

function staticById() {
  return new Map(staticModels().map((model) => [model.id, model]));
}

function mergeCapabilities(...values) {
  const merged = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    Object.assign(merged, value);
  }
  return Object.keys(merged).length ? merged : undefined;
}

function mergeModelMetadata(...models) {
  const present = models.filter(Boolean);
  if (!present.length) return null;
  const result = { ...present[0] };
  for (const model of present.slice(1)) {
    for (const [key, value] of Object.entries(model)) {
      if (value !== undefined && value !== null && value !== "") result[key] = value;
    }
  }

  const contextValues = present.map((model) => finitePositive(model.contextLength)).filter(Boolean);
  const maxContextValues = present.map((model) => finitePositive(model.maxContextLength)).filter(Boolean);
  if (contextValues.length) result.contextLength = Math.min(...contextValues);
  if (maxContextValues.length) result.maxContextLength = Math.min(...maxContextValues);
  if (result.contextLength && result.maxContextLength) {
    result.contextLength = Math.min(result.contextLength, result.maxContextLength);
  }
  const reasoning = [...present].reverse().find((model) => Array.isArray(model.supportedReasoningLevels));
  if (reasoning) result.supportedReasoningLevels = reasoning.supportedReasoningLevels;
  result.capabilities = mergeCapabilities(...present.map((model) => model.capabilities));
  if (result.contextLength && result.capabilities) result.capabilities.contextWindow = result.contextLength;
  if (result.maxOutputTokens && result.capabilities) result.capabilities.maxOutput = result.maxOutputTokens;
  return result;
}

function enrichModels(models, officialModels) {
  const staticCatalog = staticById();
  const officialById = new Map((officialModels || []).map((model) => [model.id, model]));
  return models.map((model) => mergeModelMetadata(staticCatalog.get(model.id), officialById.get(model.id), model));
}

function appendStaticMedia(models) {
  const result = [...models];
  const ids = new Set(result.map((model) => model.id));
  for (const model of staticModels()) {
    if (model.kind === "image" && !ids.has(model.id)) {
      result.push(model);
      ids.add(model.id);
    }
  }
  return result;
}

function withReviews(models) {
  return withCodexReviewModels(models).filter((model, index, all) => (
    all.findIndex((entry) => entry.id === model.id) === index
  ));
}

function getConnectionId(connection) {
  return connection?.id || connection?.connectionId || "";
}

function getAccountIdentity(connection) {
  return connection?.providerSpecificData?.workspaceId
    || connection?.providerSpecificData?.chatgptAccountId
    || connection?.providerSpecificData?.accountId
    || connection?.workspaceId
    || connection?.chatgptAccountId
    || connection?.accountId
    || "";
}

function getAccessToken(connection) {
  return connection?.accessToken || connection?.apiKey || null;
}

export function getCodexCacheKey(connection) {
  const identity = getAccountIdentity(connection);
  const connectionId = getConnectionId(connection);
  const token = getAccessToken(connection);
  const seed = identity
    ? `account:${identity}`
    : token
      ? `token:${token}`
      : `connection:${connectionId || "anonymous"}`;
  const digest = createHash("sha256").update(seed).digest("hex");
  return `codex:${connectionId || "none"}:${identity || "token"}:${CODEX_CLIENT_VERSION}:${digest}`;
}

function buildCodexUrl() {
  const url = new URL(CODEX_MODELS_URL);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  return url.toString();
}

function buildLiveHeaders(connection, token, etag) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    originator: CODEX_ORIGINATOR,
    "User-Agent": CODEX_USER_AGENT,
  };
  const accountId = getAccountIdentity(connection);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

function createRequestSignal(externalSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(new Error("Codex model catalog request timeout")),
    cleanup: () => externalSignal?.removeEventListener?.("abort", onAbort),
  };
}

async function fetchJson(fetchImpl, url, options, proxyOptions, externalSignal) {
  const request = createRequestSignal(externalSignal);
  const timer = setTimeout(request.abort, CODEX_MODEL_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: request.signal }, proxyOptions || null);
  } finally {
    clearTimeout(timer);
    request.cleanup();
  }
}

function makeCatalogEntry(models, response, now, previous = null) {
  return {
    models,
    etag: headerValue(response, "etag") || (response?.status === 304 ? previous?.etag : null),
    fetchedAt: now,
    checkedAt: now,
    expiresAt: now + CODEX_MODEL_CACHE_TTL_MS,
    staleAt: now + CODEX_MODEL_STALE_TTL_MS,
  };
}

async function refreshConnection(connection, options) {
  if (!connection?.refreshToken) return null;
  const refreshed = options.refreshFn
    ? await options.refreshFn(connection)
    : await refreshProviderCredentials("codex", connection, options.log || console);
  if (!refreshed?.accessToken) return null;
  const next = {
    ...connection,
    ...refreshed,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      ...(refreshed.providerSpecificData || {}),
    },
  };
  await options.onCredentialsRefreshed?.(refreshed);
  Object.assign(connection, next);
  return next;
}

async function fetchLiveCatalog(connection, previous, options) {
  const fetchImpl = options.fetchImpl || proxyAwareFetch;
  let current = connection;
  let token = getAccessToken(current);
  let etag = previous?.etag || null;
  let retried = false;

  while (token) {
    const response = await fetchJson(fetchImpl, buildCodexUrl(), {
      method: "GET",
      headers: buildLiveHeaders(current, token, etag),
      cache: "no-store",
    }, options.proxyOptions, options.signal);

    if (response.status === 401 && !retried && current.refreshToken) {
      retried = true;
      current = await refreshConnection(current, options);
      token = getAccessToken(current);
      etag = null;
      continue;
    }
    if (response.status === 304) {
      if (!previous) throw Object.assign(new Error("Codex model catalog returned 304 without cached data"), { status: 304 });
      return { entry: makeCatalogEntry(previous.models, response, Date.now(), previous), candidates: previous.candidateModels || [] };
    }
    if (!response.ok) throw Object.assign(new Error(`Codex model catalog request failed (${response.status})`), { status: response.status });

    const payload = await response.json();
    const normalized = normalizeCodexCatalog(payload, { includeCandidates: true });
    const entry = makeCatalogEntry(normalized.models, response, Date.now());
    entry.candidateModels = normalized.candidateModels;
    return { entry, candidates: normalized.candidateModels };
  }
  throw Object.assign(new Error("Codex model catalog has no access token"), { status: 401 });
}

async function resolveLiveCatalog(connection, options) {
  const key = getCodexCacheKey(connection);
  const now = Date.now();
  const cached = liveCache.get(key);
  if (!options.forceRefresh && cached?.expiresAt > now) {
    return { entry: cached, source: "cache", access: "observed", stale: false };
  }
  if (!options.forceRefresh && liveFailures.has(key) && now - liveFailures.get(key) < CODEX_MODEL_RETRY_MS) {
    return null;
  }
  if (liveInflight.has(key)) return liveInflight.get(key);

  const previous = cached || liveLastKnownGood.get(key) || null;
  const promise = fetchLiveCatalog(connection, previous, options)
    .then(({ entry, candidates }) => {
      entry.candidateModels = candidates;
      liveCache.set(key, entry);
      liveLastKnownGood.set(key, entry);
      liveFailures.delete(key);
      return { entry, source: "live", access: "observed", stale: false };
    })
    .catch((error) => {
      liveFailures.set(key, Date.now());
      options.log?.warn?.("CODEX_MODELS", `live discovery failed (${error?.status || "network"})`);
      return null;
    })
    .finally(() => liveInflight.delete(key));
  liveInflight.set(key, promise);
  return promise;
}

async function resolveOfficialCatalog(options) {
  const now = Date.now();
  if (!options.forceRefresh && officialCache?.expiresAt > now) {
    return { ...officialCache, source: "github", access: "unverified", stale: false };
  }
  if (!options.forceRefresh && officialFailureAt && now - officialFailureAt < CODEX_MODEL_RETRY_MS) {
    return null;
  }
  if (officialInflight) return officialInflight;

  const fetchImpl = options.fetchImpl || proxyAwareFetch;
  const previous = officialCache;
  officialInflight = fetchJson(fetchImpl, CODEX_OFFICIAL_MODELS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
    },
    cache: "no-store",
  }, options.proxyOptions, options.signal)
    .then(async (response) => {
      if (response.status === 304) {
        if (!previous) throw new Error("Codex official catalog returned 304 without cached data");
        officialCache = makeCatalogEntry(previous.models, response, now, previous);
        officialCache.candidateModels = previous.candidateModels || [];
        return { ...officialCache, source: "github", access: "unverified", stale: false };
      }
      if (!response.ok) throw Object.assign(new Error(`Codex official catalog request failed (${response.status})`), { status: response.status });
      const normalized = normalizeCodexCatalog(await response.json(), { includeCandidates: true });
      officialCache = makeCatalogEntry(normalized.models, response, now);
      officialCache.candidateModels = normalized.candidateModels;
      officialFailureAt = 0;
      return { ...officialCache, source: "github", access: "unverified", stale: false };
    })
    .catch((error) => {
      officialFailureAt = Date.now();
      options.log?.warn?.("CODEX_MODELS", `official catalog failed (${error?.status || "network"})`);
      if (previous && previous.staleAt > Date.now()) {
        return { ...previous, source: "github-cache", access: "unverified", stale: true };
      }
      return null;
    })
    .finally(() => { officialInflight = null; });
  return officialInflight;
}

function buildStaticFallback() {
  const models = [];
  const candidateModels = [];
  for (const model of staticModels()) {
    if (!model?.id) continue;
    if (model.minimalClientVersion && compareCodexVersions(model.minimalClientVersion, CODEX_CLIENT_VERSION) > 0) {
      candidateModels.push({ ...model, discoveryStatus: "candidate", compatibilityReason: "minimal_client_version" });
      continue;
    }
    models.push({ ...model });
  }
  return {
    models: withReviews(models),
    candidateModels,
    fetchedAt: null,
    source: "static",
    access: "unverified",
    stale: false,
  };
}

export function mergeCodexCatalogMetadata(models, supplementModels) {
  const supplementById = new Map((supplementModels || []).map((model) => [model.id, model]));
  return models.map((model) => mergeModelMetadata(supplementById.get(model.id), model));
}

export function mergeCodexModelLists(modelLists) {
  const byId = new Map();
  for (const list of modelLists || []) {
    for (const model of list || []) {
      if (!model?.id) continue;
      const current = byId.get(model.id);
      if (!current) {
        byId.set(model.id, { ...model });
        continue;
      }
      const merged = mergeModelMetadata(current, model);
      const leftLevels = Array.isArray(current.supportedReasoningLevels) ? current.supportedReasoningLevels : null;
      const rightLevels = Array.isArray(model.supportedReasoningLevels) ? model.supportedReasoningLevels : null;
      if (leftLevels && rightLevels) {
        merged.supportedReasoningLevels = leftLevels.filter((level) => rightLevels.includes(level));
      }
      byId.set(model.id, merged);
    }
  }
  return [...byId.values()];
}

export async function resolveCodexModels(connection, options = {}) {
  const staticFallback = buildStaticFallback();
  const hasToken = Boolean(getAccessToken(connection));
  let liveResult = null;
  let warning = null;

  if (hasToken) {
    liveResult = await resolveLiveCatalog(connection, options);
    if (liveResult) {
      const official = await resolveOfficialCatalog(options);
      const enriched = enrichModels(liveResult.entry.models, official?.models);
      return {
        models: withReviews(appendStaticMedia(enriched)),
        candidateModels: liveResult.entry.candidateModels || [],
        source: liveResult.source,
        access: liveResult.access,
        stale: false,
        fetchedAt: liveResult.entry.fetchedAt,
        warning: official?.stale ? "Official Codex metadata is stale; account catalog remains active." : null,
        resolved: true,
      };
    }

    const key = getCodexCacheKey(connection);
    const stale = liveLastKnownGood.get(key);
    if (stale && stale.staleAt > Date.now()) {
      const official = await resolveOfficialCatalog(options);
      const enriched = enrichModels(stale.models, official?.models);
      return {
        models: withReviews(appendStaticMedia(enriched)),
        candidateModels: stale.candidateModels || [],
        source: "cache",
        access: "stale",
        stale: true,
        fetchedAt: stale.fetchedAt,
        warning: "Live Codex catalog unavailable; using the last known catalog.",
        resolved: true,
      };
    }
    warning = "Live Codex catalog unavailable; showing an unverified catalog.";
  }

  const official = await resolveOfficialCatalog(options);
  if (official?.models?.length) {
    return {
      models: withReviews(appendStaticMedia(enrichModels(official.models, staticModels()))),
      candidateModels: official.candidateModels || [],
      source: official.source,
      access: official.access,
      stale: official.stale,
      fetchedAt: official.fetchedAt,
      warning: warning || (official.stale ? "Official Codex catalog is stale." : "Account access was not verified."),
      resolved: true,
    };
  }

  return {
    ...staticFallback,
    warning: warning || "Using the static Codex catalog.",
    resolved: true,
  };
}

export function clearCodexModelCache() {
  liveCache.clear();
  liveLastKnownGood.clear();
  liveInflight.clear();
  liveFailures.clear();
  officialCache = null;
  officialInflight = null;
  officialFailureAt = 0;
}

export function invalidateCodexModelCache(connection) {
  const key = getCodexCacheKey(connection);
  liveCache.delete(key);
  liveLastKnownGood.delete(key);
  liveFailures.delete(key);
}

export function getCodexCachedModel(connection, modelId) {
  const key = getCodexCacheKey(connection);
  const entry = liveCache.get(key) || liveLastKnownGood.get(key);
  const baseId = String(modelId || "").replace(/\([^()]+\)\s*$/, "").trim();
  return entry?.models?.find((model) => model.id === baseId) || null;
}
