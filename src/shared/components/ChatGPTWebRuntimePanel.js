"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import ChatGPTWebConnectionTab from "./ChatGPTWebConnectionTab";
import ChatGPTWebAgentTab from "./ChatGPTWebAgentTab";
import ChatGPTWebPreferencesTab from "./ChatGPTWebPreferencesTab";
import ChatGPTWebDiagnosticsTab from "./ChatGPTWebDiagnosticsTab";
import { buildChatGptWebClientConfig } from "@/shared/utils/chatgptWebClientConfig";
import ChatGPTWebViewer from "./ChatGPTWebViewer";
import { MAX_SESSION_TRANSFER_BYTES, SessionTransferError, parseChatGptWebSessionTransfer } from "../../../services/chatgpt-web-runtime/session-transfer.js";
import { getChatGptWebProfileNotice } from "@/shared/utils/connectionStatus";

const BASE = "/api/providers/chatgpt-web/runtime";
const DEFAULT_SETTINGS = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const BIGGER_CONTEXT_ROUTES = new Set(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-5.6-pro", "chatgpt-web/gpt-6-sol", "chatgpt-web/gpt-6-pro"]);
const IMPORT_ERRORS = {
  invalid_session_transfer: "Invalid ChatGPT session JSON. Use the Chrome helper to export cookies; access tokens and /api/auth/session JSON cannot be imported.",
  session_transfer_expired: "The exported cookies have expired. Sign in in Chrome and export again.",
  session_transfer_too_large: "The session exceeds the 256 KiB limit.",
};
const IMPORT_REQUEST = "9router:chatgpt-session-import-request";
const IMPORT_RESULT = "9router:chatgpt-session-import-result";
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const unknownImport = () => ({ ok: false, status: 0, code: "import_result_unknown" });
const failedImport = cause => ({ ok: false, status: Number.isInteger(cause?.status) ? cause.status : 0, code: /^[a-z0-9_]{1,64}$/.test(cause?.code || "") ? cause.code : "import_result_unknown" });
// Only a recovery bit lives in tab-local storage; never cookies, files or tokens.
const consumedImports = new Set();
const recoveryKey = profileId => `9router:cgw:import-recovery:${profileId}`;
function needsImportRecovery(profileId) {
  if (typeof window === "undefined") return false;
  if (consumedImports.has(profileId)) return true;
  try { return window.sessionStorage.getItem(recoveryKey(profileId)) === "1"; }
  catch { return true; } // Unavailable storage requires explicit verification.
}
function markImportRecovery(profileId, consumed) {
  if (consumed) consumedImports.add(profileId); else consumedImports.delete(profileId);
  try {
    if (consumed) window.sessionStorage.setItem(recoveryKey(profileId), "1");
    else window.sessionStorage.removeItem(recoveryKey(profileId));
  } catch { /* The mounted/document-local fence still applies. */ }
}
function dispatchImportResult(target, outcome) {
  document.dispatchEvent(new CustomEvent(IMPORT_RESULT, { detail: { version: 1, attemptId: target.attemptId, profileId: target.profileId, revision: target.revision, ...outcome } }));
}
async function request(action, init, signal) {
  const response = await fetch(`${BASE}/${action}`, { cache: "no-store", ...init, signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(typeof data.error === "string" ? data.error : data.error?.message || "Runtime action failed.");
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

const leaseNotice = state => ({ completed: "Sign-in finished. Checking runtime readiness.", expired: "Browser session expired. Open a new session to continue.", closed: "Browser session ended.", error: "Sign-in verification failed. Open a new session to try again." }[state] || "Browser session ended.");
const LEASE_STATES = new Set(["waiting", "completed", "expired", "closed", "error"]);
function validLease(value, profileId, loginId) {
  return value?.profileId === profileId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.loginId || "") && (!loginId || value.loginId === loginId) && typeof value.manualLogin === "boolean" && LEASE_STATES.has(value.state) && Number.isFinite(Date.parse(value.expiresAt));
}

// Profile/status reads never send a model or tool request. Human sign-in is verified only on request.
export default function ChatGPTWebRuntimePanel({ connectionName, profileId, selectedProfileId = profileId, onProfileSelected, onChanged, onViewerOpenChange, onStateChange, connectionDirty = false, connectionDetails, initialSignInMethod = "browser", autoOpenSessionImport = false }) {
  const [profiles, setProfiles] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeIsReadiness, setNoticeIsReadiness] = useState(false);
  const [connectionStatusWarning, setConnectionStatusWarning] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [lease, setLease] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [fileSelected, setFileSelected] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(autoOpenSessionImport || initialSignInMethod === "extension");
  const [importMode, setImportMode] = useState("extension");
  const [pastedSession, setPastedSession] = useState("");
  const [directTarget, setDirectTarget] = useState(null);
  const [targetConsumed, setTargetConsumed] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [tab, setTab] = useState("connection");
  const [signInMethod, setSignInMethod] = useState(initialSignInMethod);
  const [harness, setHarness] = useState(null);
  const [harnessReadError, setHarnessReadError] = useState("");
  const [resources, setResources] = useState(null);
  const [resourceReadError, setResourceReadError] = useState("");
  const [tunnelIdInput, setTunnelId] = useState(null);
  const [runtimeApiKey, setRuntimeApiKey] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [selectedModelId, setModelId] = useState("");
  const [selectedEffort, setEffort] = useState("");
  const [snippetNotice, setSnippetNotice] = useState("");
  const [targetExpired, setTargetExpired] = useState(false);
  const targetElement = useRef(null);
  const targetRef = useRef(null);
  const consumedRef = useRef(false);
  const [consumedProfile, setConsumedProfile] = useState(() => needsImportRecovery(profileId) ? profileId : null);
  const hasConsumedAttempt = consumedProfile === profileId;
  const directInFlight = useRef(null);
  const prepareOnLoad = useRef(autoOpenSessionImport || initialSignInMethod === "extension");
  const fileInput = useRef(null);
  const sessionFile = useRef(null);
  const lifetime = useRef(null);
  const leaseRef = useRef(null);
  const busyRef = useRef(false);
  const [baseRevision, setBaseRevision] = useState(null);
  const dirtyRef = useRef(false);
  const pollError = useRef("");
  const lastProfileEvidence = useRef(null);
  const profile = profiles.find(item => item.profileId === profileId);
  const tunnelId = tunnelIdInput ?? harness?.tunnelId ?? "";
  const selectedModel = profile?.models.find(item => item.id === selectedModelId) || profile?.models[0];
  const modelId = selectedModel?.id || "";
  const effort = selectedModel?.supported_reasoning_levels.includes(selectedEffort) ? selectedEffort : selectedModel?.default_reasoning_level || selectedModel?.supported_reasoning_levels[0] || "";
  const harnessDraftDirty = !!runtimeApiKey || (!!harness && tunnelId !== (harness.tunnelId || ""));

  const clearSessionFile = useCallback(() => {
    sessionFile.current = null; setFileSelected(null); setPastedSession("");
    if (fileInput.current) fileInput.current.value = "";
  }, []);
  const invalidateTarget = useCallback(() => {
    prepareOnLoad.current = false;
    targetRef.current = null; consumedRef.current = false;
    targetElement.current?.removeAttribute("data-9router-chatgpt-session-target");
    targetElement.current?.removeAttribute("data-9router-chatgpt-session-consumed");
    setDirectTarget(null); setTargetConsumed(false);
  }, []);
  useEffect(() => {
    prepareOnLoad.current = autoOpenSessionImport || initialSignInMethod === "extension";
  }, [profileId, autoOpenSessionImport, initialSignInMethod]);
  useLayoutEffect(() => {
    const input = fileInput.current;
    const element = targetElement.current;
    return () => {
      sessionFile.current = null;
      if (input) input.value = "";
      targetRef.current = null; consumedRef.current = false;
      element?.removeAttribute("data-9router-chatgpt-session-target");
      element?.removeAttribute("data-9router-chatgpt-session-consumed");
    };
  }, [profileId, assistantOpen]);
  useEffect(() => {
    onViewerOpenChange(viewerOpen);
    return () => onViewerOpenChange(false);
  }, [viewerOpen, onViewerOpenChange]);
  const endViewer = useCallback(state => {
    const current = leaseRef.current;
    if (current) { const ended = { ...current, state, manualLogin: false }; leaseRef.current = ended; setLease(ended); }
    setViewerOpen(false);
    setError(state === "error" ? leaseNotice(state) : "");
    setNotice(state === "error" ? "" : leaseNotice(state));
    setNoticeIsReadiness(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        if (!busyRef.current && document.visibilityState !== "hidden") {
          const data = await request("profiles", {}, controller.signal);
          if (controller.signal.aborted || busyRef.current) return;
          setProfiles(data.profiles); setLoaded(true);
          if (pollError.current) {
            const previousError = pollError.current;
            setError(previous => previous === previousError ? "" : previous);
            pollError.current = "";
          }
          const current = data.profiles.find(item => item.profileId === profileId);
          if (current && !dirtyRef.current) {
            setBaseRevision(current.revision);
            setDraft(current.settings);
          }
          const evidence = JSON.stringify([current?.state, current?.browser_state, current?.catalog_verified, current?.settings?.mode, current?.lastError?.code, current?.models.map(model => model.id)]);
          const changed = lastProfileEvidence.current !== null && lastProfileEvidence.current !== evidence;
          lastProfileEvidence.current = evidence;
          if (changed) onChanged();
          try {
            const status = await request(`harness/status?profileId=${encodeURIComponent(profileId)}`, {}, controller.signal);
            if (!controller.signal.aborted && !busyRef.current) { setHarness(status); setHarnessReadError(""); }
          } catch (cause) {
            if (!controller.signal.aborted) setHarnessReadError(cause.message);
          }
          const activeLease = leaseRef.current;
          if (activeLease?.state === "completed") setNoticeIsReadiness(true);
          if (activeLease?.state === "waiting") {
            if (Date.parse(activeLease.expiresAt) <= Date.now()) {
              endViewer("expired");
            } else {
              try {
                const status = await request(`login/status?loginId=${encodeURIComponent(activeLease.loginId)}`, {}, controller.signal);
                if (!controller.signal.aborted && !busyRef.current && leaseRef.current === activeLease) {
                  if (!validLease(status, profileId, activeLease.loginId)) throw new Error("Private viewer session changed. Open a new session.");
                  leaseRef.current = status; setLease(status);
                  if (status.state !== "waiting") {
                    endViewer(status.state);
                    if (status.state === "completed") {
                      const fresh = await request("profiles", {}, controller.signal);
                      if (controller.signal.aborted || busyRef.current) return;
                      setProfiles(fresh.profiles);
                      setNotice(getChatGptWebProfileNotice(fresh.profiles.find(item => item.profileId === profileId)));
                      setNoticeIsReadiness(true);
                    }
                    onChanged();
                  }
                }
              } catch (cause) {
                if (controller.signal.aborted || busyRef.current || leaseRef.current !== activeLease) return;
                if ([404, 410].includes(cause.status)) endViewer("closed");
                else throw cause;
              }
            }
          }
          if (!busyRef.current && current?.state === "draining" && leaseRef.current?.state === "waiting") endViewer("closed");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          pollError.current = cause.message;
          setError(cause.message); setProfiles([]);
          if (lastProfileEvidence.current !== null && lastProfileEvidence.current !== "unavailable") onChanged();
          lastProfileEvidence.current = "unavailable";
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [profileId, refresh, endViewer, onChanged]);
  useEffect(() => {
    if (tab !== "diagnostics") return;
    const controller = new AbortController();
    let timer;
    setResources(null); setResourceReadError("");
    async function pollResources() {
      try {
        const snapshot = await request("resources", {}, controller.signal);
        if (!controller.signal.aborted) { setResources(snapshot); setResourceReadError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) { setResources(null); setResourceReadError(cause.message); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(pollResources, 5000);
      }
    }
    void pollResources();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tab, profileId, refresh]);
  const act = useCallback(async (action, body, label, method = "POST") => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return unknownImport();
    if (busyRef.current) return { ok: false, status: 409, code: "session_import_in_progress" };
    if (action !== "session/import") { clearSessionFile(); invalidateTarget(); }
    busyRef.current = true; setBusy(label); setError(""); setNotice(""); setRuntimeApiKey("");
    setNoticeIsReadiness(false);
    try {
      const data = await request(action, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, controller.signal);
      if (controller.signal.aborted) return unknownImport();
      setConnectionStatusWarning(typeof data.connectionStatusWarning === "string" ? data.connectionStatusWarning : "");
      if (["login/start", "login/complete", "login/close", "browser/view"].includes(action)) {
        if (!validLease(data, profileId, body.loginId) || (action === "login/complete" && data.state === "waiting" && !data.manualLogin)) throw new Error("Private browser session does not match this connection.");
        leaseRef.current = data; setLease(data);
        if (action === "login/complete") setViewerOpen(previous => previous && data.state === "waiting");
        else setViewerOpen(data.state === "waiting");
        if (action === "login/complete" && data.state === "waiting") setError("Sign-in is not verified yet. Continue in the browser, then choose Finish Sign In again.");
      }
      let updated = data.profile || (data.profileId && data.settings ? data : null);
      if (["login/start", "login/complete", "login/close", "session/verify", "session/import", "browser/restart", "smoke", "harness/activate", "harness/disconnect"].includes(action) || method === "PATCH") {
        // A completed lease alone is not readiness evidence. Reconcile the exact saved profile.
        const status = await request("profiles", {}, controller.signal);
        if (controller.signal.aborted) return unknownImport();
        updated = status.profiles?.find(item => item.profileId === profileId);
        if (!updated) throw new Error("invalid_runtime_response");
      }
      if (["session/verify", "session/import"].includes(action) && updated?.profileId !== body.profileId) throw new Error("invalid_runtime_response");
      if (updated) {
        setProfiles(previous => [...previous.filter(item => item.profileId !== updated.profileId), updated]);
        if (updated.profileId === profileId && (method === "PATCH" || !dirtyRef.current)) { setDraft(updated.settings); setBaseRevision(updated.revision); dirtyRef.current = false; setDirty(false); }
      }
      if (action.startsWith("harness/")) {
        const status = data.status || (data.configRevision !== undefined ? data : null);
        if (status?.profileId === profileId) { setHarness(status); setHarnessReadError(""); }
      }
      if (action === "harness/configure" && (data.status || data).tunnelId) setTunnelId((data.status || data).tunnelId);
      if (action === "session/verify" && updated?.state === "ready") { markImportRecovery(profileId, false); setConsumedProfile(null); invalidateTarget(); }
      setNoticeIsReadiness(["session/verify", "session/import"].includes(action) || (action === "login/complete" && data.state === "completed"));
      setNotice(["session/verify", "session/import"].includes(action) || (action === "login/complete" && data.state === "completed")
        ? getChatGptWebProfileNotice(updated)
        : data.message || (data.loginId ? (data.state === "waiting" ? "" : leaseNotice(data.state)) : `${label} completed.`));
      onChanged();
      return { ok: true, status: 200, code: null };
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause.message);
        setRuntimeApiKey("");
        if (action === "session/import" && (!cause.status || cause.code === "runtime_unavailable")) {
          // Read only after an interrupted observer; never replay the credential upload.
          setNotice("Import was not retried. Use Saved Session to confirm the target connection before importing again.");
          try {
            const status = await request("profiles", {}, controller.signal);
            const target = status.profiles?.find(item => item.profileId === body.profileId);
            if (!controller.signal.aborted && target) setProfiles(previous => [...previous.filter(item => item.profileId !== target.profileId), target]);
          } catch { /* Keep the uncertain import visible; no automatic mutation. */ }
        }
        if (action === "login/complete") {
          // A rejected verification may have restored the human browser. Read this exact lease once,
          // after the explicit action; never silently submit another verification.
          try {
            const status = await request(`login/status?loginId=${encodeURIComponent(body.loginId)}`, {}, controller.signal);
            if (controller.signal.aborted) return unknownImport();
            if (!validLease(status, profileId, body.loginId) || (status.state === "waiting" && !status.manualLogin)) throw new Error("Invalid sign-in session status.");
            leaseRef.current = status; setLease(status);
            setViewerOpen(previous => previous && status.state === "waiting");
            if (status.state !== "waiting") {
              if (status.state === "completed") {
                const fresh = await request("profiles", {}, controller.signal);
                if (controller.signal.aborted) return unknownImport();
                setProfiles(fresh.profiles);
                setNotice(getChatGptWebProfileNotice(fresh.profiles.find(item => item.profileId === profileId)));
                setNoticeIsReadiness(true);
                setError("");
              } else {
                setNotice(leaseNotice(status.state));
                setError(`${leaseNotice(status.state)} ${cause.message}`);
              }
            }
            onChanged();
          } catch (statusError) {
            if (!controller.signal.aborted) {
              if ([404, 410].includes(statusError.status)) endViewer("closed");
              else { setViewerOpen(false); setError(`${cause.message} Could not confirm the browser session. Open Browser to check it before trying again.`); }
            }
          }
        }
        // Rejected Full mode or revision conflict never appears as a successful setting.
        if (method === "PATCH") {
          if (cause.status === 409) setNotice("The profile revision changed. Your preferences draft is preserved. Review the latest settings before reapplying; nothing was overwritten.");
        }
      }
      return controller.signal.aborted ? unknownImport() : failedImport(cause);
    } finally {
      if (!controller.signal.aborted) { busyRef.current = false; setBusy(""); }
    }
  }, [onChanged, profileId, endViewer, invalidateTarget, clearSessionFile]);

  const change = (key, value) => {
    clearSessionFile(); invalidateTarget();
    if (!dirtyRef.current) setBaseRevision(profile?.revision ?? null);
    dirtyRef.current = true; setDirty(true);
    setDraft(previous => ({ ...previous, [key]: value, ...(key === "mode" && value === "browser-only" ? { autoApproveToolCalls: false } : {}) }));
  };
  const fenced = profile?.state === "draining";
  const active = (profile?.activeTurns || 0) > 0;
  const disabled = !!busy || fenced;
  const biggerSupported = profile?.models.some(model => !model.legacy && BIGGER_CONTEXT_ROUTES.has(model.id)) === true;
  const waiting = lease?.state === "waiting";
  const needsLogin = !waiting && ["unconfigured", "login_required", "error"].includes(profile?.state);
  const sessionDisabled = disabled || active || waiting || viewerOpen || profile?.state === "probing" || !loaded || !profile;
  const verifySession = () => act("session/verify", { profileId, revision: profile.revision }, "Use Saved Session");
  const secureImportOrigin = typeof window !== "undefined" && (window.location.protocol === "https:" || (window.location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname.toLowerCase())));
  const importContext = useRef(null);
  useLayoutEffect(() => {
    importContext.current = { profileId, selectedProfileId, connectionName, blocked: active || waiting || viewerOpen || fenced || profile?.state === "probing" || !loaded || !profile || !secureImportOrigin || connectionDirty || dirty || harnessDraftDirty || tab !== "connection" || !assistantOpen };
  }, [profileId, selectedProfileId, connectionName, active, waiting, viewerOpen, fenced, profile, loaded, secureImportOrigin, connectionDirty, dirty, harnessDraftDirty, tab, assistantOpen]);
  const prepareConnection = useCallback(() => {
    if (sessionDisabled || !secureImportOrigin || busyRef.current || dirty || connectionDirty || harnessDraftDirty || selectedProfileId !== profileId || tab !== "connection" || !assistantOpen || hasConsumedAttempt) {
      setNotice("Connection cannot be prepared yet. Resolve the displayed blocker, then choose Prepare connection.");
      return;
    }
    clearSessionFile();
    const target = Object.freeze({ version: 1, attemptId: crypto.randomUUID(), profileId, revision: profile.revision, connectionName, expiresAt: new Date(Date.now() + 300000).toISOString() });
    prepareOnLoad.current = false;
    setTargetExpired(false);
    targetRef.current = target; consumedRef.current = false;
    setDirectTarget(target); setTargetConsumed(false);
  }, [sessionDisabled, secureImportOrigin, dirty, connectionDirty, harnessDraftDirty, selectedProfileId, profileId, profile, connectionName, clearSessionFile, tab, assistantOpen, hasConsumedAttempt]);
  const previousContext = useRef({ profileId, selectedProfileId, connectionName });
  useEffect(() => {
    const previous = previousContext.current;
    previousContext.current = { profileId, selectedProfileId, connectionName };
    if (previous.profileId !== profileId || previous.selectedProfileId !== selectedProfileId || previous.connectionName !== connectionName) {
      clearSessionFile(); invalidateTarget();
    }
  }, [profileId, selectedProfileId, connectionName, clearSessionFile, invalidateTarget]);
  useEffect(() => {
    const target = targetRef.current;
    if (target && (importContext.current.blocked || (busy && directInFlight.current !== target.attemptId) || dirty || selectedProfileId !== target.profileId || (profile?.revision !== target.revision && !directInFlight.current) || (Date.parse(target.expiresAt) <= Date.now() && !directInFlight.current))) {
      if (Date.parse(target.expiresAt) <= Date.now() && !directInFlight.current) setTargetExpired(true);
      clearSessionFile(); invalidateTarget();
    }
    if (assistantOpen && tab === "connection" && importMode === "extension" && prepareOnLoad.current && !hasConsumedAttempt && !sessionDisabled && secureImportOrigin && !dirty && !connectionDirty && !harnessDraftDirty && selectedProfileId === profileId) prepareConnection();
  }, [assistantOpen, tab, importMode, sessionDisabled, busy, active, waiting, viewerOpen, loaded, profile?.state, secureImportOrigin, dirty, connectionDirty, harnessDraftDirty, selectedProfileId, profileId, profile?.revision, prepareConnection, invalidateTarget, clearSessionFile, hasConsumedAttempt]);
  useEffect(() => {
    if (!directTarget) return;
    const timer = setTimeout(() => { if (targetRef.current === directTarget && !directInFlight.current) { setTargetExpired(true); clearSessionFile(); invalidateTarget(); } }, Math.max(0, Date.parse(directTarget.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [directTarget, invalidateTarget, clearSessionFile]);
  const importSession = async (source = "file", target = null) => {
    // Capture credentials and revision at the explicit click/event, before any asynchronous read.
    const file = source === "paste" ? null : sessionFile.current;
    const text = source === "paste" ? pastedSession : null;
    const snapshot = target || { profileId, revision: profile?.revision };
    const controller = lifetime.current;
    let outcome = unknownImport();
    let ownsBusy = false;
    try {
      if (busyRef.current) throw new SessionTransferError("session_import_in_progress", 409);
      if (sessionDisabled || !secureImportOrigin || dirty || connectionDirty || tab !== "connection" || selectedProfileId !== snapshot.profileId || snapshot.profileId !== profileId || !controller || controller.signal.aborted) throw new SessionTransferError("session_target_unavailable", 409);
      if (source !== "extension") invalidateTarget();
      busyRef.current = true; ownsBusy = true;
      setBusy(source === "paste" ? "Read pasted session" : "Read session file"); setError(""); setNotice("");
      let raw;
      if (source === "paste") {
        if (new TextEncoder().encode(text).byteLength > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
        raw = text;
      } else {
        if (!file) throw new SessionTransferError("invalid_session_transfer", 400);
        if (file.size > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
        try { raw = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
        catch { throw new SessionTransferError("invalid_session_transfer", 400); }
      }
      if (controller.signal.aborted) return outcome;
      const current = importContext.current;
      if (current.blocked || current.profileId !== snapshot.profileId || current.selectedProfileId !== snapshot.profileId || (source === "extension" && (targetRef.current !== target || current.connectionName !== target.connectionName))) throw new SessionTransferError("session_target_unavailable", 409);
      let value;
      try { value = JSON.parse(raw); }
      catch { throw new SessionTransferError("invalid_session_transfer", 400); }
      const body = { profileId: snapshot.profileId, revision: snapshot.revision, session: { format: "9router-chatgpt-session", version: 1, cookies: parseChatGptWebSessionTransfer(value) } };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
      busyRef.current = false;
      outcome = await act("session/import", body, "Import session");
      return outcome;
    } catch (cause) {
      outcome = controller?.signal.aborted ? unknownImport() : failedImport(cause);
      if (!controller?.signal.aborted) setError(IMPORT_ERRORS[cause.code] || (cause.code === "session_import_in_progress" ? "A session import is already in progress." : "The session target is unavailable. Wait for an idle profile and prepare the connection again."));
      return outcome;
    } finally {
      clearSessionFile();
      if (ownsBusy) { busyRef.current = false; if (!controller?.signal.aborted) setBusy(""); }
      if (source === "extension" && target) {
        directInFlight.current = null;
        dispatchImportResult(target, outcome);
      }
    }
  };
  useEffect(() => {
    const handleRequest = event => {
      const detail = event.detail;
      if (!detail || detail.version !== 1 || !ATTEMPT_ID.test(detail.attemptId || "") || !PROFILE_ID.test(detail.profileId || "") || !Number.isSafeInteger(detail.revision) || detail.revision < 1) return;
      const target = targetRef.current;
      let code = "session_target_unavailable";
      if (busyRef.current || directInFlight.current || (target?.attemptId === detail.attemptId && consumedRef.current)) code = "session_import_in_progress";
      else if (target?.attemptId === detail.attemptId && Date.parse(target.expiresAt) <= Date.now()) code = "session_target_expired";
      else if (target?.attemptId === detail.attemptId && (detail.revision !== target.revision || profile?.revision !== target.revision)) code = "profile_revision_conflict";
      else if (tab === "connection" && assistantOpen && importMode === "extension" && target && !consumedRef.current && target.attemptId === detail.attemptId && target.profileId === detail.profileId && target.connectionName === connectionName && selectedProfileId === detail.profileId && profileId === detail.profileId && detail.revision === target.revision && profile?.revision === target.revision && !sessionDisabled && secureImportOrigin && !dirty && !connectionDirty && !busyRef.current && fileInput.current?.files?.length === 1) {
        // Consume before await; the File ref is captured synchronously by the shared importer.
        markImportRecovery(profileId, true);
        consumedRef.current = true; setConsumedProfile(profileId); setTargetConsumed(true);
        targetElement.current?.setAttribute("data-9router-chatgpt-session-consumed", "true");
        sessionFile.current = fileInput.current.files[0];
        directInFlight.current = target.attemptId;
        void importSession("extension", target);
        return;
      }
      clearSessionFile();
      dispatchImportResult(detail, { ok: false, status: 409, code });
    };
    document.addEventListener(IMPORT_REQUEST, handleRequest);
    return () => document.removeEventListener(IMPORT_REQUEST, handleRequest);
  });
  const changeSignInMethod = method => {
    clearSessionFile(); invalidateTarget(); setSignInMethod(method);
    setImportMode("extension"); setAssistantOpen(method === "extension");
    prepareOnLoad.current = method === "extension" && !hasConsumedAttempt && !targetExpired;
  };
  const changeImportMode = mode => {
    clearSessionFile(); invalidateTarget(); setImportMode(mode);
    prepareOnLoad.current = mode === "extension" && !hasConsumedAttempt && !targetExpired;
  };
  const changeTab = next => {
    if (busyRef.current || next === tab) return;
    clearSessionFile(); invalidateTarget(); setRuntimeApiKey(""); setTab(next);
    setAssistantOpen(next === "connection" && signInMethod === "extension");
    prepareOnLoad.current = next === "connection" && signInMethod === "extension" && !hasConsumedAttempt && !targetExpired;
  };
  const openBrowser = () => {
    clearSessionFile(); invalidateTarget(); setAssistantOpen(false);
    if (waiting && Date.parse(lease.expiresAt) <= Date.now()) { endViewer("expired"); return; }
    if (waiting) { setError(""); setNotice(""); setViewerOpen(true); }
    else void act(needsLogin ? "login/start" : "browser/view", { profileId }, needsLogin ? "Start login" : "View browser");
  };
  const finishLogin = () => {
    const current = leaseRef.current;
    if (current?.state !== "waiting" || !current.manualLogin) return;
    if (Date.parse(current.expiresAt) <= Date.now()) { endViewer("expired"); return; }
    void act("login/complete", { loginId: current.loginId }, "Finish Sign In");
  };
  const endBrowser = () => { if (leaseRef.current?.state === "waiting") void act("login/close", { loginId: leaseRef.current.loginId }, "End login"); };
  const reconciledNotice = noticeIsReadiness ? getChatGptWebProfileNotice(profile) : notice;
  const humanStatus = error || reconciledNotice || (busy === "Finish Sign In" ? "Checking your sign-in…" : waiting && lease.manualLogin ? "Sign in in the browser, then choose Finish Sign In." : waiting ? "Browser session is open." : !loaded ? "Opening connection…" : getChatGptWebProfileNotice(profile));
  const harnessDisabled = sessionDisabled || dirty || connectionDirty || selectedProfileId !== profileId || !secureImportOrigin || !harness;
  const assistantReason = !secureImportOrigin ? "insecure_origin" : !loaded || !profile ? "loading" : selectedProfileId !== profileId ? "profile_mismatch" : dirty || connectionDirty || harnessDraftDirty ? "unsaved_changes" : active ? "active_turns" : viewerOpen ? "viewer_open" : waiting ? "viewer_waiting" : fenced ? "draining" : profile.state === "probing" || busy ? "probing" : hasConsumedAttempt ? "consumed" : targetExpired ? "expired" : null;
  const preferencesConflict = dirty && profile?.revision !== baseRevision;
  useLayoutEffect(() => {
    onStateChange?.({ dirty: dirty || harnessDraftDirty, busy: !!busy, status: !loaded ? "Loading"
      : profile?.state === "session_unverified" ? "Session not checked since restart"
      : profile?.state === "ready" && profile.models.length ? profile.browser_state === "sleeping" ? "Sleeping · wakes on request" : "Session ready"
      : profile?.state === "login_required" ? "Sign-in needed" : profile?.state === "probing" || profile?.browser_state === "waking" ? "Checking saved session" : "Session unavailable" });
  }, [dirty, harnessDraftDirty, busy, loaded, profile, onStateChange]);
  const generated = useMemo(() => {
    const model = profile?.models.find(item => item.id === modelId);
    if (!model || typeof window === "undefined") return { config: null, error: "Verify a model and its context limit before downloading client configuration." };
    try { return { config: buildChatGptWebClientConfig(model, window.location.origin, effort || undefined), error: "" }; }
    catch { return { config: null, error: "Client configuration requires a verified model, effort and context limit, with HTTPS or a loopback API origin." }; }
  }, [profile, modelId, effort]);
  const harnessAction = async (action, label, extra = {}) => {
    if (harnessDisabled || busyRef.current) { setError("Wait for an idle, saved profile and resolve harness prerequisites before continuing."); setRuntimeApiKey(""); return; }
    if (action === "configure" && harness.source === "operator") { setError("This tunnel is operator-managed. Dashboard configuration cannot replace it."); setRuntimeApiKey(""); return; }
    if (action !== "configure" && harnessDraftDirty) { setError("Save or discard the tunnel configuration draft before changing the harness."); setRuntimeApiKey(""); return; }
    const body = { profileId, revision: profile.revision, configRevision: harness.configRevision, ...extra };
    setRuntimeApiKey("");
    await act(`harness/${action}`, body, label);
    setRefresh(value => value + 1);
  };
  const saveHarnessConfig = () => {
    const key = runtimeApiKey.trim();
    void harnessAction("configure", "Save tunnel configuration", { tunnelId: tunnelId.trim(), ...(key ? { runtimeApiKey: key } : {}) });
  };
  const copySnippet = async text => {
    try { await navigator.clipboard.writeText(text); setSnippetNotice("Snippet copied. No credentials are included."); }
    catch { setSnippetNotice("Clipboard access was blocked. Select the snippet or download it."); }
  };
  const downloadSnippet = (filename, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const verifyConnector = () => void harnessAction("verify", "Verify connector");
  const tabs = [["connection", "Connection"], ["agents", "Coding agents"], ["preferences", "Preferences"], ["diagnostics", "Diagnostics"]];

  return (
    <section aria-label="ChatGPT Web connection" className="min-w-0 space-y-4">
      <div role="tablist" aria-label="Connection tasks" className="flex gap-2 overflow-x-auto pb-2" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const controls = Array.from(event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)'));
        const index = controls.indexOf(document.activeElement);
        if (index < 0 || !controls.length) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
        controls[next].focus(); controls[next].click();
      }}>{tabs.map(([value, label]) => <Button key={value} id={`chatgpt-web-tab-${value}`} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`chatgpt-web-panel-${value}`} className={`shrink-0 focus-visible:ring-2 focus-visible:ring-brand-500 ${tab === value ? "border-brand-500 text-brand-500" : ""}`} variant="secondary" disabled={!!busy} onClick={() => changeTab(value)}>{label}</Button>)}</div>
      <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-400" : "text-text-muted"}`}>{humanStatus.replace("Check Advanced for diagnostics.", "Check Diagnostics for details.")}</p>
      {profile?.state === "session_unverified" && tab !== "connection" && <Button variant="secondary" disabled={sessionDisabled || dirty || connectionDirty || harnessDraftDirty || selectedProfileId !== profileId} onClick={verifySession}>Verify saved session</Button>}
      {connectionStatusWarning && <p role="status" className="text-sm text-amber-500">{connectionStatusWarning}</p>}
      {(tab === "agents" || tab === "diagnostics") && harnessReadError && <p role="alert" className="text-sm text-amber-500">Harness status unavailable: {harnessReadError}. Refresh diagnostics or contact the operator.</p>}
      <div id={`chatgpt-web-panel-${tab}`} role="tabpanel" aria-labelledby={`chatgpt-web-tab-${tab}`} tabIndex={0} className="min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        {tab === "connection" && <ChatGPTWebConnectionTab
          profile={profile} loaded={loaded} busy={busy} disabled={disabled}
          sessionDisabled={sessionDisabled || dirty || connectionDirty || harnessDraftDirty || selectedProfileId !== profileId}
          waiting={waiting} needsLogin={needsLogin} signInMethod={signInMethod}
          onMethodChange={changeSignInMethod} openBrowser={openBrowser} endBrowser={endBrowser} verifySession={verifySession}
          assistantOpen={assistantOpen} importMode={importMode} changeImportMode={changeImportMode}
          assistantReason={assistantReason} secureImportOrigin={secureImportOrigin}
          directTarget={directTarget} targetConsumed={targetConsumed} targetElement={targetElement} fileInput={fileInput}
          onFileChange={event => { const file = event.target.files?.length === 1 ? event.target.files[0] : null; sessionFile.current = file; setFileSelected(file ? { name: file.name, size: file.size } : null); }}
          connectionName={connectionName} profileId={profileId} fileSelected={fileSelected}
          pastedSession={pastedSession} onPasteChange={event => setPastedSession(event.target.value)}
          importSession={source => void importSession(source)} prepareConnection={prepareConnection}
          canPrepare={!sessionDisabled && secureImportOrigin && !dirty && !connectionDirty && !harnessDraftDirty && selectedProfileId === profileId && !hasConsumedAttempt}
          clipboardNotice={clipboardNotice}
          copyExtensionsAddress={async () => { try { await navigator.clipboard.writeText("chrome://extensions"); setClipboardNotice("Extensions address copied."); } catch { setClipboardNotice("Type chrome://extensions in Chrome’s address bar."); } }}
          connectionDetails={connectionDetails} profiles={profiles} selectedProfileId={selectedProfileId}
          onProfileSelected={value => { clearSessionFile(); invalidateTarget(); onProfileSelected(value); }}
        />}
        {tab === "agents" && <ChatGPTWebAgentTab
          profile={profile} harness={harness} disabled={harnessDisabled} busy={busy}
          tunnelId={tunnelId} runtimeApiKey={runtimeApiKey}
          onTunnelIdChange={event => setTunnelId(event.target.value)} onKeyChange={event => setRuntimeApiKey(event.target.value)}
          saveConfig={saveHarnessConfig} startTunnel={() => void harnessAction("start", "Start tunnel")}
          verifyConnector={verifyConnector} activate={() => void harnessAction("activate", "Enable coding tools")}
          disconnect={() => void harnessAction("disconnect", "Disconnect coding tools")}
          openBrowser={openBrowser} waiting={waiting} endBrowser={endBrowser}
          setupOpen={setupOpen} openSetup={() => setSetupOpen(true)}
          discardConfig={() => { setRuntimeApiKey(""); setTunnelId(harness?.tunnelId || ""); }}
          models={profile?.models || []} modelId={modelId}
          selectModel={event => { setModelId(event.target.value); setEffort(""); }} effort={effort} selectEffort={event => setEffort(event.target.value)}
          clientConfig={generated.config} configError={generated.error} copy={copySnippet} download={downloadSnippet} snippetNotice={snippetNotice}
        />}
        {tab === "preferences" && <ChatGPTWebPreferencesTab draft={draft} change={change} disabled={disabled || active || waiting || !profile} biggerSupported={biggerSupported} dirty={dirty} conflict={preferencesConflict} saving={busy === "Save preferences"} save={() => void act(`profiles/${profileId}`, { revision: baseRevision, settings: draft }, "Save preferences", "PATCH")} reload={() => { if (profile && !busyRef.current) { setDraft(profile.settings); setBaseRevision(profile.revision); dirtyRef.current = false; setDirty(false); setError(""); setNotice(""); } }} />}
        {tab === "diagnostics" && <ChatGPTWebDiagnosticsTab profile={profile} harness={harness} lease={lease} disabled={disabled || active || waiting || dirty || connectionDirty} sessionDisabled={harnessDisabled} busy={busy} refresh={() => setRefresh(value => value + 1)} restart={() => void act("browser/restart", { profileId }, "Restart browser")} verifyConnector={verifyConnector} modelTest={() => void act("smoke", { profileId, kind: "browser" }, "Browser smoke")} endLogin={() => void act("login/close", { loginId: lease.loginId }, "End login")} />}
        {tab === "diagnostics" && <div className="min-w-0 space-y-2 text-sm" aria-label="Runtime resource usage">
          <h3 className="font-medium">Runtime resource usage</h3>
          <p className="text-text-muted">Read-only snapshot. Refreshing these counts does not wake a browser.</p>
          {profile?.browser_state && <p>Selected browser: {profile.browser_state}{profile.catalog_verified !== undefined ? ` · Catalog verified: ${profile.catalog_verified ? "yes" : "no"}` : ""}</p>}
          {resourceReadError && <p role="status" className="text-amber-500">Resource counts unavailable: {resourceReadError}</p>}
          {resources && <>
            <p>Browsers {resources.browsers}/{resources.limits.maxGlobalBrowsers} · Conversation tabs {resources.tabs.active + resources.tabs.retainedNative + resources.tabs.retainedGeneric}/{resources.limits.maxGlobalTabs} · Inspection {resources.tabs.inspection} · Executing turns {resources.executingTurns}/{resources.limits.maxGlobalTurns} · Waiting on tools {resources.waitingToolTurns} · Queued {resources.queueDepth}/{resources.limits.maxQueueSize}</p>
            <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Physical browser and tab ownership by profile</caption><thead><tr>{["Profile", "Browser", "Executing", "Tool wait", "Active tabs", "Native retained", "Inspection", "Queue"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
              <tbody>{resources.profiles.map(item => <tr key={item.profileId}><th scope="row" className="p-2 break-all">{item.profileId}</th><td className="p-2">{item.browserState}</td><td className="p-2">{item.executingTurns}</td><td className="p-2">{item.waitingToolTurns}</td><td className="p-2">{item.tabs.active}</td><td className="p-2">{item.tabs.retainedNative}</td><td className="p-2">{item.tabs.inspection}</td><td className="p-2">{item.queueDepth}</td></tr>)}</tbody>
            </table></div>
            <p className="text-text-muted">Totals: admitted {resources.totals.admitted} · rejected {resources.totals.rejected} · queue wait {resources.totals.queueWaitMs} ms · polls {resources.totals.polls} · DOM cache hits {resources.totals.domCacheHits} / misses {resources.totals.domCacheMisses}</p>
          </>}
        </div>}
      </div>
      {viewerOpen && waiting && <ChatGPTWebViewer key={lease.loginId} connectionName={connectionName} loginId={lease.loginId} profileId={profileId} expiresAt={lease.expiresAt} manualLogin={lease.manualLogin} verifying={busy === "Finish Sign In"} error={error} onFinish={finishLogin} onClose={() => setViewerOpen(false)} onEnded={endViewer} />}
    </section>
  );
}
ChatGPTWebRuntimePanel.propTypes = { connectionName: PropTypes.string.isRequired, profileId: PropTypes.string.isRequired, selectedProfileId: PropTypes.string, onProfileSelected: PropTypes.func.isRequired, onChanged: PropTypes.func.isRequired, onViewerOpenChange: PropTypes.func.isRequired, onStateChange: PropTypes.func, connectionDirty: PropTypes.bool, connectionDetails: PropTypes.node, initialSignInMethod: PropTypes.oneOf(["browser", "extension"]), autoOpenSessionImport: PropTypes.bool };
