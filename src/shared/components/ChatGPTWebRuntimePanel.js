"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import Input from "./Input";
import Select from "./Select";
import Toggle from "./Toggle";
import ChatGPTWebViewer from "./ChatGPTWebViewer";
import { MAX_SESSION_TRANSFER_BYTES, SessionTransferError, parseChatGptWebSessionTransfer } from "../../../services/chatgpt-web-runtime/session-transfer.js";

const BASE = "/api/providers/chatgpt-web/runtime";
const DEFAULT_SETTINGS = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const BIGGER_CONTEXT_ROUTES = new Set(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-5.6-pro", "chatgpt-web/gpt-6-pro"]);
const IMPORT_ERRORS = {
  invalid_session_transfer: "Invalid ChatGPT session file. Export a new file with the 9Router Chrome exporter.",
  session_transfer_expired: "The exported cookies have expired. Sign in in Chrome and export again.",
  session_transfer_too_large: "The session file exceeds the 256 KiB limit.",
};
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

const leaseNotice = state => ({ completed: "Signed in. Connection is ready.", expired: "Browser session expired. Open a new session to continue.", closed: "Browser session ended.", error: "Sign-in verification failed. Open a new session to try again." }[state] || "Browser session ended.");
const LEASE_STATES = new Set(["waiting", "completed", "expired", "closed", "error"]);
function validLease(value, profileId, loginId) {
  return value?.profileId === profileId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.loginId || "") && (!loginId || value.loginId === loginId) && typeof value.manualLogin === "boolean" && LEASE_STATES.has(value.state) && Number.isFinite(Date.parse(value.expiresAt));
}

