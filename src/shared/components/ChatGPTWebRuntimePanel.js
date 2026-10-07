"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import Input from "./Input";
import Select from "./Select";
import Toggle from "./Toggle";
import ChatGPTWebViewer from "./ChatGPTWebViewer";
import { MAX_SESSION_TRANSFER_BYTES, SessionTransferError, parseChatGptWebSessionTransfer } from "../../../services/chatgpt-web-runtime/session-transfer.js";
import { getChatGptWebProfileNotice } from "@/shared/utils/connectionStatus";

const BASE = "/api/providers/chatgpt-web/runtime";
const DEFAULT_SETTINGS = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const BIGGER_CONTEXT_ROUTES = new Set(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-5.6-pro", "chatgpt-web/gpt-6-pro"]);
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
export default function ChatGPTWebRuntimePanel({ connectionName, profileId, selectedProfileId = profileId, onProfileSelected, onChanged, onViewerOpenChange, autoStartLogin = false, autoOpenSessionImport = false }) {
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
  const [assistantOpen, setAssistantOpen] = useState(autoOpenSessionImport);
  const [importMode, setImportMode] = useState("extension");
  const [pastedSession, setPastedSession] = useState("");
  const [directTarget, setDirectTarget] = useState(null);
  const [targetConsumed, setTargetConsumed] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const targetElement = useRef(null);
  const targetRef = useRef(null);
  const consumedRef = useRef(false);
  const hasConsumedAttempt = useRef(false);
  const directInFlight = useRef(null);
  const prepareOnLoad = useRef(autoOpenSessionImport);
  const fileInput = useRef(null);
  const sessionFile = useRef(null);
  const autoStarted = useRef(false);
  const lifetime = useRef(null);
  const leaseRef = useRef(null);
  const busyRef = useRef(false);
  const baseRevision = useRef(null);
  const dirtyRef = useRef(false);
  const pollError = useRef("");
  const lastProfileEvidence = useRef(null);
  const profile = profiles.find(item => item.profileId === profileId);

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
  useEffect(() => { hasConsumedAttempt.current = false; }, [profileId]);
  useEffect(() => {
    prepareOnLoad.current = autoOpenSessionImport && !hasConsumedAttempt.current;
  }, [profileId, autoOpenSessionImport]);
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
            baseRevision.current = current.revision;
            setDraft(current.settings);
          }
          const evidence = JSON.stringify([current?.state, current?.settings?.mode, current?.lastError?.code, current?.models.map(model => model.id)]);
          const changed = lastProfileEvidence.current !== null && lastProfileEvidence.current !== evidence;
          lastProfileEvidence.current = evidence;
          if (changed) onChanged();
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
  const act = useCallback(async (action, body, label, method = "POST") => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return unknownImport();
    if (busyRef.current) return { ok: false, status: 409, code: "session_import_in_progress" };
    if (action !== "session/import") invalidateTarget();
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
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
      if (["login/start", "login/complete", "login/close", "session/verify", "session/import", "browser/restart", "smoke"].includes(action) || method === "PATCH") {
        // A completed lease alone is not readiness evidence. Reconcile the exact saved profile.
        const status = await request("profiles", {}, controller.signal);
        if (controller.signal.aborted) return unknownImport();
        updated = status.profiles?.find(item => item.profileId === profileId);
        if (!updated) throw new Error("invalid_runtime_response");
      }
      if (["session/verify", "session/import"].includes(action) && updated?.profileId !== body.profileId) throw new Error("invalid_runtime_response");
      if (updated) {
        setProfiles(previous => [...previous.filter(item => item.profileId !== updated.profileId), updated]);
        if (updated.profileId === profileId) { setDraft(updated.settings); baseRevision.current = updated.revision; dirtyRef.current = false; setDirty(false); }
      }
      setNoticeIsReadiness(["session/verify", "session/import"].includes(action) || (action === "login/complete" && data.state === "completed"));
      setNotice(["session/verify", "session/import"].includes(action) || (action === "login/complete" && data.state === "completed")
        ? getChatGptWebProfileNotice(updated)
        : data.message || (data.loginId ? (data.state === "waiting" ? "" : leaseNotice(data.state)) : `${label} completed.`));
      onChanged();
      return { ok: true, status: 200, code: null };
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause.message);
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
          dirtyRef.current = false; setDirty(false);
          if (profile) { setDraft(profile.settings); baseRevision.current = profile.revision; }
          if (cause.status === 409) setNotice("Refresh the profile, review the latest settings, then reapply your changes. Nothing was overwritten.");
        }
      }
      return controller.signal.aborted ? unknownImport() : failedImport(cause);
    } finally {
      if (!controller.signal.aborted) { busyRef.current = false; setBusy(""); }
    }
  }, [onChanged, profile, profileId, endViewer, invalidateTarget]);
  useEffect(() => {
    if (!autoStartLogin || autoStarted.current) return;
    const timer = setTimeout(() => {
      autoStarted.current = true;
      void act("login/start", { profileId }, "Start login");
    }, 0);
    return () => clearTimeout(timer);
  }, [autoStartLogin, profileId, act]);

  const change = (key, value) => {
    invalidateTarget();
    if (!dirtyRef.current) baseRevision.current = profile?.revision ?? null;
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
    importContext.current = { profileId, selectedProfileId, connectionName, blocked: active || waiting || viewerOpen || fenced || profile?.state === "probing" || !loaded || !profile || !secureImportOrigin };
  }, [profileId, selectedProfileId, connectionName, active, waiting, viewerOpen, fenced, profile, loaded, secureImportOrigin]);
  const prepareConnection = useCallback(() => {
    if (sessionDisabled || !secureImportOrigin || busyRef.current || dirty || selectedProfileId !== profileId) return;
    clearSessionFile();
    const target = Object.freeze({ version: 1, attemptId: crypto.randomUUID(), profileId, revision: profile.revision, connectionName, expiresAt: new Date(Date.now() + 300000).toISOString() });
    prepareOnLoad.current = false;
    targetRef.current = target; consumedRef.current = false;
    setDirectTarget(target); setTargetConsumed(false);
  }, [sessionDisabled, secureImportOrigin, dirty, selectedProfileId, profileId, profile, connectionName, clearSessionFile]);
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
    if (target && (importContext.current.blocked || (busy && directInFlight.current !== target.attemptId) || dirty || selectedProfileId !== target.profileId || (profile?.revision !== target.revision && !directInFlight.current) || (Date.parse(target.expiresAt) <= Date.now() && !directInFlight.current))) invalidateTarget();
    if (assistantOpen && importMode === "extension" && prepareOnLoad.current && !sessionDisabled && secureImportOrigin && !dirty && selectedProfileId === profileId) prepareConnection();
  }, [assistantOpen, importMode, sessionDisabled, busy, active, waiting, viewerOpen, loaded, profile?.state, secureImportOrigin, dirty, selectedProfileId, profileId, profile?.revision, prepareConnection, invalidateTarget]);
  useEffect(() => {
    if (!directTarget) return;
    const timer = setTimeout(() => { if (targetRef.current === directTarget && !directInFlight.current) invalidateTarget(); }, Math.max(0, Date.parse(directTarget.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [directTarget, invalidateTarget]);
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
      if (sessionDisabled || !secureImportOrigin || selectedProfileId !== snapshot.profileId || snapshot.profileId !== profileId || !controller || controller.signal.aborted) throw new SessionTransferError("session_target_unavailable", 409);
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
      else if (assistantOpen && importMode === "extension" && target && !consumedRef.current && target.attemptId === detail.attemptId && target.profileId === detail.profileId && target.connectionName === connectionName && selectedProfileId === detail.profileId && profileId === detail.profileId && detail.revision === target.revision && profile?.revision === target.revision && !sessionDisabled && secureImportOrigin && !dirty && !busyRef.current && fileInput.current?.files?.length === 1) {
        // Consume before await; the File ref is captured synchronously by the shared importer.
        consumedRef.current = true; hasConsumedAttempt.current = true; setTargetConsumed(true);
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
  const openAssistant = () => {
    if (assistantOpen) return;
    clearSessionFile(); invalidateTarget();
    prepareOnLoad.current = !hasConsumedAttempt.current;
    setImportMode("extension"); setAssistantOpen(true);
  };
  const closeAssistant = () => { clearSessionFile(); invalidateTarget(); setAssistantOpen(false); };
  const changeImportMode = mode => { clearSessionFile(); invalidateTarget(); setImportMode(mode); };
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
  const reconciledNotice = noticeIsReadiness ? getChatGptWebProfileNotice(profile) : notice;
  const humanStatus = error || reconciledNotice || (busy === "Finish Sign In" ? "Checking your sign-in…" : waiting && lease.manualLogin ? "Sign in in the browser, then choose Finish Sign In." : waiting ? "Browser session is open." : !loaded ? "Opening connection…" : getChatGptWebProfileNotice(profile));

  return (
    <section aria-label="ChatGPT Web connection" className="space-y-4 border-t border-border pt-4">
      <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-400" : "text-text-muted"}`}>{humanStatus}</p>
      {reconciledNotice && error && reconciledNotice !== "Connected and ready." && <p role="status" className="text-sm text-text-muted">{reconciledNotice}</p>}
      {connectionStatusWarning && <p role="status" className="text-sm text-amber-500">{connectionStatusWarning}</p>}
      <p className="text-xs text-text-muted">Browser-only: API key text requests. Full: signed Codex companion required.</p>
      <Button aria-label={needsLogin ? "Sign In" : "Open Browser"} disabled={disabled || (!profile && !waiting) || (needsLogin && active)} loading={busy === "Start login" || busy === "View browser"} onClick={openBrowser}>{needsLogin ? "Sign In" : "Open Browser"}</Button>
      {profile?.state !== "ready" && !waiting && <Button variant="secondary" disabled={sessionDisabled} loading={busy === "Use Saved Session"} onClick={verifySession}>Use Saved Session</Button>}
      <Button variant="secondary" onClick={openAssistant}>Import Chrome Session</Button>
      {assistantOpen && <section aria-label="Connect ChatGPT session" className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Connect ChatGPT session</h3>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={closeAssistant}>Close session assistant</Button>
        </div>
        <p className="text-xs text-text-muted">Sessions are credentials. Connect only to your trusted dashboard. Never send session files or JSON to support. Existing connections accept only the same ChatGPT account; use a new connection for another account.</p>
        <div role="tablist" aria-label="Session import method" className="flex flex-wrap gap-2" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)'));
          const index = tabs.indexOf(document.activeElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].focus(); tabs[next].click();
        }}>
          {[["extension", "Connect automatically"], ["paste", "Paste JSON"], ["file", "Upload file"]].map(([mode, label]) => <Button key={mode} id={`session-import-tab-${mode}`} role="tab" tabIndex={importMode === mode ? 0 : -1} aria-selected={importMode === mode} aria-controls={`session-import-panel-${mode}`} variant={importMode === mode ? "primary" : "secondary"} disabled={!!busy} onClick={() => changeImportMode(mode)}>{label}</Button>)}
        </div>
        {!secureImportOrigin && <p role="status" className="text-xs text-amber-500">Session import requires HTTPS except for loopback development. Open this dashboard over HTTPS to connect; download and setup instructions remain available.</p>}
        {sessionDisabled && secureImportOrigin && <p role="status" className="text-xs text-text-muted">Import is available when this profile is loaded and idle, with no private viewer or active turn. Finish or close the viewer and wait for the profile before importing.</p>}
        <div ref={targetElement} {...{ "data-9router-chatgpt-session-target": directTarget ? JSON.stringify(directTarget) : undefined, "data-9router-chatgpt-session-consumed": directTarget && targetConsumed ? "true" : undefined }} className="min-w-0 space-y-3">
          <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Chrome session file" {...{ "data-9router-chatgpt-session-file": "" }} hidden disabled={sessionDisabled || !secureImportOrigin} onChange={event => {
            const file = event.target.files?.length === 1 ? event.target.files[0] : null;
            sessionFile.current = file;
            setFileSelected(file ? { name: file.name, size: file.size } : null);
          }} />
          {importMode === "extension" && <div id="session-import-panel-extension" role="tabpanel" aria-labelledby="session-import-tab-extension" className="space-y-3 text-sm">
            <p>The desktop Chrome helper sends your signed-in session directly to this connection after you confirm the server and connection in its popup. Opening the helper does not send cookies.</p>
            <a href="/downloads/chatgpt-web-session-export.zip" download="chatgpt-web-session-export.zip" className="inline-block rounded-lg border border-border px-3 py-2 text-brand-500 hover:bg-surface-2">Download Chrome helper</a>
            <details className="space-y-2 rounded-lg border border-border p-3">
              <summary className="cursor-pointer font-medium">First-time setup or update</summary>
              <ol className="list-decimal space-y-2 pl-5">
                <li>Download the Chrome helper above and extract the ZIP into a folder. For an update, replace the old extracted helper and reload it in Chrome.</li>
                <li>Copy <code className="break-all">chrome://extensions</code> into Chrome’s address bar. <Button size="sm" variant="secondary" onClick={async () => {
                  try { await navigator.clipboard.writeText("chrome://extensions"); setClipboardNotice("Extensions address copied."); }
                  catch { setClipboardNotice("Copy was blocked. Type chrome://extensions in the address bar."); }
                }}>Copy extensions address</Button></li>
                <li>Enable Developer mode, choose Load unpacked, and select the extracted <code className="break-all">chatgpt-web-session-export</code> folder containing <code>manifest.json</code>.</li>
                <li>Sign in at <a href="https://chatgpt.com" target="_blank" rel="noopener noreferrer" className="text-brand-500 underline">chatgpt.com</a> using this same Chrome profile. Complete sign-in or MFA yourself.</li>
                <li>Return to this dashboard tab. Open the helper with its extension icon or <kbd>Alt+Shift+9</kbd>.</li>
                <li>Check the server address and connection below against the helper, then choose <strong>Connect to this 9Router</strong> in its popup.</li>
              </ol>
              {clipboardNotice && <p role="status" className="text-xs text-text-muted">{clipboardNotice}</p>}
            </details>
            <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-xs break-all">
              <p>Server: <strong>{typeof window !== "undefined" ? window.location.origin : ""}</strong></p>
              <p>Connection: <strong>{connectionName}</strong></p>
              <p>Profile ID: <strong>{profileId}</strong></p>
            </div>
            <p role="status" className="text-xs text-text-muted">{directTarget ? targetConsumed ? "This attempt has been consumed. Check the connection status; use Prepare connection only for a new explicit attempt." : "Connection prepared for five minutes. Confirm these details in the Chrome helper." : "No connection attempt is prepared. Choose Prepare connection when the saved profile is idle."}</p>
            <Button variant="secondary" disabled={sessionDisabled || !secureImportOrigin || dirty || selectedProfileId !== profileId} onClick={prepareConnection}>Prepare connection</Button>
            <p className="text-xs text-text-muted">Desktop Chrome is the supported helper browser. On mobile, Firefox, or Safari, use the private browser below, or paste/upload a session exported from desktop Chrome. The dashboard does not detect whether the helper is installed.</p>
          </div>}
          {importMode === "paste" && <div id="session-import-panel-paste" role="tabpanel" aria-labelledby="session-import-tab-paste" className="space-y-3">
            <p className="text-sm text-text-muted">Choose Copy Session JSON in the Chrome helper, paste it here, then explicitly import. Pasting alone sends nothing. Clipboard history may retain this credential.</p>
            <textarea aria-label="Session JSON" autoComplete="off" spellCheck={false} value={pastedSession} onChange={event => setPastedSession(event.target.value)} disabled={sessionDisabled || !secureImportOrigin} rows={6} className="w-full min-w-0 rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs text-text-main" />
            <Button disabled={sessionDisabled || !secureImportOrigin || !pastedSession.trim()} loading={busy === "Read pasted session" || busy === "Import session"} onClick={() => void importSession("paste")}>Import pasted session</Button>
          </div>}
          {importMode === "file" && <div id="session-import-panel-file" role="tabpanel" aria-labelledby="session-import-tab-file" className="space-y-3">
            <p className="text-sm text-text-muted">Choose Export ChatGPT Session in the Chrome helper, then select its JSON file. Selection alone does not read or upload it. Delete the local credential file after import.</p>
            <Button variant="secondary" disabled={sessionDisabled || !secureImportOrigin} onClick={() => fileInput.current?.click()}>Choose session file</Button>
            {fileSelected && <p className="break-all text-xs text-text-muted">{fileSelected.name} · {fileSelected.size.toLocaleString()} bytes</p>}
            <Button disabled={sessionDisabled || !secureImportOrigin || !fileSelected} loading={busy === "Read session file" || busy === "Import session"} onClick={() => void importSession("file")}>Import selected session</Button>
          </div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!!busy} onClick={() => { clearSessionFile(); invalidateTarget(); }}>Cancel import</Button>
          <Button variant="secondary" disabled={disabled || (!profile && !waiting) || (needsLogin && active)} onClick={openBrowser}>Use private browser instead</Button>
        </div>
        <p className="text-xs text-text-muted">The private browser needs no exported session. Sign in or complete MFA in its viewer, then choose Finish Sign In to verify and save the session.</p>
      </section>}
      {viewerOpen && waiting && <ChatGPTWebViewer key={lease.loginId} connectionName={connectionName} loginId={lease.loginId} profileId={profileId} expiresAt={lease.expiresAt} manualLogin={lease.manualLogin} verifying={busy === "Finish Sign In"} error={error} onFinish={finishLogin} onClose={() => setViewerOpen(false)} onEnded={endViewer} />}
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm text-text-muted">Advanced</summary>
        <Input label="Selected profile ID" aria-label="Selected profile ID" value={selectedProfileId} readOnly />
        {!!profiles.length && <Select label="Existing profiles" value={selectedProfileId} options={profiles.map(item => ({ value: item.profileId, label: `${item.profileId} — ${item.state.replaceAll("_", " ")}` }))} onChange={event => { clearSessionFile(); invalidateTarget(); onProfileSelected(event.target.value); }} disabled={!!busy} hint="Selecting changes the connection draft only. Save the connection above to switch profiles. Shared profiles share browser settings and the five-turn limit." />}
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
        {loaded && !profile && <p className="text-sm text-text-muted">The saved runtime profile is unavailable. Refresh or contact the operator; no replacement profile will be created silently.</p>}
        {profile && <>
        <div className="rounded-lg bg-surface-2 p-3 text-sm space-y-1">
          <p>State: <strong>{profile.state.replaceAll("_", " ")}</strong></p>
          <p>Active browser turns: {profile.activeTurns} / 5 · Settings revision: {profile.revision}</p>
          <p>Native2 connector / tunnel: {profile.connectorReady ? "ready" : "not ready"}</p>
          {profile.lastError && <p role="status" className="text-amber-500">{profile.lastError.message}</p>}
          {profile.state === "waiting_for_chatgpt_tool_approval" && <p>Open Browser and approve the exact active connector prompt once before the approval timeout.</p>}
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Verified models and reasoning efforts</h4>
          {profile.models.length ? <ul className="space-y-2 text-sm">{profile.models.map(model => <li key={model.id} className="rounded-lg bg-surface-2 p-2">
            <p>{model.display_name}{model.legacy ? " (legacy)" : ""}</p>
            <p className="text-xs text-text-muted break-all">{model.id} · Efforts: {model.supported_reasoning_levels.join(", ")} · Default: {model.default_reasoning_level || "unknown"}{model.model_family ? ` · Family: ${model.model_family}` : ""}{model.context_window ? ` · Context: ${model.context_window.toLocaleString()}` : ""}</p>
          </li>)}</ul> : <p className="text-sm text-text-muted">No verified models yet. Sign in in the browser, then choose Finish Sign In to verify your account.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {profile.state === "ready" && <Button size="sm" variant="secondary" disabled={sessionDisabled} loading={busy === "Use Saved Session"} onClick={verifySession}>Use Saved Session</Button>}
          <Button size="sm" variant="secondary" disabled={disabled || active || waiting} loading={busy === "Start login"} onClick={() => act("login/start", { profileId }, "Start login")}>Start Login</Button>
          <Button size="sm" variant="secondary" disabled={disabled} loading={busy === "View browser"} onClick={() => { clearSessionFile(); invalidateTarget(); setAssistantOpen(false); if (waiting) setViewerOpen(true); else void act("browser/view", { profileId }, "View browser"); }}>View Browser</Button>
          <Button size="sm" variant="secondary" disabled={disabled || active || waiting} loading={busy === "Restart browser"} onClick={() => act("browser/restart", { profileId }, "Restart browser")}>Restart Browser</Button>
        </div>
        <p className="text-xs text-text-muted">Login and restart require an idle profile. View Browser opens the existing private desktop for approvals, without restarting active turns.</p>
        {lease && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm space-y-2">
          <p>Private browser: {lease.state} · Expires: {new Date(lease.expiresAt).toLocaleString()}</p>
          {lease.state === "waiting" && <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} loading={busy === "End login"} onClick={() => act("login/close", { loginId: lease.loginId }, "End login")}>End Login</Button>
          </div>}
        </div>}
        <div className="space-y-4">
          <Select label="Harness mode" value={draft.mode} options={[{ value: "browser-only", label: "Browser-only — API key text requests" }, { value: "full", label: "Full — signed Codex companion required" }]} onChange={event => change("mode", event.target.value)} disabled={disabled || active} hint="Full requires both a signed Codex companion and operator-provisioned Native2 connector/tunnel authority. Browser sign-in alone does not grant local tool access." />
          <Toggle label="Bigger Context" checked={draft.experimentalBiggerContext} onChange={value => change("experimentalBiggerContext", value)} disabled={disabled || active || !biggerSupported} description="Supported Sol/Pro routes only. Multipart staging increases latency and total context, not the per-message limit. Luna does not use multipart." />
          <Select label="Conversation mode" value={draft.experimentalFreshConversationPerTurn ? "fresh" : "retain"} options={[{ value: "retain", label: "Retain" }, { value: "fresh", label: "New each turn" }]} onChange={event => change("experimentalFreshConversationPerTurn", event.target.value === "fresh")} disabled={disabled || active} hint="New each turn starts a new conversation between human turns; tool-result rounds remain in the active conversation." />
          <Select label="Chat storage" value={draft.useSavedChats ? "saved" : "temporary"} options={[{ value: "temporary", label: "Temporary" }, { value: "saved", label: "Saved" }]} onChange={event => change("useSavedChats", event.target.value === "saved")} disabled={disabled || active} hint="Saved chats may apply ChatGPT Memory and custom instructions. Temporary is the default." />
          {draft.mode === "full" && <Toggle label="Automatically approve one-time ChatGPT tool prompts" checked={draft.autoApproveToolCalls} onChange={value => change("autoApproveToolCalls", value)} disabled={disabled || active} description="Only Allow once for the active Codex Native2 connector. Outer Codex sandbox and approval policy still apply. Never grants Allow always." />}
          <p className="text-xs text-text-muted">Connector: Codex Native2. Runtime settings belong to this profile and are not stored on the 9router connection.</p>
          <Button variant="secondary" disabled={disabled || active || !dirty || !profile} loading={busy === "Save settings"} onClick={() => act(`profiles/${profileId}`, { revision: baseRevision.current, settings: draft }, "Save settings", "PATCH")}>Save runtime settings</Button>
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs text-text-muted">Smoke actions run only when clicked and may send a real model turn. Harness diagnostics do not prove local Codex tool execution without a companion-observed staging smoke. No arbitrary shell tools are submitted.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={disabled || active} loading={busy === "Browser smoke"} onClick={() => act("smoke", { profileId, kind: "browser" }, "Browser smoke")}>Run browser smoke</Button>
            <Button size="sm" variant="secondary" disabled={disabled || active} loading={busy === "Harness smoke"} onClick={() => act("smoke", { profileId, kind: "harness" }, "Harness smoke")}>Run harness diagnostics</Button>
          </div>
        </div>
      </>}
      </details>
    </section>
  );
}
ChatGPTWebRuntimePanel.propTypes = { connectionName: PropTypes.string.isRequired, profileId: PropTypes.string.isRequired, selectedProfileId: PropTypes.string, onProfileSelected: PropTypes.func.isRequired, onChanged: PropTypes.func.isRequired, onViewerOpenChange: PropTypes.func.isRequired, autoStartLogin: PropTypes.bool, autoOpenSessionImport: PropTypes.bool };
