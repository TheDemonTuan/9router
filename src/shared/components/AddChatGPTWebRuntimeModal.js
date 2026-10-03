"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ChatGPTWebRuntimePanel from "./ChatGPTWebRuntimePanel";

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export default function AddChatGPTWebRuntimeModal({ isOpen, connection, onClose, onSaved }) {
  const [name, setName] = useState(connection?.name || "ChatGPT Web VPS");
  const [profileId, setProfileId] = useState(connection?.providerSpecificData?.profileId || "personal");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const controller = useRef(null);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    return () => current.abort();
  }, [isOpen, profileId]);
  const payload = () => ({ provider: "chatgpt-web", name: name.trim(), providerSpecificData: { profileId: profileId.trim() } });
  const testConnection = async () => {
    const current = controller.current;
    setChecking(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/providers/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()), signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok || !data.valid) throw new Error("Profile is not ready. Check the runtime profile diagnostics below.");
      setResult({ modelCount: Array.isArray(data.models) ? data.models.length : 0 });
    } catch {
      if (!current.signal.aborted) setError("Profile is not ready or validation is unavailable. Check the runtime diagnostics below.");
    } finally {
      if (!current.signal.aborted) setChecking(false);
    }
  };
  const save = async () => {
    const current = controller.current;
    setSaving(true); setError("");
    try {
      const response = await fetch(connection ? `/api/providers/${connection.id}` : "/api/providers", { method: connection ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connection ? { name: name.trim(), providerSpecificData: { profileId: profileId.trim() } } : payload()), signal: current.signal });
      if (!response.ok) throw new Error("Failed to save connection.");
      if (current.signal.aborted) return;
      onSaved(); onClose();
    } catch {
      if (!current.signal.aborted) setError("Failed to save connection. The request was not retried; refresh connections before trying again.");
    } finally {
      if (!current.signal.aborted) setSaving(false);
    }
  };
  const selectProfile = value => { setProfileId(value); setResult(null); setError(""); setChecking(false); setSaving(false); };
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" title={connection ? "Edit ChatGPT Web Runtime" : "Add ChatGPT Web Runtime"}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-text-muted">Unofficial browser runtime. 9router stores only the Profile ID; runtime URL, tokens, ChatGPT cookies, and browser credentials are operator-managed and never entered here.</div>
        <Input label="Connection name" value={name} onChange={event => setName(event.target.value)} autoFocus disabled={checking || saving} />
        <Input label="Profile ID" value={profileId} onChange={event => selectProfile(event.target.value)} placeholder="personal" disabled={checking || saving} />
        <p className="text-xs text-text-muted">A canonical account slot: 1–64 lowercase letters, digits, or hyphens, beginning and ending with a letter or digit. Multiple connections with the same Profile ID share the same browser and five-turn limit.</p>
        {result && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">Profile validation passed. Verified models: {result.modelCount}.</div>}
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="secondary" onClick={testConnection} loading={checking} disabled={saving || !PROFILE_ID.test(profileId.trim())}>Test connection</Button>
          <Button onClick={save} loading={saving} disabled={checking || !name.trim() || !PROFILE_ID.test(profileId.trim())}>Save connection</Button>
        </div>
        {isOpen && <ChatGPTWebRuntimePanel key={profileId.trim()} profileId={profileId.trim()} onProfileSelected={selectProfile} onChanged={() => { setResult(null); onSaved(); }} />}
      </div>
    </Modal>
  );
}
AddChatGPTWebRuntimeModal.propTypes = { isOpen: PropTypes.bool.isRequired, connection: PropTypes.object, onClose: PropTypes.func.isRequired, onSaved: PropTypes.func.isRequired };
