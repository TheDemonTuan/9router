import { collectChatGptSession } from "./session.js";
import { MAX_SESSION_TRANSFER_BYTES, SessionTransferError } from "../../services/chatgpt-web-runtime/session-transfer.js";

// Serialized into an isolated world. All authority comes from the actual document
// and the authenticated read, never from a marker-provided URL or endpoint.
export async function inspectDashboard({ expected = null, origin = null, checkProfiles = false } = {}) {
  const failure = (code = "session_target_unavailable", status = 409) => ({ ok: false, status, code });
  if (window !== window.top || location.pathname !== "/dashboard/providers/chatgpt-web"
    || !(location.protocol === "https:" || location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname.toLowerCase()))
    || origin !== null && location.origin !== origin) return failure();
  const markers = document.querySelectorAll("[data-9router-chatgpt-session-target]");
  if (markers.length !== 1) return failure();
  const marker = markers[0];
  if (marker.getAttribute("data-9router-chatgpt-session-consumed") === "true") return failure("session_import_in_progress");
  const inputs = marker.querySelectorAll("input[data-9router-chatgpt-session-file]");
  if (inputs.length !== 1 || inputs[0].type !== "file" || inputs[0].disabled) return failure();
  let target;
  try { target = JSON.parse(marker.getAttribute("data-9router-chatgpt-session-target")); } catch { return failure(); }
  if (!target || Object.keys(target).sort().join(",") !== "attemptId,connectionName,expiresAt,profileId,revision,version"
    || target.version !== 1 || typeof target.attemptId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.attemptId)
    || typeof target.profileId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(target.profileId)
    || !Number.isSafeInteger(target.revision) || target.revision < 1
    || typeof target.connectionName !== "string" || target.connectionName.length > 1024
    || typeof target.expiresAt !== "string" || !Number.isFinite(Date.parse(target.expiresAt))) return failure();
  if (Date.parse(target.expiresAt) <= Date.now()) return failure("session_target_expired");
  if (Date.parse(target.expiresAt) > Date.now() + 301000) return failure();
  if (expected && ["version", "attemptId", "profileId", "revision", "connectionName", "expiresAt"].some(key => target[key] !== expected[key])) return failure();
  if (checkProfiles) {
    try {
      const response = await fetch("/api/providers/chatgpt-web/runtime/profiles", { credentials: "same-origin", cache: "no-store", redirect: "error" });
      if ([401, 403].includes(response.status)) return failure("dashboard_auth_required", 401);
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) return failure();
      const data = await response.json();
      const profile = data.profiles?.find(item => item.profileId === target.profileId);
      if (!profile) return failure();
      if (profile.revision !== target.revision) return failure("profile_revision_conflict");
      if (profile.activeTurns !== 0 || ["probing", "draining"].includes(profile.state)) return failure();
      // The read may have taken long enough for navigation, expiry or UI changes.
      if (location.origin !== (origin || location.origin) || location.pathname !== "/dashboard/providers/chatgpt-web" || !marker.isConnected
        || document.querySelectorAll("[data-9router-chatgpt-session-target]").length !== 1
        || marker.querySelectorAll("input[data-9router-chatgpt-session-file]").length !== 1 || !inputs[0].isConnected
        || marker.getAttribute("data-9router-chatgpt-session-target") !== JSON.stringify(target)
        || inputs[0].disabled || marker.getAttribute("data-9router-chatgpt-session-consumed") === "true") return failure();
      if (Date.parse(target.expiresAt) <= Date.now()) return failure("session_target_expired");
    } catch { return failure(); }
  }
  return { ok: true, origin: location.origin, target };
}

