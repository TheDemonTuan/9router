"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ChatGPTWebRuntimePanel from "./ChatGPTWebRuntimePanel";

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export default function AddChatGPTWebRuntimeModal({ isOpen, connection, onClose, onSaved }) {
  const [savedConnection, setSavedConnection] = useState(connection || null);
  const [name, setName] = useState(connection?.name || "ChatGPT Web");
  const [profileId, setProfileId] = useState(connection?.providerSpecificData?.profileId || "");
  const [saving, setSaving] = useState(false);
  const [signInMethod, setSignInMethod] = useState(() => typeof navigator !== "undefined" && /Chrome\//.test(navigator.userAgent) && !/Android|Mobile|Edg\//.test(navigator.userAgent) ? "extension" : "browser");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [runtimeState, setRuntimeState] = useState({ dirty: false, busy: false, status: "Loading" });
  const [discard, setDiscard] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef(null);
  const savingRef = useRef(false);
  const content = useRef(null);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    return () => current.abort();
  }, [isOpen, connection]);
  useEffect(() => {
    if (!isOpen || viewerOpen) return;
    const trapFocus = event => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const dialog = content.current?.closest('[role="dialog"]');
      if (!dialog || dialog.closest("[inert]")) return;
      const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]'))
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length && !element.closest("[inert]"));
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement) || document.activeElement === dialog || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [isOpen, viewerOpen]);
  const hasChanges = !!savedConnection && (name.trim() !== savedConnection.name || profileId.trim() !== savedConnection.providerSpecificData?.profileId);
  const close = () => {
    if (savingRef.current || runtimeState.busy) return;
    if (hasChanges || runtimeState.dirty) { setDiscard(true); return; }
    onClose();
  };
  const save = async () => {
    const current = controller.current;
    if (!current || current.signal.aborted || savingRef.current || uncertain || runtimeState.busy) return;
    savingRef.current = true; setSaving(true); setError("");
    const editing = !!savedConnection;
    let rejected = false;
    try {
      const payload = editing ? { name: name.trim(), providerSpecificData: { profileId: profileId.trim() } } : { provider: "chatgpt-web", name: name.trim() };
      if (editing && profileId.trim() !== savedConnection.providerSpecificData?.profileId) payload.testStatus = "login_required";
      const response = await fetch(editing ? `/api/providers/${savedConnection.id}` : "/api/providers", { method: editing ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: current.signal });
      rejected = !response.ok;
      const data = await response.json();
      if (!response.ok) {
        if (!editing && response.status >= 500) setUncertain(true);
        throw new Error(typeof data.error === "string" ? data.error : "Failed to save connection.");
      }
      if (!data.connection?.id || !PROFILE_ID.test(data.connection.providerSpecificData?.profileId || "")) {
        if (!editing) setUncertain(true);
        throw new Error("The save response was incomplete. Close and refresh connections before trying again.");
      }
      if (current.signal.aborted) return;
      setSavedConnection(data.connection); setName(data.connection.name);
      setProfileId(data.connection.providerSpecificData.profileId); setDiscard(false);
      onSaved();
    } catch (cause) {
      if (!current.signal.aborted) {
        if (!editing && !rejected) setUncertain(true);
        setError(cause.message || "The save was not retried. Refresh connections before trying again.");
      }
    } finally {
      savingRef.current = false;
      if (!current.signal.aborted) setSaving(false);
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={close} suspended={viewerOpen} size={savedConnection ? "full" : "xl"} className="max-h-[calc(100dvh-2rem)]" title={savedConnection ? <span className="flex flex-wrap items-center gap-2">{savedConnection.name}<span className="rounded-full bg-surface-2 px-2 py-1 text-xs font-normal">{runtimeState.status}</span></span> : "Add ChatGPT Web connection"} footer={discard ? <div role="alert" className="flex w-full flex-wrap items-center justify-end gap-2"><p className="mr-auto text-sm">Discard unsaved changes?</p><Button variant="secondary" onClick={() => setDiscard(false)}>Keep editing</Button><Button disabled={saving || runtimeState.busy} onClick={onClose}>Discard changes</Button></div> : <><Button variant="secondary" disabled={saving || runtimeState.busy} onClick={close}>{savedConnection ? "Close" : "Cancel"}</Button>{!savedConnection && <Button onClick={save} loading={saving} disabled={uncertain || !name.trim()}>Continue</Button>}</>}>
      <div ref={content} className="min-w-0 space-y-4">
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        {uncertain && <p role="status" className="text-sm text-amber-500">The save was not retried. Close and refresh the connection list before adding again to avoid duplicates.</p>}
        {!savedConnection ? <>
          <Input label="Connection name" aria-label="Connection name" id="chatgpt-web-connection-name" value={name} onChange={event => setName(event.target.value)} autoFocus disabled={saving || uncertain} />
          <fieldset disabled={saving || uncertain} className="space-y-3"><legend className="mb-2 text-sm font-medium">Sign-in method</legend><div className="grid gap-3 sm:grid-cols-2">{[["extension", "Chrome extension", "Use your signed-in desktop Chrome session."], ["browser", "Private browser", "Sign in in an isolated browser. No session export needed."]].map(([value, label, hint]) => <label key={value} className={`cursor-pointer rounded-lg border p-4 focus-within:ring-2 focus-within:ring-brand-500 ${signInMethod === value ? "border-brand-500" : "border-border"}`}><span className="flex items-center gap-2"><input type="radio" name="chatgpt-web-sign-in" value={value} checked={signInMethod === value} onChange={() => setSignInMethod(value)} />{label}</span><p className="mt-2 text-xs text-text-muted">{hint}</p></label>)}</div></fieldset>
        </> : isOpen && <ChatGPTWebRuntimePanel key={savedConnection.providerSpecificData.profileId} connectionName={savedConnection.name} profileId={savedConnection.providerSpecificData.profileId} selectedProfileId={profileId} connectionDirty={hasChanges} initialSignInMethod={signInMethod} onProfileSelected={setProfileId} onViewerOpenChange={setViewerOpen} onChanged={onSaved} onStateChange={setRuntimeState} connectionDetails={<div className="space-y-3"><Input label="Connection name" aria-label="Connection name" value={name} onChange={event => setName(event.target.value)} disabled={saving || runtimeState.busy} /><Input label="Profile ID" aria-label="Profile ID" value={profileId} onChange={event => setProfileId(event.target.value)} disabled={saving || runtimeState.busy} /><Button variant="secondary" onClick={save} loading={saving} disabled={!hasChanges || runtimeState.busy || runtimeState.dirty || !name.trim() || !PROFILE_ID.test(profileId.trim())}>Save connection</Button><p className="text-xs text-text-muted">Connection details and runtime preferences are saved separately. Save or discard preferences before switching profiles.</p></div>} />}
      </div>
    </Modal>
  );
}
AddChatGPTWebRuntimeModal.propTypes = { isOpen: PropTypes.bool.isRequired, connection: PropTypes.object, onClose: PropTypes.func.isRequired, onSaved: PropTypes.func.isRequired };
