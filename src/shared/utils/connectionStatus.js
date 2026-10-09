export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

export function isChatGptWebProfileReady(profile) {
  return profile?.state === "ready" && profile.catalog_verified !== false && Array.isArray(profile.models) && profile.models.length > 0;
}

export function getChatGptWebProfileNotice(profile) {
  if (profile?.state === "session_unverified") return "Session not checked since restart · Verify saved session";
  if (profile?.browser_state === "waking" && !["error", "login_required", "draining"].includes(profile.state)) return "Waking browser · checking saved session";
  if (isChatGptWebProfileReady(profile) && profile.browser_state === "sleeping") return "Sleeping · wakes on request";
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