// The File is the sole credential handoff. CustomEvents contain metadata only.
export function handoffSession({ target, session, origin }) {
  return new Promise(resolve => {
    const unknown = { ok: false, status: 0, code: "import_result_unknown" };
    const unavailable = { ok: false, status: 409, code: "session_target_unavailable" };
    let timer, input, submitted = false;
    const finish = outcome => {
      clearTimeout(timer);
      document.removeEventListener("9router:chatgpt-session-import-result", result);
      window.removeEventListener("pagehide", lost);
      resolve(outcome);
    };
    const lost = () => finish(unknown);
    const result = event => {
      const value = event.detail;
      if (!value || value.attemptId !== target.attemptId || value.profileId !== target.profileId || value.revision !== target.revision) return;
      if (value.version !== 1 || typeof value.ok !== "boolean" || !Number.isInteger(value.status) || value.status < 0 || value.status > 599
        || !(value.code === null && value.ok || !value.ok && typeof value.code === "string" && /^[a-z0-9_]{1,64}$/.test(value.code))) { finish(unknown); return; }
      finish({ ok: value.ok, status: value.status, code: value.code });
    };
    try {
      const markers = document.querySelectorAll("[data-9router-chatgpt-session-target]");
      if (window !== window.top || location.origin !== origin || location.pathname !== "/dashboard/providers/chatgpt-web" || markers.length !== 1) return finish(unavailable);
      const marker = markers[0];
      const actual = JSON.parse(marker.getAttribute("data-9router-chatgpt-session-target"));
      if (["version", "attemptId", "profileId", "revision", "connectionName", "expiresAt"].some(key => actual[key] !== target[key])) return finish(unavailable);
      if (Date.parse(target.expiresAt) <= Date.now()) return finish({ ok: false, status: 409, code: "session_target_expired" });
      if (marker.getAttribute("data-9router-chatgpt-session-consumed") === "true") return finish({ ok: false, status: 409, code: "session_import_in_progress" });
      const inputs = marker.querySelectorAll("input[data-9router-chatgpt-session-file]");
      if (inputs.length !== 1 || inputs[0].type !== "file" || inputs[0].disabled) return finish(unavailable);
      input = inputs[0];
      document.addEventListener("9router:chatgpt-session-import-result", result);
      window.addEventListener("pagehide", lost, { once: true });
      timer = setTimeout(() => finish(unknown), 130000);
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(session)], "chatgpt-session.json", { type: "application/json" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      document.dispatchEvent(new CustomEvent("9router:chatgpt-session-import-request", { detail: { version: 1, attemptId: target.attemptId, profileId: target.profileId, revision: target.revision } }));
      submitted = true;
    } catch {
      if (!submitted && input?.isConnected) { input.value = ""; input.dispatchEvent(new Event("change", { bubbles: true })); }
      finish(unknown);
    } finally { session = null; }
  });
}

const inFlight = new Set();
async function connect(message) {
  const unavailable = { ok: false, status: 409, code: "session_target_unavailable" };
  if (!Number.isInteger(message.tabId) || message.tabId < 0 || typeof message.documentId !== "string" || !message.documentId
    || typeof message.origin !== "string" || !message.target || typeof message.target.attemptId !== "string") return unavailable;
  const key = JSON.stringify([message.tabId, message.documentId, message.target.attemptId]);
  if (inFlight.has(key)) return { ok: false, status: 409, code: "session_import_in_progress" };
  inFlight.add(key);
  let session;
  let handoffStarted = false;
  try {
    const target = { tabId: message.tabId, documentIds: [message.documentId] };
    const inspect = async () => {
      const results = await chrome.scripting.executeScript({ target, world: "ISOLATED", func: inspectDashboard, args: [{ expected: message.target, origin: message.origin, checkProfiles: true }] });
      if (results.length !== 1 || results[0].frameId !== 0 || results[0].documentId !== message.documentId) return unavailable;
      return results[0].result || unavailable;
    };
    let checked = await inspect();
    if (!checked.ok) return checked;
    session = await collectChatGptSession();
    if (new TextEncoder().encode(JSON.stringify({ profileId: message.target.profileId, revision: message.target.revision, session })).byteLength > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
    checked = await inspect();
    if (!checked.ok) return checked;
    handoffStarted = true;
    const results = await chrome.scripting.executeScript({ target, world: "ISOLATED", func: handoffSession, args: [{ target: message.target, session, origin: message.origin }] });
    return results.length === 1 && results[0].documentId === message.documentId && results[0].result
      ? results[0].result : { ok: false, status: 0, code: "import_result_unknown" };
  } catch (error) {
    if (error instanceof SessionTransferError) return { ok: false, status: error.status, code: error.code };
    // Once handoff started, an interrupted observer must never suggest a replay.
    return handoffStarted ? { ok: false, status: 0, code: "import_result_unknown" } : unavailable;
  } finally { session = null; inFlight.delete(key); }
}

// Also imported by the popup to bundle the serialized probe; only the worker
// owns messages, cookie collection for Direct, and the single-flight lifetime.
if (typeof document === "undefined") chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || sender.tab
    || message?.type !== "connect-chatgpt-session") return false;
  void connect(message).then(sendResponse, () => sendResponse({ ok: false, status: 0, code: "import_result_unknown" }));
  return true;
});
