// Alibaba Token Plan model discovery — shared by /api/providers/[id]/models,
// /v1/models, the dashboard pickers, and tests (one effective catalog, no
// second discovery system).
//
// Flow (fixer point 9): authenticated live /models → 15-min cache →
// last-known-good cache → curated edition fallback catalog. A 403/404/405 from
// the live probe does NOT mark the connection broken — it is negatively cached
// and the fallback catalog is used, so inference keeps working. No HTML
// scraping, no per-model probing (credits + rate limits).
import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  ALITP_BASE_ORIGIN,
  ALITP_DISCOVERY,
  ALITP_CATALOG_VERSION,
  ALITP_DEFAULT_EDITION,
  ALITP_EDITIONS,
  getAlitpFallbackCatalog,
  getAlitpCatalogEntry,
  sanitizeAlitpBaseOrigin,
} from "../providers/alibabaTokenPlanCatalog.js";

const FETCH_TIMEOUT_MS = 15_000;
const NEGATIVE_TTL_MS = 15 * 60 * 1000;
const NEGATIVE_STATUSES = new Set([403, 404, 405]);

/** @type {Map<string, { expiresAt: number, models: object[], fetchedAt: number } | { expiresAt: number, negative: true }>} */
const catalogCache = new Map();
// Kept separately so a later 403/404/405 negative-cache entry cannot erase a
// prior successful catalog. This is the last-known-good step in the contract.
const lastKnownGood = new Map();
/** @type {Map<string, Promise<object[] | null>>} */
const inflight = new Map();

export function getAlitpConnectionEdition(connection) {
  const edition = connection?.providerSpecificData?.tokenPlanEdition;
  return ALITP_EDITIONS.includes(edition) ? edition : ALITP_DEFAULT_EDITION;
}

// Effective API origin for a connection: sanitized Team Base URL override or
// the default Singapore endpoint.
export function getAlitpBaseOrigin(connection) {
  return sanitizeAlitpBaseOrigin(connection?.providerSpecificData?.tokenPlanBaseUrl) || ALITP_BASE_ORIGIN;
}

export function buildAlitpModelsUrl(baseOrigin) {
  return `${baseOrigin}${ALITP_DISCOVERY.modelsPath}`;
}

function readToken(connection) {
  return connection?.apiKey || connection?.accessToken || null;
}

// Cache key hashes the credential seed — the raw key never lands in the cache.
function cacheKey(connection) {
  const seed = readToken(connection) || connection?.id || "anonymous";
  return createHash("sha256")
    .update(`alitp:${getAlitpBaseOrigin(connection)}:${seed}`)
    .digest("hex");
}

// Normalize a live /models entry. Known catalog models keep their curated
// metadata (limits/vision/formats); unknown live additions pass through with
// no fabricated capabilities (undefaulted cells stay unmapped, not guessed).
export function normalizeAlitpLiveModel(item) {
  const id = typeof item?.id === "string" ? item.id.trim() : "";
  if (!id) return null;
  const curated = getAlitpCatalogEntry(id);
  return {
    id,
    name: curated?.name || id,
    ...(curated?.upstreamId ? { upstreamModelId: curated.upstreamId } : {}),
    ...(curated?.deprecated ? { deprecated: true } : {}),
    ...(curated?.formats ? { supportedFormats: curated.formats } : {}),
    ...(curated ? {
      capabilities: {
        vision: !!curated.vision,
        videoInput: !!curated.videoInput,
        reasoning: true,
        contextWindow: curated.contextWindow,
        maxOutput: curated.maxOutput,
      },
    } : {}),
    source: curated ? "catalog+live" : "live",
  };
}

