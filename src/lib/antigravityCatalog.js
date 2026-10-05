import { resolveAntigravityModels } from "open-sse/services/antigravityModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { mergeAntigravityModelLists } from "@/lib/providerNormalization";

/**
 * Resolves effective Antigravity models union across active connections.
 * Applies per-connection enabledModels filtering before merging.
 *
 * @param {Array} connections - Connection list (or subset).
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @param {AbortSignal} [options.signal]
 * @param {Object} [options.log=console]
 * @returns {Promise<{ resolved: boolean, models: Array }>}
 */
export async function resolveEffectiveAntigravityCatalog(connections, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) {
    throw (signal.reason || new DOMException("This operation was aborted", "AbortError"));
  }

  const candidates = Array.isArray(connections)
    ? connections.filter((c) => c && c.provider === "antigravity" && c.isActive !== false)
    : [];

  if (candidates.length === 0) {
    return { resolved: false, models: [] };
  }

  const log = options.log || console;
  let anySuccess = false;
  const successfulLists = [];

  for (const connection of candidates) {
    if (signal?.aborted) {
      throw (signal.reason || new DOMException("This operation was aborted", "AbortError"));
    }

    try {
      const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const enabled = connection.providerSpecificData?.enabledModels;

      const res = await resolveAntigravityModels(connection, {
        proxyOptions,
        forceRefresh: Boolean(options.forceRefresh),
        signal,
        log,
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });

      if (res && res.resolved === true) {
        anySuccess = true;
        const list = Array.isArray(res.models) ? res.models : [];
        const filtered = (Array.isArray(enabled) && enabled.length > 0)
          ? list.filter((m) => enabled.includes(m.id))
          : list;
        successfulLists.push(filtered);
      }
    } catch (err) {
      if (signal?.aborted) throw (signal.reason || err);
      log.warn?.("AG_CATALOG", `Failed resolving Antigravity models for connection ${connection.id}: ${err?.message || err}`);
    }
  }

  if (anySuccess) {
    return {
      resolved: true,
      models: mergeAntigravityModelLists(successfulLists),
    };
  }

  // All connections failed: return legacy static fallback filtered per-connection
  const fallbackLists = candidates.map((connection) => {
    const fallback = getModelsByProviderId("antigravity").filter((m) => m.kind !== "image");
    const enabled = connection.providerSpecificData?.enabledModels;
    return (Array.isArray(enabled) && enabled.length > 0)
      ? fallback.filter((m) => enabled.includes(m.id))
      : fallback;
  });

  return {
    resolved: false,
    models: mergeAntigravityModelLists(fallbackLists),
  };
}
