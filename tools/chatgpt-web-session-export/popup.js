import { collectChatGptSession } from "./session.js";
import { inspectDashboard } from "./background.js";

const connectButton = document.getElementById("connect");
const checkButton = document.getElementById("check");
const copyButton = document.getElementById("copy");
const exportButton = document.getElementById("export");
const status = document.getElementById("status");
const targetHelp = document.getElementById("target-help");
let consentTarget = null;
let busy = false;
let closed = false;
let sequence = 0;
let probeInFlight = false;
let probePending = false;
let refreshTimer, expiryTimer, focusTimer;
// An attempted snapshot must never be re-enabled by a delayed dashboard update.
const attemptedTargets = new Set();
const errors = {
  session_transfer_expired: "No valid unexpired ChatGPT cookies were found. Sign in to ChatGPT in this Chrome profile, then try again.",
  session_transfer_too_large: "The session exceeds the 256 KiB limit. Nothing was sent or exported.",
  invalid_session_transfer: "The session cannot be transferred. Sign in to ChatGPT in this Chrome profile and check the helper's site permission.",
  dashboard_tab_required: "Open this helper on the 9Router dashboard tab, not on chatgpt.com.",
  secure_origin_required: "Open your trusted dashboard over HTTPS (or trusted localhost), then check again.",
  session_assistant_required: "Open the connection's Chrome extension panel in the 9Router dashboard, then check again.",
  session_target_unprepared: "Choose Prepare connection in the dashboard. This helper will check again while it is open.",
  session_target_ambiguous: "More than one connection target is present. Keep one session assistant open, then check again.",
  session_target_blocked: "The dashboard cannot prepare this connection yet. Check the session assistant for the next action.",
  session_target_expired: "The connection target expired. Return to 9Router and choose Prepare connection.",
  profile_revision_conflict: "The profile changed. Refresh 9Router and choose Prepare connection; the session was not replayed.",
  dashboard_auth_required: "Sign in to the 9Router dashboard, then prepare the connection again.",
  session_import_in_progress: "This connection attempt was already used or is in progress. Check its status in 9Router; do not resend.",
  import_result_unknown: "The import result is unknown. Check the connection in 9Router and use Verify saved session. Nothing was replayed.",
  session_target_unavailable: "The target changed or is unavailable. Return to the session assistant in your trusted dashboard and choose Prepare connection.",
};
const blockedReasons = {
  loading: "Wait for the connection to load in the dashboard.",
  active_turns: "Wait for active requests to finish, then choose Prepare connection.",
  viewer_waiting: "Wait for the private browser to close, then choose Prepare connection.",
  viewer_open: "Close the private browser, then choose Prepare connection.",
  draining: "Wait for the runtime to finish draining, then choose Prepare connection.",
  probing: "Wait for session verification to finish, then choose Prepare connection.",
  insecure_origin: errors.secure_origin_required,
  unsaved_changes: "Save or discard connection changes in the dashboard, then choose Prepare connection.",
  profile_mismatch: "Select the saved connection's profile in the dashboard, then choose Prepare connection.",
  expired: errors.session_target_expired,
  consumed: errors.session_import_in_progress,
};
function safeError(code, reason) {
  return (code === "session_target_blocked" && blockedReasons[reason]) || errors[code]
    || (/^[a-z0-9_]{1,64}$/.test(code || "") ? `Import failed (${code}). Check the connection in 9Router; nothing was replayed.` : errors.import_result_unknown);
}
function clearTarget() {
  consentTarget = null;
  clearTimeout(expiryTimer);
  document.getElementById("origin").textContent = "Unavailable";
  document.getElementById("connection-name").textContent = "Unavailable";
  document.getElementById("profile-id").textContent = "Unavailable";
  connectButton.disabled = true;
}
function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}
function setBusy(value) {
  busy = value;
  if (value) {
    sequence++;
    probePending = false;
    stopRefresh();
    clearTimeout(focusTimer);
    clearTarget();
  }
  checkButton.disabled = value;
  copyButton.disabled = value;
  exportButton.disabled = value;
  connectButton.disabled = value || !consentTarget;
  if (!value) resumeRefresh();
}
function snapshotKey({ origin, target }) {
  return JSON.stringify([origin, target.profileId, target.attemptId]);
}
function isCurrent(ticket) {
  return ticket === sequence && !closed && !busy && document.visibilityState === "visible";
}
function topResult(results) {
  return results.length === 1 && results[0].frameId === 0 && results[0].documentId ? results[0] : null;
}