async function fetchLiveModels(connection, options = {}) {
  const token = readToken(connection);
  if (!token) return null;
  const url = buildAlitpModelsUrl(getAlitpBaseOrigin(connection));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Alibaba Token Plan models fetch timeout")), FETCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    }, options.proxyOptions || null);
    if (!response.ok) {
      const error = new Error(`Alibaba Token Plan models ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const items = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : null);
    if (!items) return null;
    const models = items.map(normalizeAlitpLiveModel).filter(Boolean);
    return models.length > 0 ? models : null;
  } finally {
    clearTimeout(timeout);
  }
}

// Live probe with TTL cache + in-flight dedupe + negative cache. Returns
// { models, fetchedAt } or null (caller falls back — never throws).
export async function resolveAlitpLiveModels(connection, options = {}) {
  if (!connection) return null;
  const key = cacheKey(connection);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      if (cached.negative) return null;
      return { models: cached.models, fetchedAt: cached.fetchedAt, source: "cache" };
    }
  }
  if (inflight.has(key) && !options.forceRefresh) {
    const models = await inflight.get(key);
    return models ? { models, fetchedAt: Date.now(), source: "cache" } : null;
  }

  const promise = (async () => {
    try {
      const models = await fetchLiveModels(connection, options);
      if (models) {
        const entry = { expiresAt: Date.now() + ALITP_DISCOVERY.ttlMs, models, fetchedAt: Date.now() };
        catalogCache.set(key, entry);
        lastKnownGood.set(key, entry);
      } else {
        catalogCache.set(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS, negative: true });
      }
      return models;
    } catch (error) {
      // Unsupported/forbidden endpoint → negative cache, connection stays healthy.
      if (NEGATIVE_STATUSES.has(error?.status)) {
        catalogCache.set(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS, negative: true });
      }
      options.log?.warn?.("ALITP_MODELS", `live discovery failed (${error?.message || "unknown"}) — using fallback catalog`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  const models = await promise;
  return models ? { models, fetchedAt: Date.now(), source: "live" } : null;
}

// Cache-only peek (no network) — used where a synchronous-ish check is needed.
export function peekAlitpCachedModels(connection) {
  const cached = catalogCache.get(cacheKey(connection));
  if (cached && !cached.negative && cached.expiresAt > Date.now()) {
    return { models: cached.models, fetchedAt: cached.fetchedAt };
  }
  return null;
}

// Last-known-good even when stale (live discovery is currently failing).
export function peekAlitpLastKnownGood(connection) {
  const cached = lastKnownGood.get(cacheKey(connection));
  if (cached) return { models: cached.models, fetchedAt: cached.fetchedAt };
  return null;
}

// The one effective-catalog entry point (fixer point 12):
//   live → cache → last-known-good (stale) → curated edition fallback.
// Returns { models, source: "live"|"cache"|"fallback", fetchedAt, warning }.
// Never exposes credentials or raw upstream failure details.
export async function resolveEffectiveProviderModels(providerId, connection, options = {}) {
  if (providerId !== "alitp-intl") {
    return { models: null, source: null, fetchedAt: null, warning: null };
  }
  const live = await resolveAlitpLiveModels(connection, options);
  if (live) {
    return { models: live.models, source: live.source || "live", fetchedAt: live.fetchedAt, warning: null };
  }
  const cached = peekAlitpLastKnownGood(connection);
  if (cached) {
    return { models: cached.models, source: "cache", fetchedAt: cached.fetchedAt, warning: null };
  }
  const edition = getAlitpConnectionEdition(connection);
  const models = getAlitpFallbackCatalog(edition).map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.formats ? { supportedFormats: m.formats } : {}),
    capabilities: {
      vision: !!m.vision,
      videoInput: !!m.videoInput,
      reasoning: true,
      contextWindow: m.contextWindow,
      maxOutput: m.maxOutput,
    },
  }));
  return {
    models,
    source: "fallback",
    fetchedAt: null,
    warning: connection
      ? `Live model discovery unavailable — showing the official ${edition} catalog (${ALITP_CATALOG_VERSION}).`
      : null,
  };
}

export function clearAlitpCatalogCache() {
  catalogCache.clear();
  lastKnownGood.clear();
  inflight.clear();
}
