import { NextResponse } from "next/server";
import { authorizeChatGptWebRuntimeAdmin } from "@/dashboardGuard";
import { requestChatGptWebRuntimeAdmin } from "open-sse/services/chatgptWebRuntimeClient.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = new Set(["unconfigured", "login_required", "probing", "ready", "draining", "waiting_for_chatgpt_tool_approval", "error"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const DEFAULT_SETTINGS = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const ERROR_MESSAGES = {
  revision_conflict: "Settings changed elsewhere. Refresh the profile and apply your changes again.",
  profile_revision_conflict: "Settings changed elsewhere. Refresh the profile and apply your changes again.",
  profile_active: "Wait for all profile turns to settle before changing settings, logging in, or restarting.",
  connector_unavailable: "Full mode requires an operator-provisioned, verified Native2 connector and tunnel.",
  action_not_allowed: "The account or workspace does not permit this connector action.",
  login_required: "Sign in using the private browser, then choose Finish Sign In to verify your account.",
  login_not_found: "The private viewer lease has ended.",
  profile_not_found: "Create this runtime profile first.",
  profile_exists: "This runtime profile already exists. Refresh to manage it.",
  viewer_busy: "Another private viewer lease is active. Wait for it to expire.",
  private_viewer_unavailable: "The runtime private VNC viewer is unavailable. Contact the operator.",
  runtime_draining: "The runtime is fenced for maintenance. Try again after the operator resumes it.",
  waiting_for_chatgpt_tool_approval: "Open the private browser and approve the active connector prompt once.",
};