// Discovery only reads the selected document. Cookie collection belongs to an
// explicit manual action or the worker's authenticated, single-click handoff.
async function probe() {
  if (closed || busy || document.visibilityState !== "visible") return;
  if (probeInFlight) { probePending = true; return; }
  probeInFlight = true;
  probePending = false;
  const ticket = ++sequence;
  // Preserve the displayed snapshot during a periodic read. Explicit rechecks,
  // tab/document changes and invalid results still revoke it immediately;
  // the worker always revalidates the exact snapshot before cookie collection.
  if (!consentTarget) { clearTarget(); targetHelp.textContent = "Checking the active dashboard tab…"; }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isCurrent(ticket)) return;
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) throw new Error();
    const tabId = tabs[0].id;
    let result = topResult(await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: inspectDashboard, args: [{}] }));
    if (!isCurrent(ticket)) return;
    if (!result?.result?.ok) {
      clearTarget();
      targetHelp.textContent = safeError(result?.result?.code || "session_target_unavailable", result?.result?.reason);
      return;
    }
    // Re-read the exact document before publishing consent; an initial read may
    // have raced navigation, preparation, revision changes or expiry.
    const documentId = result.documentId;
    result = topResult(await chrome.scripting.executeScript({ target: { tabId, documentIds: [result.documentId] }, world: "ISOLATED", func: inspectDashboard, args: [{ expected: result.result.target, origin: result.result.origin }] }));
    const current = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!isCurrent(ticket)) return;
    if (current.length !== 1 || current[0].id !== tabId || result?.documentId !== documentId || !result?.result?.ok) {
      clearTarget();
      targetHelp.textContent = safeError(result?.result?.code || "session_target_unavailable", result?.result?.reason);
      return;
    }
    const { origin, target } = result.result;
    if (attemptedTargets.has(snapshotKey({ origin, target }))) {
      clearTarget();
      targetHelp.textContent = errors.session_import_in_progress;
      return;
    }
    const remaining = Date.parse(target.expiresAt) - Date.now();
    if (remaining <= 0) { clearTarget(); targetHelp.textContent = errors.session_target_expired; return; }
    consentTarget = { tabId, documentId: result.documentId, origin, target };
    document.getElementById("origin").textContent = origin;
    document.getElementById("connection-name").textContent = target.connectionName;
    document.getElementById("profile-id").textContent = target.profileId;
    targetHelp.textContent = "Check this server and connection. Clicking Connect sends your session only to this target for verification.";
    connectButton.disabled = false;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      if (closed || busy || !consentTarget || snapshotKey(consentTarget) !== snapshotKey({ origin, target })) return;
      clearTarget();
      targetHelp.textContent = errors.session_target_expired;
    }, remaining);
  } catch {
    if (isCurrent(ticket)) { clearTarget(); targetHelp.textContent = errors.session_target_unavailable; }
  } finally {
    probeInFlight = false;
    if (probePending && !closed && !busy && document.visibilityState === "visible") void probe();
  }
}
function invalidateAndProbe() {
  sequence++;
  clearTarget();
  void probe();
}
function resumeRefresh() {
  if (closed || busy || document.visibilityState !== "visible") return;
  if (!refreshTimer) refreshTimer = setInterval(() => { if (!probeInFlight) void probe(); }, 1000);
  void probe();
}
function onVisibilityChange() {
  sequence++;
  clearTarget();
  if (document.visibilityState === "visible") resumeRefresh();
  else { stopRefresh(); probePending = false; }
}
function onTabUpdated(tabId) {
  if (consentTarget?.tabId === tabId || probeInFlight) invalidateAndProbe();
}
checkButton.addEventListener("click", invalidateAndProbe);
// Focusing the popup is part of its first mouse gesture. Defer metadata refresh
// so it cannot disable Connect between pointer-down and the consent click.
function onFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(invalidateAndProbe, 250);
}
window.addEventListener("focus", onFocus);
document.addEventListener("visibilitychange", onVisibilityChange);
chrome.tabs.onActivated.addListener(invalidateAndProbe);
chrome.tabs.onUpdated.addListener(onTabUpdated);
window.addEventListener("pagehide", () => {
  closed = true;
  sequence++;
  probePending = false;
  stopRefresh();
  clearTimeout(focusTimer);
  clearTarget();
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  chrome.tabs.onActivated.removeListener(invalidateAndProbe);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
}, { once: true });
resumeRefresh();

let gestureTarget = null;
const captureGesture = () => { gestureTarget = consentTarget ? snapshotKey(consentTarget) : null; };
connectButton.addEventListener("pointerdown", captureGesture);
connectButton.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") captureGesture(); });
connectButton.addEventListener("pointercancel", () => { gestureTarget = null; });
connectButton.addEventListener("click", async () => {
  const startedTarget = gestureTarget; gestureTarget = null;
  if (startedTarget !== null && (!consentTarget || startedTarget !== snapshotKey(consentTarget))) {
    clearTarget(); targetHelp.textContent = errors.session_target_unavailable;
    return;
  }
  if (busy || !consentTarget) return;
  if (Date.parse(consentTarget.target.expiresAt) <= Date.now()) {
    clearTarget();
    targetHelp.textContent = errors.session_target_expired;
    return;
  }
  const target = consentTarget;
  attemptedTargets.add(snapshotKey(target));
  setBusy(true);
  status.textContent = "Connecting to the confirmed dashboard…";
  try {
    const outcome = await chrome.runtime.sendMessage({ type: "connect-chatgpt-session", ...target });
    status.textContent = outcome?.ok
      ? "Session import completed. Check the connection status in 9Router."
      : safeError(outcome?.code, outcome?.reason);
  } catch { status.textContent = errors.import_result_unknown; }
  finally { setBusy(false); }
});

copyButton.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  status.textContent = "Preparing session JSON…";
  let session;
  try {
    session = await collectChatGptSession();
    try { await navigator.clipboard.writeText(JSON.stringify(session)); }
    catch { status.textContent = "Clipboard access was denied. Use Export ChatGPT Session instead; nothing was downloaded or sent."; return; }
    status.textContent = "Session JSON copied. Paste it only into your trusted dashboard. Clipboard history may retain this credential.";
  } catch (error) { status.textContent = safeError(error.code || "invalid_session_transfer"); }
  finally { session = null; setBusy(false); }
});

exportButton.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  status.textContent = "Preparing the session file…";
  let objectUrl, session;
  try {
    session = await collectChatGptSession();
    objectUrl = URL.createObjectURL(new Blob([JSON.stringify(session)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "chatgpt-session.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    status.textContent = "Session file download started. Import it only into your trusted 9Router dashboard, then delete the local file. An export does not guarantee acceptance.";
  } catch (error) { status.textContent = safeError(error.code || "invalid_session_transfer"); }
  finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    session = null;
    setBusy(false);
  }
});