// Profile/status reads never send a model or tool request. Human sign-in is verified only on request.
export default function ChatGPTWebRuntimePanel({ connectionName, profileId, selectedProfileId = profileId, onProfileSelected, onChanged, onViewerOpenChange, autoStartLogin = false }) {
  const [profiles, setProfiles] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [lease, setLease] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [fileSelected, setFileSelected] = useState(false);
  const fileInput = useRef(null);
  const sessionFile = useRef(null);
  const autoStarted = useRef(false);
  const lifetime = useRef(null);
  const leaseRef = useRef(null);
  const busyRef = useRef(false);
  const baseRevision = useRef(null);
  const dirtyRef = useRef(false);
  const profile = profiles.find(item => item.profileId === profileId);

  useEffect(() => () => { sessionFile.current = null; if (fileInput.current) fileInput.current.value = ""; }, [profileId]);
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
          const current = data.profiles.find(item => item.profileId === profileId);
          if (current && !dirtyRef.current) {
            baseRevision.current = current.revision;
            setDraft(current.settings);
          }
          const activeLease = leaseRef.current;
          if (activeLease?.state === "waiting") {
            if (Date.parse(activeLease.expiresAt) <= Date.now()) {
              endViewer("expired");
            } else {
              try {
                const status = await request(`login/status?loginId=${encodeURIComponent(activeLease.loginId)}`, {}, controller.signal);
                if (!controller.signal.aborted && !busyRef.current && leaseRef.current === activeLease) {
                  if (!validLease(status, profileId, activeLease.loginId)) throw new Error("Private viewer session changed. Open a new session.");
                  leaseRef.current = status; setLease(status);
                  if (status.state !== "waiting") { endViewer(status.state); onChanged(); }
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
        if (!controller.signal.aborted) setError(cause.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [profileId, refresh, endViewer, onChanged]);
  const act = useCallback(async (action, body, label, method = "POST") => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try {
      const data = await request(action, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, controller.signal);
      if (controller.signal.aborted) return;
      if (["login/start", "login/complete", "login/close", "browser/view"].includes(action)) {
        if (!validLease(data, profileId, body.loginId) || (action === "login/complete" && data.state === "waiting" && !data.manualLogin)) throw new Error("Private browser session does not match this connection.");
        leaseRef.current = data; setLease(data);
        if (action === "login/complete") setViewerOpen(previous => previous && data.state === "waiting");
        else setViewerOpen(data.state === "waiting");
        if (action === "login/complete" && data.state === "waiting") setError("Sign-in is not verified yet. Continue in the browser, then choose Finish Sign In again.");
      }
      const updated = data.profile || (data.profileId && data.settings ? data : null);
      if (["session/verify", "session/import"].includes(action) && updated?.profileId !== body.profileId) throw new Error("invalid_runtime_response");
      if (updated) {
        setProfiles(previous => [...previous.filter(item => item.profileId !== updated.profileId), updated]);
        if (updated.profileId === profileId) { setDraft(updated.settings); baseRevision.current = updated.revision; dirtyRef.current = false; setDirty(false); }
      }
      setNotice(["session/verify", "session/import"].includes(action) ? (updated.state === "ready" ? "Connected and ready." : "Session is not ready. Check Advanced for diagnostics.") : data.message || (data.loginId ? (data.state === "waiting" ? "" : leaseNotice(data.state)) : `${label} completed.`));
      onChanged();
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
            if (controller.signal.aborted) return;
            if (!validLease(status, profileId, body.loginId) || (status.state === "waiting" && !status.manualLogin)) throw new Error("Invalid sign-in session status.");
            leaseRef.current = status; setLease(status);
            setViewerOpen(previous => previous && status.state === "waiting");
            if (status.state !== "waiting") {
              setNotice(leaseNotice(status.state));
              setError(status.state === "completed" ? "" : `${leaseNotice(status.state)} ${cause.message}`);
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
    } finally {
      if (!controller.signal.aborted) { busyRef.current = false; setBusy(""); }
    }
  }, [onChanged, profile, profileId, endViewer]);
  useEffect(() => {
    if (!autoStartLogin || autoStarted.current) return;
    const timer = setTimeout(() => {
      autoStarted.current = true;
      void act("login/start", { profileId }, "Start login");
    }, 0);
    return () => clearTimeout(timer);
  }, [autoStartLogin, profileId, act]);

  const change = (key, value) => {
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
  const sessionDisabled = disabled || active || waiting || !loaded || !profile;
  const verifySession = () => act("session/verify", { profileId, revision: profile.revision }, "Use Saved Session");
  const secureImportOrigin = typeof window !== "undefined" && (window.location.protocol === "https:" || (window.location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname.toLowerCase())));
  const clearSessionFile = () => {
    sessionFile.current = null; setFileSelected(false);
    if (fileInput.current) fileInput.current.value = "";
  };
  const importSession = async () => {
    if (sessionDisabled || !secureImportOrigin || busyRef.current || !sessionFile.current) return;
    const file = sessionFile.current;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    busyRef.current = true; setBusy("Read session file"); setError(""); setNotice("");
    try {
      if (file.size > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
      let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
      catch { throw new SessionTransferError("invalid_session_transfer", 400); }
      if (controller.signal.aborted) return;
      const body = { profileId, revision: profile.revision, session: { format: "9router-chatgpt-session", version: 1, cookies: parseChatGptWebSessionTransfer(value) } };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
      busyRef.current = false;
      await act("session/import", body, "Import session");
    } catch (cause) {
      if (!controller.signal.aborted) setError(IMPORT_ERRORS[cause.code] || IMPORT_ERRORS.invalid_session_transfer);
    } finally {
      clearSessionFile();
      if (!controller.signal.aborted) { busyRef.current = false; setBusy(""); }
    }
  };
  const openBrowser = () => {
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
  const humanStatus = error || notice || (busy === "Finish Sign In" ? "Checking your sign-in…" : waiting && lease.manualLogin ? "Sign in in the browser, then choose Finish Sign In." : waiting ? "Browser session is open." : ({ ready: "Connected and ready.", probing: "Checking your sign-in…", draining: "Connection temporarily unavailable.", waiting_for_chatgpt_tool_approval: "Open Browser to approve the active prompt.", error: "Sign-in needs attention. Try Sign In or see Advanced." }[profile?.state] || (!loaded ? "Opening connection…" : profile ? "Sign in to connect your account." : "Connection unavailable. See Advanced or contact the operator.")));

  return (
    <section aria-label="ChatGPT Web connection" className="space-y-4 border-t border-border pt-4">
      <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-400" : "text-text-muted"}`}>{humanStatus}</p>
      {notice && error && <p role="status" className="text-sm text-text-muted">{notice}</p>}
      <Button aria-label={needsLogin ? "Sign In" : "Open Browser"} disabled={disabled || (!profile && !waiting) || (needsLogin && active)} loading={busy === "Start login" || busy === "View browser"} onClick={openBrowser}>{needsLogin ? "Sign In" : "Open Browser"}</Button>
      {profile?.state !== "ready" && !waiting && <Button variant="secondary" disabled={sessionDisabled} loading={busy === "Use Saved Session"} onClick={verifySession}>Use Saved Session</Button>}
      <Button variant="secondary" disabled={sessionDisabled || !secureImportOrigin} onClick={() => fileInput.current?.click()}>Import Chrome Session</Button>
      <input ref={fileInput} type="file" accept=".json,application/json" aria-label="Chrome session file" hidden disabled={sessionDisabled || !secureImportOrigin} onChange={event => { sessionFile.current = event.target.files?.[0] || null; setFileSelected(!!sessionFile.current); }} />
      <p className="text-xs text-text-muted">Session files are credentials. Import only into your trusted dashboard, then delete the local file. An existing connection accepts only the same ChatGPT account; use a new connection for another account.</p>
      {!secureImportOrigin && <p role="status" className="text-xs text-amber-500">Session import requires HTTPS except for loopback development.</p>}
      {fileSelected && <div className="flex flex-wrap gap-2">
        <Button disabled={sessionDisabled || !secureImportOrigin} loading={busy === "Read session file" || busy === "Import session"} onClick={importSession}>Import selected session</Button>
        <Button variant="secondary" disabled={!!busy} onClick={clearSessionFile}>Cancel import</Button>
      </div>}
      {viewerOpen && waiting && <ChatGPTWebViewer key={lease.loginId} connectionName={connectionName} loginId={lease.loginId} profileId={profileId} expiresAt={lease.expiresAt} manualLogin={lease.manualLogin} verifying={busy === "Finish Sign In"} error={error} onFinish={finishLogin} onClose={() => setViewerOpen(false)} onEnded={endViewer} />}
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm text-text-muted">Advanced</summary>
        <Input label="Selected profile ID" aria-label="Selected profile ID" value={selectedProfileId} readOnly />
        {!!profiles.length && <Select label="Existing profiles" value={selectedProfileId} options={profiles.map(item => ({ value: item.profileId, label: `${item.profileId} — ${item.state.replaceAll("_", " ")}` }))} onChange={event => onProfileSelected(event.target.value)} disabled={!!busy} hint="Selecting changes the connection draft only. Save the connection above to switch profiles. Shared profiles share browser settings and the five-turn limit." />}
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
          <Button size="sm" variant="secondary" disabled={disabled} loading={busy === "View browser"} onClick={() => waiting ? setViewerOpen(true) : act("browser/view", { profileId }, "View browser")}>View Browser</Button>
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
          <Select label="Harness mode" value={draft.mode} options={[{ value: "browser-only", label: "Browser-only" }, { value: "full", label: "Full — verified Native2 connector required" }]} onChange={event => change("mode", event.target.value)} disabled={disabled || active} hint="Full is enabled only after the runtime accepts the provisioned tunnel and connector prerequisites." />
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
ChatGPTWebRuntimePanel.propTypes = { connectionName: PropTypes.string.isRequired, profileId: PropTypes.string.isRequired, selectedProfileId: PropTypes.string, onProfileSelected: PropTypes.func.isRequired, onChanged: PropTypes.func.isRequired, onViewerOpenChange: PropTypes.func.isRequired, autoStartLogin: PropTypes.bool };