function fail(status, code, message) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, required, optional = []) {
  return record(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function settings(value, partial = false) {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw new Error("invalid_settings");
  const result = partial ? {} : { ...DEFAULT_SETTINGS };
  for (const [key, item] of Object.entries(value)) {
    if (key === "mode" ? !["browser-only", "full"].includes(item) : key === "connectorName" ? item !== "Codex Native2" : typeof item !== "boolean") throw new Error("invalid_settings");
    result[key] = item;
  }
  return result;
}
async function readJson(input, limit) {
  if (Number(input.headers.get("content-length")) > limit) throw new Error("body_too_large");
  const reader = input.body?.getReader();
  if (!reader) throw new Error("invalid_json");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function diagnostic(value) {
  const code = typeof value === "string" ? value : value?.code;
  return code ? { code: Object.hasOwn(ERROR_MESSAGES, code) ? code : "runtime_error", message: Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : "Runtime diagnostics report a problem. Check the private operator logs." } : null;
}
function profile(value) {
  if (!record(value) || typeof value.profileId !== "string" || !PROFILE_ID.test(value.profileId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !STATES.has(value.state) || !Array.isArray(value.models) || value.models.length > 128 || !Number.isInteger(value.activeTurns) || value.activeTurns < 0 || value.activeTurns > 5 || value.maxConcurrency !== 5) throw new Error("invalid_runtime_response");
  return { profileId: value.profileId, revision: value.revision, state: value.state, settings: settings(value.settings), activeTurns: value.activeTurns, maxConcurrency: 5, connectorReady: value.connectorReady === true, lastError: diagnostic(value.lastError), models: value.models.map(model => {
    if (!record(model) || typeof model.id !== "string" || !/^chatgpt-web\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model.id) || model.id.length > 140 || !Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length > 6 || model.supported_reasoning_levels.some(effort => !EFFORTS.has(effort))) throw new Error("invalid_runtime_response");
    return { id: model.id, display_name: typeof model.display_name === "string" ? model.display_name.slice(0, 160) : model.id, supported_reasoning_levels: [...new Set(model.supported_reasoning_levels)], default_reasoning_level: EFFORTS.has(model.default_reasoning_level) ? model.default_reasoning_level : null, model_family: ["5.6", "6"].includes(model.model_family) ? model.model_family : null, legacy: model.legacy === true, context_window: Number.isSafeInteger(model.context_window) && model.context_window > 0 ? model.context_window : null };
  }) };
}
function viewer(value, session = false) {
  if (!record(value) || typeof value.loginId !== "string" || !LOGIN_ID.test(value.loginId) || !PROFILE_ID.test(value.profileId || "") || typeof value.manualLogin !== "boolean" || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || !["waiting", "completed", "expired", "closed", "error"].includes(value.state)) throw new Error("invalid_runtime_response");
  const result = { loginId: value.loginId, profileId: value.profileId, expiresAt: value.expiresAt, state: value.state, manualLogin: value.manualLogin };
  if (session) {
    if (value.state !== "waiting" || Date.parse(value.expiresAt) <= Date.now() || typeof value.password !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.password)) throw new Error("invalid_runtime_response");
    result.password = value.password;
  }
  return result;
}
function output(action, method, data) {
  if (action === "profiles" && method === "GET") {
    if (!record(data) || !Array.isArray(data.profiles) || data.profiles.length > 128) throw new Error("invalid_runtime_response");
    return { profiles: data.profiles.map(profile) };
  }
  if (action === "profiles" || action.startsWith("profiles/") || action === "browser/restart") return profile(data);
  if (["login/start", "login/complete", "login/status", "login/session", "login/close", "browser/view"].includes(action)) return viewer(data, action === "login/session");
  if (action === "smoke") {
    return { profile: profile(data.profile), outerToolE2eVerified: data.outerToolE2eVerified === true, message: data.outerToolE2eVerified === true ? "Companion-observed tool smoke verified." : "Runtime diagnostic completed. This is not proof of local Codex tool execution; the companion staging gate is still required." };
  }
  if (action === "interrupt-turn") {
    if (!Number.isSafeInteger(data.cancelled) || data.cancelled < 0) throw new Error("invalid_runtime_response");
    return { cancelled: data.cancelled };
  }
  if (action === "resume") return { resumed: data.resumed === true };
  if (action === "drain" || action === "quiesce") {
    if (!record(data) || typeof data.operationId !== "string" || !ID.test(data.operationId) || !["draining", "quiesced"].includes(data.state)) throw new Error("invalid_runtime_response");
    return { operationId: data.operationId, state: data.state };
  }
  throw new Error("invalid_runtime_response");
}

async function handle(request, context) {
  if (!await authorizeChatGptWebRuntimeAdmin(request)) return fail(401, "dashboard_auth_required", "Dashboard authentication required.");
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    let originUrl;
    try { originUrl = origin ? new URL(origin) : null; } catch { return fail(403, "same_origin_required", "Runtime changes must originate from this dashboard."); }
    // Next may construct its internal request URL with localhost behind a loopback bind;
    // Host remains the browser-facing origin already constrained by the dashboard guard.
    if (!originUrl || !["http:", "https:"].includes(originUrl.protocol) || originUrl.host !== request.headers.get("host")
      || originUrl.username || originUrl.password || originUrl.pathname !== "/" || originUrl.search || originUrl.hash
      || (fetchSite && fetchSite !== "same-origin")) return fail(403, "same_origin_required", "Runtime changes must originate from this dashboard.");
  }
  const { action: segments } = await context.params;
  if (!Array.isArray(segments) || segments.length > 2) return fail(404, "unknown_action", "Unknown runtime action.");
  const action = segments.join("/");
  const allowed = { profiles: ["GET", "POST"], "login/start": ["POST"], "login/complete": ["POST"], "login/status": ["GET"], "login/session": ["GET"], "login/close": ["POST"], "browser/view": ["POST"], "browser/restart": ["POST"], smoke: ["POST"], drain: ["POST"], quiesce: ["POST"], resume: ["POST"], "interrupt-turn": ["POST"] };
  const patch = segments.length === 2 && segments[0] === "profiles" && PROFILE_ID.test(segments[1]);
  const methods = patch ? ["PATCH"] : Object.hasOwn(allowed, action) ? allowed[action] : null;
  if (!methods) return fail(404, "unknown_action", "Unknown runtime action.");
  if (!methods.includes(request.method)) return fail(405, "method_not_allowed", "Method not allowed for this runtime action.");
  const url = new URL(request.url);
  let suffix = ""; let body;
  try {
    if (["login/status", "login/session"].includes(action)) {
      const loginIds = url.searchParams.getAll("loginId");
      if ([...url.searchParams.keys()].some(key => key !== "loginId") || loginIds.length !== 1 || !LOGIN_ID.test(loginIds[0])) throw new Error("invalid_query");
      suffix = `?loginId=${encodeURIComponent(loginIds[0])}`;
    } else if (url.search) throw new Error("invalid_query");
    if (request.method !== "GET") {
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return fail(415, "json_required", "JSON required.");
      body = await readJson(request, 8192);
      if (patch) {
        if (!exactKeys(body, ["revision", "settings"]) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error("invalid_revision");
        body = { revision: body.revision, settings: settings(body.settings, true) };
      } else if (["drain", "quiesce", "resume"].includes(action)) {
        if (!exactKeys(body, ["operationId"]) || typeof body.operationId !== "string" || !ID.test(body.operationId)) throw new Error("invalid_operation");
      } else if (action === "interrupt-turn") {
        if (!exactKeys(body, ["clientId", "threadId", "turnId"]) || [body.clientId, body.threadId, body.turnId].some(id => typeof id !== "string" || !ID.test(id))) throw new Error("invalid_identity");
      } else if (["login/close", "login/complete"].includes(action)) {
        if (!exactKeys(body, ["loginId"]) || typeof body.loginId !== "string" || !LOGIN_ID.test(body.loginId)) throw new Error("invalid_login");
      } else {
        const extra = action === "smoke" ? ["kind"] : [];
        if (!exactKeys(body, ["profileId", ...extra], action === "browser/view" ? ["turnId"] : []) || typeof body.profileId !== "string" || !PROFILE_ID.test(body.profileId)) throw new Error("invalid_profile");
        if (action === "smoke" && !["browser", "harness"].includes(body.kind)) throw new Error("invalid_smoke");
        if (body.turnId !== undefined && (typeof body.turnId !== "string" || !ID.test(body.turnId))) throw new Error("invalid_identity");
      }
    }
  } catch (error) {
    return fail(error.message === "body_too_large" ? 413 : 400, "invalid_admin_request", "Invalid runtime action parameters.");
  }
  try {
    const response = await requestChatGptWebRuntimeAdmin(`/admin/${action}${suffix}`, { method: request.method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: request.signal }, { timeoutMs: ["smoke", "login/complete"].includes(action) ? 120000 : 70000 });
    const data = await readJson(response, 262144);
    if (!response.ok) {
      const code = typeof data?.error?.code === "string" && Object.hasOwn(ERROR_MESSAGES, data.error.code) ? data.error.code : "runtime_error";
      const message = response.status === 409 && code === "runtime_error" ? "Profile state changed or is busy. Refresh before trying again." : ERROR_MESSAGES[code] || "Runtime action failed. Check the private operator diagnostics.";
      return fail(response.status >= 400 && response.status <= 599 ? response.status : 502, code, message);
    }
    const result = output(action, request.method, data);
    if (["login/status", "login/session", "login/close", "login/complete"].includes(action) && result.loginId !== (body?.loginId || url.searchParams.get("loginId"))) throw new Error("invalid_runtime_response");
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(502, "runtime_unavailable", "Runtime unavailable or returned invalid diagnostics. No action was retried.");
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
