import { collectChatGptSession } from "./session.js";
import { inspectDashboard } from "./background.js";

const connectButton = document.getElementById("connect");
const copyButton = document.getElementById("copy");
const exportButton = document.getElementById("export");
const status = document.getElementById("status");
let consentTarget = null;
let busy = false;
const errors = {
  session_transfer_expired: "No valid unexpired ChatGPT cookies were found. Sign in to ChatGPT in this Chrome profile, then try again.",
  session_transfer_too_large: "The session exceeds the 256 KiB limit. Nothing was sent or exported.",
  invalid_session_transfer: "The session cannot be transferred. Sign in to ChatGPT in this Chrome profile and check the helper's site permission.",
  session_target_expired: "The connection target expired. Return to 9Router and choose Prepare connection.",
  profile_revision_conflict: "The profile changed. Refresh 9Router and choose Prepare connection; the session was not replayed.",
  dashboard_auth_required: "Sign in to the 9Router dashboard, then prepare the connection again.",
  session_import_in_progress: "This connection attempt is already in progress. Check its status in 9Router; do not resend.",
  import_result_unknown: "The import result is unknown. Check the connection in 9Router and use Use Saved Session. Nothing was replayed.",
  session_target_unavailable: "The target is unavailable. Return to the session assistant in your trusted 9Router dashboard and choose Prepare connection.",
};
function setBusy(value) {
  busy = value;
  connectButton.disabled = value || !consentTarget;
  copyButton.disabled = value;
  exportButton.disabled = value;
}
function safeError(code) {
  return errors[code] || (/^[a-z0-9_]{1,64}$/.test(code || "") ? `Import failed (${code}). Check the connection in 9Router; nothing was replayed.` : errors.import_result_unknown);
}

// Opening the popup reads only the active document's target, never cookies.
async function probe() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) throw new Error();
    const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id, frameIds: [0] }, world: "ISOLATED", func: inspectDashboard, args: [{}] });
    const result = results.length === 1 && results[0].frameId === 0 && results[0].documentId ? results[0] : null;
    if (!result?.result?.ok) {
      document.getElementById("target-help").textContent = safeError(result?.result?.code || "session_target_unavailable");
      return;
    }
    const { origin, target } = result.result;
    consentTarget = { tabId: tabs[0].id, documentId: result.documentId, origin, target };
    document.getElementById("origin").textContent = origin;
    document.getElementById("connection-name").textContent = target.connectionName;
    document.getElementById("profile-id").textContent = target.profileId;
    document.getElementById("target-help").textContent = "Check this server and connection. Clicking Connect sends your session only to this target for verification.";
  } catch {
    document.getElementById("target-help").textContent = errors.session_target_unavailable;
  } finally { connectButton.disabled = busy || !consentTarget; }
}
void probe();
connectButton.addEventListener("click", async () => {
  if (busy || !consentTarget) return;
  const target = consentTarget;
  setBusy(true);
  status.textContent = "Connecting to the confirmed dashboard…";
  try {
    const outcome = await chrome.runtime.sendMessage({ type: "connect-chatgpt-session", ...target });
    status.textContent = outcome?.ok
      ? "Session import completed. Check the connection status in 9Router."
      : safeError(outcome?.code);
  } catch { status.textContent = errors.import_result_unknown; }
  finally {
    // Explicit Prepare connection is required for a new Direct attempt.
    consentTarget = null;
    setBusy(false);
  }
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
