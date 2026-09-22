import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { getAntigravityUsage } from "open-sse/services/usage/google.js";
import { markAccountUnavailable } from "./auth.js";
import * as log from "../utils/logger.js";

const quotaCache = new Map();
const lastRefreshAt = new Map();
const inflightRefresh = new Map();
const strikeCounts = new Map();

const MIN_REFRESH_INTERVAL_MS = 30_000;
const STRIKE_WINDOW_MS = 60_000;
const STRIKE_THRESHOLD = 3;
const STRIKE_BLOCK_MS = 15 * 60_000;
const MODEL_IDS = new Set(getModelsByProviderId("antigravity").map(model => model.id));
const DISPLAY_ONLY_KEYS = new Set([
  "gemini_weekly",
  "gemini_session",
  "claude_gpt_weekly",
  "claude_gpt_session",
]);

export function clearAntigravityStrikes(connectionId, model) {
  strikeCounts.delete(`${connectionId}|${model}`);
}

/** Persist only exact, future-dated zero-quota router models. */
export async function persistAntigravityQuota(connectionId, quotas) {
  if (!quotas || typeof quotas !== "object" || Array.isArray(quotas)) return;
  for (const [model, quota] of Object.entries(quotas)) {
    if (DISPLAY_ONLY_KEYS.has(model) || !MODEL_IDS.has(model)) continue;
    if (quota?.unlimited === true || quota?.remainingPercentage !== 0) continue;
    if (typeof quota?.remainingPercentage !== "number" || !Number.isFinite(quota.remainingPercentage)) continue;
    const resetMs = new Date(quota.resetAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= Date.now()) continue;
    await markAccountUnavailable(
      connectionId,
      429,
      "Antigravity quota remaining=0",
      "antigravity",
      model,
      resetMs,
      "quota_exhausted",
    );
  }
}

export async function refreshAntigravityQuota(connectionId, accessToken, providerSpecificData) {
  const now = Date.now();
  const inflight = inflightRefresh.get(connectionId);
  if (inflight) return inflight;

  const lastRefresh = lastRefreshAt.get(connectionId) || 0;
  if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
    const snapshot = quotaCache.get(connectionId) || null;
    if (snapshot) await persistAntigravityQuota(connectionId, snapshot);
    return snapshot;
  }

  lastRefreshAt.set(connectionId, now);
  const promise = _doRefresh(connectionId, accessToken, providerSpecificData, now);
  inflightRefresh.set(connectionId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(connectionId);
  }
}

async function _doRefresh(connectionId, accessToken, providerSpecificData, now) {
  let usage;
  try {
    const proxyCfg = await resolveConnectionProxyConfig(providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: proxyCfg.strictProxy === true,
    };
    usage = await getAntigravityUsage(accessToken, providerSpecificData, proxyOptions);
  } catch (error) {
    log.warn("AG_QUOTA", `${connectionId.slice(0, 8)} | refresh failed: ${error.message}`);
    return null;
  }

  if (!usage?.quotas || usage.message) return null;
  quotaCache.set(connectionId, usage.quotas);
  await persistAntigravityQuota(connectionId, usage.quotas);
  return usage.quotas;
}

/**
 * Refresh Antigravity quota evidence after a generation 409/429.
 * @returns {null|{resetsAtMs:number,errorClass:string}}
 */
export async function handleAntigravityQuotaError(connectionId, status, model, accessToken, providerSpecificData) {
  if (status !== 409 && status !== 429) return null;
  log.info("AG_QUOTA", `${connectionId.slice(0, 8)} | ${status} on ${model} — refreshing quota`);

  const quota = (await refreshAntigravityQuota(connectionId, accessToken, providerSpecificData))?.[model];
  const now = Date.now();
  const resetMs = new Date(quota?.resetAt).getTime();
  if (quota?.remainingPercentage === 0 && Number.isFinite(resetMs) && resetMs > now) {
    strikeCounts.delete(`${connectionId}|${model}`);
    return { resetsAtMs: resetMs, errorClass: "quota_exhausted" };
  }

  const key = `${connectionId}|${model}`;
  const strike = strikeCounts.get(key);
  const windowStart = strike && now - strike.windowStart <= STRIKE_WINDOW_MS ? strike.windowStart : now;
  const count = strike && windowStart === strike.windowStart ? strike.count + 1 : 1;
  if (count < STRIKE_THRESHOLD) {
    strikeCounts.set(key, { count, windowStart });
    return null;
  }

  strikeCounts.delete(key);
  const blockedUntil = now + STRIKE_BLOCK_MS;
  log.warn("AG_QUOTA", `${connectionId.slice(0, 8)} | STRIKE_${status} ${model} — ${count}x within 60s; breaker 15m`);
  return { resetsAtMs: blockedUntil, errorClass: "rate_limited" };
}
