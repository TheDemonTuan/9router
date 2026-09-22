"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";

export default function AddChatGPTWebBridgeModal({ isOpen, connection, onClose, onSaved }) {
  const [name, setName] = useState(connection?.name || "ChatGPT Web VPS");
  const [bridgeId, setBridgeId] = useState(connection?.providerSpecificData?.bridgeId || "personal");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const payload = () => ({ provider: "chatgpt-web", name: name.trim(), providerSpecificData: { bridgeId: bridgeId.trim() } });

  const testConnection = async () => {
    setChecking(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = await response.json();
      if (!response.ok || !data.valid) throw new Error(data.error || "Bridge is not ready");
      setResult(data);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(connection ? `/api/providers/${connection.id}` : "/api/providers", {
        method: connection ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(connection ? { name: name.trim(), providerSpecificData: { bridgeId: bridgeId.trim() } } : payload()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save bridge");
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={connection ? "Edit ChatGPT Web Bridge" : "Add ChatGPT Web Bridge"}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-text-muted">
          Unofficial local browser bridge. No ChatGPT cookie, token, or socket path is stored in 9router.
        </div>
        <Input label="Connection name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <Input label="Bridge ID" value={bridgeId} onChange={(event) => setBridgeId(event.target.value)} placeholder="personal" />
        <p className="text-xs text-text-muted">Lowercase letters, digits, and hyphens only. The server resolves this ID inside its configured socket directory.</p>
        {result && (
          <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            Daemon online. Browser readiness: {result.health?.readiness?.state || result.health?.readiness || "unknown"}. Models: {result.models?.length || 0}.
          </div>
        )}
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={checking || saving}>Cancel</Button>
          <Button variant="secondary" onClick={testConnection} loading={checking} disabled={saving}>Test connection</Button>
          <Button onClick={save} loading={saving} disabled={checking || !name.trim() || !bridgeId.trim()}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

AddChatGPTWebBridgeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.object,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
