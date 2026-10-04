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
  const [autoStartLogin, setAutoStartLogin] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef(null);
  const savingRef = useRef(false);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    return () => current.abort();
  }, [isOpen]);
  const close = () => { if (!savingRef.current) onClose(); };
  const save = async () => {
    const current = controller.current;
    if (!current || current.signal.aborted || savingRef.current || uncertain) return;
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
      setSavedConnection(data.connection);
      setProfileId(data.connection.providerSpecificData.profileId);
      setAutoStartLogin(!editing);
      onSaved();
    } catch (cause) {
      if (!current.signal.aborted) {
        if (!editing && !rejected) setUncertain(true);
        setError(cause.message || "Failed to save connection. The request was not retried; refresh connections before trying again.");
      }
    } finally {
      savingRef.current = false;
      if (!current.signal.aborted) setSaving(false);
    }
  };
  const hasChanges = !!savedConnection && (name.trim() !== savedConnection.name || profileId.trim() !== savedConnection.providerSpecificData?.profileId);
  return (
    <Modal isOpen={isOpen} onClose={close} suspended={viewerOpen} size="xl" title={savedConnection ? "ChatGPT Web Connection" : "Add ChatGPT Web Connection"}>
      <div className="space-y-4">
        {!savedConnection && <p className="text-sm text-text-muted">Create a connection, then sign in in its private browser. 9Router never asks for your password or cookies.</p>}
        <Input label="Connection name" id="chatgpt-web-connection-name" aria-label="Connection name" value={name} onChange={event => setName(event.target.value)} autoFocus disabled={saving || uncertain} />
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        {uncertain && <p role="status" className="text-sm text-amber-500">The save was not retried. Close this dialog and refresh the connection list before adding again to avoid duplicate profiles.</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close} disabled={saving}>Close</Button>
          {(!savedConnection || hasChanges) && <Button aria-label={savedConnection ? "Save connection" : "Add Connection and Sign In"} onClick={save} loading={saving} disabled={uncertain || !name.trim() || (!!savedConnection && !PROFILE_ID.test(profileId.trim()))}>{savedConnection ? "Save connection" : "Add Connection & Sign In"}</Button>}
        </div>
        {isOpen && savedConnection && <ChatGPTWebRuntimePanel key={savedConnection.providerSpecificData.profileId} connectionName={name.trim() || savedConnection.name} profileId={savedConnection.providerSpecificData.profileId} selectedProfileId={profileId} autoStartLogin={autoStartLogin} onProfileSelected={setProfileId} onViewerOpenChange={setViewerOpen} onChanged={onSaved} />}
      </div>
    </Modal>
  );
}
AddChatGPTWebRuntimeModal.propTypes = { isOpen: PropTypes.bool.isRequired, connection: PropTypes.object, onClose: PropTypes.func.isRequired, onSaved: PropTypes.func.isRequired };
