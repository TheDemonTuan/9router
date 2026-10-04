"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import Select from "./Select";
import Toggle from "./Toggle";
import ChatGPTWebViewer from "./ChatGPTWebViewer";

const BASE = "/api/providers/chatgpt-web/runtime";
const DEFAULT_SETTINGS = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const BIGGER_CONTEXT_ROUTES = new Set(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/gpt-5.6-pro", "chatgpt-web/gpt-6-pro"]);
async function request(action, init, signal) {
  const response = await fetch(`${BASE}/${action}`, { cache: "no-store", ...init, signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || "Runtime action failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

const leaseNotice = state => ({ completed: "Login completed. Browser verification is ready.", expired: "Private browser lease expired. Start a new login to continue.", closed: "Private browser lease closed.", error: "Login verification failed. Review profile diagnostics and start a new login." }[state] || "Private browser session ended.");

// Mounted only inside an open modal. Polling never sends a model or tool request.
export default function ChatGPTWebRuntimePanel({ profileId, selectedProfileId = profileId, onProfileSelected, onChanged, autoStartLogin = false }) {
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
  const autoStarted = useRef(false);
  const lifetime = useRef(null);
  const leaseRef = useRef(null);
  const busyRef = useRef(false);
  const baseRevision = useRef(null);
  const dirtyRef = useRef(false);
  const profile = profiles.find(item => item.profileId === profileId);

  const endViewer = useCallback(state => {
    const current = leaseRef.current;
    if (current) { const ended = { ...current, state }; leaseRef.current = ended; setLease(ended); }
    setViewerOpen(false); setNotice(leaseNotice(state));
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
                if (!controller.signal.aborted && leaseRef.current?.loginId === activeLease.loginId) {
                  if (status.profileId !== profileId || status.loginId !== activeLease.loginId) throw new Error("Private viewer session changed. Start a new login.");
                  leaseRef.current = status; setLease(status);
                  if (status.state !== "waiting") { setViewerOpen(false); setNotice(leaseNotice(status.state)); onChanged(); }
                }
              } catch (cause) {
                if ([404, 410].includes(cause.status) && !controller.signal.aborted) endViewer("closed");
                else throw cause;
              }
            }
          }
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
      if (data.loginId) {
        if (data.profileId !== profileId) throw new Error("Private browser session does not match this connection.");
        leaseRef.current = data; setLease(data); setViewerOpen(data.state === "waiting");
      }
      const updated = data.profile || (data.profileId && data.settings ? data : null);
      if (updated) {
        setProfiles(previous => [...previous.filter(item => item.profileId !== updated.profileId), updated]);
        if (updated.profileId === profileId) { setDraft(updated.settings); baseRevision.current = updated.revision; dirtyRef.current = false; setDirty(false); }
      }
      setNotice(data.message || (data.loginId ? (data.state === "waiting" ? "Private browser opened below. Sign in; verification runs automatically." : leaseNotice(data.state)) : `${label} completed.`));
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause.message);
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
  }, [onChanged, profile, profileId]);
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

  return (
    <section aria-label="Runtime profile" className="space-y-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Runtime profile</h3>
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
      </div>
      {!!profiles.length && <details><summary className="cursor-pointer text-sm text-text-muted">Advanced: choose an existing profile</summary><Select label="Existing profiles" value={selectedProfileId} options={profiles.map(item => ({ value: item.profileId, label: `${item.profileId} — ${item.state.replaceAll("_", " ")}` }))} onChange={event => onProfileSelected(event.target.value)} disabled={!!busy} hint="Selecting changes the connection draft only. Save the connection above to switch profiles." /></details>}
      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
      {notice && <div role="status" className="rounded-lg bg-surface-2 p-3 text-sm">{notice}</div>}
      {!loaded && !error && <p role="status" className="text-sm text-text-muted">Loading runtime profiles…</p>}
      {loaded && !profile && <p role="status" className="text-sm text-text-muted">The saved runtime profile is unavailable. Refresh or contact the operator; no replacement profile will be created silently.</p>}
      {profile && <>
        <div className="rounded-lg bg-surface-2 p-3 text-sm space-y-1">
          <p>State: <strong>{profile.state.replaceAll("_", " ")}</strong></p>
          <p>Active browser turns: {profile.activeTurns} / 5 · Settings revision: {profile.revision}</p>
          <p>Native2 connector / tunnel: {profile.connectorReady ? "ready" : "not ready"}</p>
          {profile.lastError && <p role="status" className="text-amber-500">{profile.lastError.message}</p>}
          {profile.state === "waiting_for_chatgpt_tool_approval" && <p role="status">Open View Browser and approve the exact active connector prompt once before the approval timeout.</p>}
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Verified models and reasoning efforts</h4>
          {profile.models.length ? <ul className="space-y-2 text-sm">{profile.models.map(model => <li key={model.id} className="rounded-lg bg-surface-2 p-2">
            <p>{model.display_name}{model.legacy ? " (legacy)" : ""}</p>
            <p className="text-xs text-text-muted break-all">{model.id} · Efforts: {model.supported_reasoning_levels.join(", ")} · Default: {model.default_reasoning_level || "unknown"}{model.model_family ? ` · Family: ${model.model_family}` : ""}{model.context_window ? ` · Context: ${model.context_window.toLocaleString()}` : ""}</p>
          </li>)}</ul> : <p className="text-sm text-text-muted">No verified models yet. Sign in below; the runtime verifies the browser automatically.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={disabled || active || lease?.state === "waiting"} loading={busy === "Start login"} onClick={() => act("login/start", { profileId }, "Start login")}>Start Login</Button>
          <Button size="sm" variant="secondary" disabled={disabled} loading={busy === "View browser"} onClick={() => lease?.state === "waiting" ? setViewerOpen(true) : act("browser/view", { profileId }, "View browser")}>View Browser</Button>
          <Button size="sm" variant="secondary" disabled={disabled || active} loading={busy === "Restart browser"} onClick={() => act("browser/restart", { profileId }, "Restart browser")}>Restart Browser</Button>
        </div>
        <p className="text-xs text-text-muted">Login and restart require an idle profile. View Browser opens the existing private desktop for approvals, without restarting active turns.</p>
        {lease && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm space-y-2">
          <p>Private browser: {lease.state} · Expires: {new Date(lease.expiresAt).toLocaleString()}</p>
          {lease.state === "waiting" && <div className="flex flex-wrap gap-2">
            {viewerOpen && <Button size="sm" variant="secondary" onClick={() => setViewerOpen(false)}>Close viewer</Button>}
            <Button size="sm" variant="secondary" disabled={!!busy} loading={busy === "End login"} onClick={() => act("login/close", { loginId: lease.loginId }, "End login")}>End Login</Button>
          </div>}
        </div>}
        {viewerOpen && lease?.state === "waiting" && <ChatGPTWebViewer key={lease.loginId} loginId={lease.loginId} profileId={profileId} expiresAt={lease.expiresAt} onEnded={endViewer} />}
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
    </section>
  );
}
ChatGPTWebRuntimePanel.propTypes = { profileId: PropTypes.string.isRequired, selectedProfileId: PropTypes.string, onProfileSelected: PropTypes.func.isRequired, onChanged: PropTypes.func.isRequired, autoStartLogin: PropTypes.bool };
