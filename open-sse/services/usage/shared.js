/**
 * Shared usage helpers (cross-provider)
 */

import { PROVIDERS } from "../../providers/index.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

import { bindResponseBody } from "../../utils/responseLifecycle.js";

export function cancelResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Body already consumed. */ }
}

// usage endpoints: single source from registry transport.usage
export const U = (id) => PROVIDERS[id]?.usage || {};

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
export function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // Unix timestamps from provider APIs may be seconds or milliseconds.
    if (typeof resetValue === 'number') {
      return new Date(resetValue < 1e12 ? resetValue * 1000 : resetValue).toISOString();
    }

    // If it's a numeric string, treat it like a Unix timestamp too.
    if (typeof resetValue === 'string') {
      if (/^\d+$/.test(resetValue)) {
        const timestamp = Number(resetValue);
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

export function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeCloudCodeProjectId(project) {
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object" && typeof project.id === "string") {
    return project.id.trim() || null;
  }
  return null;
}

export async function fetchWithTimeout(url, opts = {}, ms = 10000, proxyOptions = null) {
  const externalSignal = opts?.signal;
  if (externalSignal?.aborted) {
    throw (externalSignal.reason || new Error("Operation aborted"));
  }

  const controller = new AbortController();
  let finalized = false;
  let abortFetch;
  const abortPromise = new Promise((_, reject) => {
    abortFetch = () => reject(controller.signal.reason);
  });
  abortPromise.catch(() => {});
  const cleanup = () => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    controller.signal.removeEventListener("abort", abortFetch);
  };
  const onExternalAbort = () => controller.abort(externalSignal.reason);
  const timeoutId = setTimeout(() => controller.abort(new Error(`Timeout after ${ms}ms`)), ms);
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let fetchPromise;
  controller.signal.addEventListener("abort", abortFetch, { once: true });
  try {
    fetchPromise = Promise.resolve(proxyAwareFetch(url, { ...opts, signal: controller.signal }, proxyOptions));
    fetchPromise.catch(() => {});
    const response = await Promise.race([fetchPromise, abortPromise]);
    controller.signal.removeEventListener("abort", abortFetch);
    if (controller.signal.aborted) {
      cancelResponseBody(response);
      throw controller.signal.reason;
    }
    return bindResponseBody(response, { signal: controller.signal, onFinalize: cleanup });
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    if (controller.signal.aborted) {
      fetchPromise?.then(cancelResponseBody, () => {});
    }
  }
}
