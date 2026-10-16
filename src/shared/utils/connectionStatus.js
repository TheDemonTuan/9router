export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

export function isChatGptWebProfileReady(profile) {
  return profile?.state === "ready" && Array.isArray(profile.models) && profile.models.length > 0;
}

export function getChatGptWebProfileNotice(profile) {
  if (isChatGptWebProfileReady(profile)) return "Connected and ready.";
  if (profile?.lastError?.message) return profile.lastError.message;
  if (profile?.state === "ready") return "No verified models are available. Open Browser, check the model picker, then choose Finish Sign In again.";
  return profile ? `Session is ${profile.state.replaceAll("_", " ")}. Check Advanced for diagnostics.`
    : "The runtime profile is unavailable. Refresh or contact the operator.";
}

export function getChatGptWebRuntimeStatus(state) {
  if (["ready", "waiting_for_chatgpt_tool_approval"].includes(state)) return "active";
  return state === "unconfigured" ? "login_required" : state || "error";
}

/**
 * Identify providers that have connections configured, but ALL of them are deactivated (isActive === false).
 * Providers with 0 connections (e.g. keyless local nodes) are NOT considered deactivated.
 * @param {Array<{provider: string, isActive?: boolean}>} connections
 * @returns {Set<string>} Set of deactivated provider IDs
 */
export function getDeactivatedProviderIds(connections) {
  const byProvider = {};
  for (const c of connections || []) {
    if (!c?.provider) continue;
    if (!byProvider[c.provider]) byProvider[c.provider] = { total: 0, active: 0 };
    byProvider[c.provider].total += 1;
    if (c.isActive !== false) byProvider[c.provider].active += 1;
  }
  const deactivated = new Set();
  for (const [provider, stats] of Object.entries(byProvider)) {
    if (stats.total > 0 && stats.active === 0) {
      deactivated.add(provider);
    }
  }
  return deactivated;
}
