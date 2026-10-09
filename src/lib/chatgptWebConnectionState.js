import { requestChatGptWebRuntimeAdmin } from "open-sse/services/chatgptWebRuntimeClient.js";

export const CHATGPT_WEB_RUNTIME_ERROR_MESSAGES = {
  revision_conflict: "Settings changed elsewhere. Refresh the profile and apply your changes again.",
  profile_revision_conflict: "Settings changed elsewhere. Refresh the profile and apply your changes again.",
  profile_active: "Wait for all profile turns to settle before changing settings, logging in, or restarting.",
  connector_unavailable: "Create and install Codex Native2 in the ChatGPT workspace, then verify the connector.",
  action_not_allowed: "The account or workspace does not permit this connector action.",
  harness_compatibility_unverified: "This runtime build has not passed harness compatibility checks.",
  harness_config_invalid: "Enter the complete Tunnel ID supplied by OpenAI Platform.",
  harness_key_invalid: "Use a single-line runtime API key, not an admin key.",
  harness_key_required: "Enter a runtime API key when saving the tunnel for the first time.",
  harness_config_conflict: "Tunnel configuration changed elsewhere. Refresh before trying again.",
  harness_operator_managed: "This profile uses operator-managed tunnel configuration. Ask the operator to migrate it before changing it here.",
  harness_config_missing: "Save a Tunnel ID and runtime API key before starting the tunnel.",
  harness_storage_invalid: "Runtime secret storage is unavailable. Contact the operator; no secret was returned.",
  harness_config_required: "Save a Tunnel ID and runtime API key before starting the tunnel.",
  harness_config_revision_conflict: "Tunnel configuration changed elsewhere. Refresh before trying again.",
  harness_tunnel_id_unsupported: "This pinned runtime tunnel client does not support namespaced Tunnel IDs; an operator-reviewed targeted runtime upgrade is required.",
  harness_unavailable: "Coding tools require a ready tunnel and verified Codex Native2 connector.",
  profile_not_prepared: "Session not checked since restart. Verify the saved session or send a request to prepare it.",
  runtime_capacity_exceeded: "Runtime capacity is full. Wait for active work to settle before submitting again.",
  login_required: "Sign in using the private browser, then choose Finish Sign In to verify your account.",
  profile_probe_failed: "ChatGPT verification could not inspect the chat interface. Open Browser, wait for the page to finish loading, then choose Finish Sign In again.",
  model_version_unavailable: "ChatGPT sign-in was detected, but no supported model could be verified. Open Browser, check the model picker, then choose Finish Sign In again.",
  login_not_found: "The private viewer lease has ended.",
  profile_not_found: "Create this runtime profile first.",
  profile_exists: "This runtime profile already exists. Refresh to manage it.",
  viewer_busy: "Another private viewer lease is active. Wait for it to expire.",
  private_viewer_unavailable: "The runtime private VNC viewer is unavailable. Contact the operator.",
  runtime_draining: "The runtime is fenced for maintenance. Try again after the operator resumes it.",
  waiting_for_chatgpt_tool_approval: "Open the private browser and approve the active connector prompt once.",
  invalid_session_transfer: "Invalid ChatGPT session file. Export a new file with the 9Router Chrome exporter.",
  session_transfer_expired: "The exported cookies have expired. Sign in in Chrome and export again.",
  session_transfer_too_large: "The session file exceeds the 256 KiB limit.",
  session_account_mismatch: "The imported session belongs to another ChatGPT account. Use a new connection; the existing account was not replaced.",
  session_restore_failed: "The previous browser session could not be restored. Do not retry the import; contact the operator.",
  secure_origin_required: "Credential input requires HTTPS except for socket-trusted loopback development.",
  runtime_upgrade_required: "This action requires an updated ChatGPT Web runtime. Contact the operator.",
  runtime_unavailable: "Runtime unavailable. Refresh connections after the runtime recovers.",
};
const STATES = new Set(["unconfigured", "session_unverified", "login_required", "probing", "ready", "draining", "waiting_for_chatgpt_tool_approval", "error"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MODEL_ID = /^chatgpt-web\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const record = value => value && typeof value === "object" && !Array.isArray(value);

// Older runtimes omit these fields. Absence is not evidence of sleep or failed login.
export function parseChatGptWebLifecycleState(value) {
  const result = {};
  if (Object.hasOwn(value, "browser_state")) {
    if (!["sleeping", "waking", "awake", "error"].includes(value.browser_state)) throw new Error("Invalid runtime browser state");
    result.browser_state = value.browser_state;
  }
  if (Object.hasOwn(value, "catalog_verified")) {
    if (typeof value.catalog_verified !== "boolean") throw new Error("Invalid runtime catalog evidence");
    result.catalog_verified = value.catalog_verified;
  }
  return result;
}

export function chatGptWebDiagnostic(value) {
  const code = typeof value === "string" ? value : value?.code;
  if (!code) return null;
  return typeof code === "string" && Object.hasOwn(CHATGPT_WEB_RUNTIME_ERROR_MESSAGES, code)
    ? { code, message: CHATGPT_WEB_RUNTIME_ERROR_MESSAGES[code] }
    : { code: "runtime_error", message: "Runtime diagnostics report a problem. Check the private operator logs." };
}

export function chatGptWebUnavailableProfileState() {
  return { state: "error", mode: null, lastError: chatGptWebDiagnostic("runtime_unavailable") };
}

// This is a read-only readiness snapshot, not a session probe or an inference request.
export async function getChatGptWebProfileStates({ signal } = {}) {
  try {
    const response = await requestChatGptWebRuntimeAdmin("/admin/profiles", { signal }, { timeoutMs: 3000 });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(data) || data.protocolVersion !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 128) throw new Error();
    const states = new Map();
    for (const item of data.profiles) {
      if (!record(item) || typeof item.profileId !== "string" || !PROFILE_ID.test(item.profileId) || states.has(item.profileId)
        || !STATES.has(item.state) || !record(item.settings) || !["browser-only", "full"].includes(item.settings.mode)
        || !Array.isArray(item.models) || item.models.length > 128) throw new Error();
      const ids = new Set();
      const models = item.models.map(model => {
        if (!record(model) || typeof model.id !== "string" || model.id.length > 140 || !MODEL_ID.test(model.id) || ids.has(model.id)
          || !Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.length || model.supported_reasoning_levels.length > 6
          || model.supported_reasoning_levels.some(effort => !EFFORTS.has(effort))
          || new Set(model.supported_reasoning_levels).size !== model.supported_reasoning_levels.length
          || !model.supported_reasoning_levels.includes(model.default_reasoning_level)) throw new Error();
        ids.add(model.id);
        const capabilities = {};
        for (const key of ["generic_tools", "generic_responses"]) if (typeof model.capabilities?.[key] === "boolean") capabilities[key] = model.capabilities[key];
        return { id: model.id, supported_reasoning_levels: [...model.supported_reasoning_levels], default_reasoning_level: model.default_reasoning_level, ...(Object.keys(capabilities).length ? { capabilities } : {}) };
      });
      states.set(item.profileId, { profileId: item.profileId, state: item.state, mode: item.settings.mode, models,
        ...parseChatGptWebLifecycleState(item), lastError: chatGptWebDiagnostic(item.lastError) });
    }
    return states;
  } catch {
    const error = new Error(CHATGPT_WEB_RUNTIME_ERROR_MESSAGES.runtime_unavailable);
    error.code = "runtime_unavailable";
    throw error;
  }
}

export function applyChatGptWebProfileState(connection, profile) {
  let state = profile?.state || "unconfigured";
  let testStatus = state;
  let lastError = chatGptWebDiagnostic(profile?.lastError);
  if (!profile || state === "unconfigured") {
    testStatus = "login_required";
    lastError = chatGptWebDiagnostic("profile_not_found");
  } else if (["ready", "waiting_for_chatgpt_tool_approval"].includes(state)) {
    if (profile.models?.length) {
      testStatus = "active";
      lastError = state === "ready" ? null : chatGptWebDiagnostic("waiting_for_chatgpt_tool_approval");
    } else {
      state = "error"; testStatus = "error";
      lastError = chatGptWebDiagnostic("model_version_unavailable");
    }
  } else if (state === "session_unverified") {
    lastError = null;
  } else if (state === "login_required") {
    lastError = chatGptWebDiagnostic("login_required");
  } else if (state === "draining") {
    lastError = chatGptWebDiagnostic("runtime_draining");
  } else if (state === "error") {
    lastError ||= chatGptWebDiagnostic("runtime_error");
  }
  const message = lastError?.message || null;
  const previousCode = connection.chatGptWebRuntime?.lastError?.code;
  const unchangedError = connection.lastError === message && (!previousCode || previousCode === lastError?.code);
  return {
    ...connection,
    testStatus,
    lastError: message,
    lastErrorAt: !lastError ? null : unchangedError ? (connection.lastErrorAt || null) : (connection.updatedAt || connection.createdAt || null),
    chatGptWebRuntime: { state, mode: profile?.mode || profile?.settings?.mode || null,
      ...(profile ? parseChatGptWebLifecycleState(profile) : {}), lastError },
  };
}

// The callback runs inside the repository transaction. Never persist a stale selector snapshot.
export function chatGptWebConnectionStatusUpdate(current, snapshot, profile) {
  if (!current || current.provider !== "chatgpt-web" || current.updatedAt !== snapshot.updatedAt
    || current.providerSpecificData?.profileId !== snapshot.providerSpecificData?.profileId) return null;
  const mapped = applyChatGptWebProfileState(current, profile);
  if (["testStatus", "lastError", "lastErrorAt"].every(key => (current[key] ?? null) === (mapped[key] ?? null))) return null;
  if (mapped.lastError && (current.lastError !== mapped.lastError || (current.chatGptWebRuntime?.lastError?.code && current.chatGptWebRuntime.lastError.code !== mapped.chatGptWebRuntime.lastError.code))) {
    mapped.lastErrorAt = new Date().toISOString();
  }
  return { testStatus: mapped.testStatus, lastError: mapped.lastError, lastErrorAt: mapped.lastErrorAt };
}
