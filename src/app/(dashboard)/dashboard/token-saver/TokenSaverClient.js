"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Card, Button, Modal, Toggle } from "@/shared/components";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { isValidSessionDedupMode } from "open-sse/config/tokenSaverConfig.js";
import { RTK_CONFIG } from "open-sse/config/rtkConfig.js";
import { WENYAN_LOCALES, CAVEMAN_LEVELS, PONYTAIL_LEVELS } from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [configure, setConfigure] = useState(null);
  const [draft, setDraft] = useState("");
  const [modalError, setModalError] = useState("");
  const [locale, setLocale] = useState(() => getCurrentLocale());
  const [showWenyan, setShowWenyan] = useState(false);
  const [rtkStatus, setRtkStatus] = useState(null);
  const [rtkChecking, setRtkChecking] = useState(false);
  const dialog = useRef(null);
  const opener = useRef(null);

  useEffect(() => onLocaleChange(() => setLocale(getCurrentLocale())), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal }).then(async res => {
      if (!res.ok) throw Error("Settings unavailable. Reload to retry.");
      const data = await res.json();
      setSettings({ rtkEnabled: data.rtkEnabled !== false, sessionDedupMode: isValidSessionDedupMode(data.sessionDedupMode) ? data.sessionDedupMode : "off", cavemanEnabled: !!data.cavemanEnabled, cavemanLevel: data.cavemanLevel || "full", ponytailEnabled: !!data.ponytailEnabled, ponytailLevel: data.ponytailLevel || "full" });
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!configure) return;
    dialog.current?.querySelector("button:not([disabled]), input:not([disabled])")?.focus();
    return () => opener.current?.focus();
  }, [configure]);
  useEffect(() => {
    if (configure !== "rtk") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RTK_CONFIG.statusRequestMs);
    fetch("/api/rtk/status", { cache: "no-store", signal: controller.signal }).then(async res => {
      if (!res.ok) throw Error("RTK status unavailable.");
      setRtkStatus(await res.json());
    }).catch(() => setModalError("RTK status unavailable. Check to retry.")).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [configure]);

  async function patch(patch, inModal = false) {
    if (saving || !settings) return;
    setSaving(true);
    (inModal ? setModalError : setError)("");
    try {
      const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (!res.ok) throw Error("Setting could not be saved. Please retry.");
      setSettings(previous => ({ ...previous, ...patch }));
      if (inModal) setConfigure(null);
    } catch { (inModal ? setModalError : setError)("Setting could not be saved. Please retry."); }
    finally { setSaving(false); }
  }
  function open(kind, event) {
    opener.current = event.currentTarget;
    setDraft(settings?.[`${kind}Level`] || "full");
    setShowWenyan(false); setModalError(""); setRtkStatus(null); setConfigure(kind);
  }
  function close() { if (!saving && !rtkChecking) setConfigure(null); }
  function trap(event) {
    if (event.key !== "Tab") return;
    const controls = [...dialog.current.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]')];
    if (!controls.length) { event.preventDefault(); dialog.current.focus(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  async function checkRtk() {
    if (rtkChecking) return;
    setRtkChecking(true); setModalError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RTK_CONFIG.statusRequestMs);
    try {
      const res = await fetch("/api/rtk/check", { method: "POST", signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || "Sidecar check failed.");
      setRtkStatus(previous => ({ ...previous, client: { ...previous?.client, check: data.check } }));
    } catch (e) { setModalError(e.name === "AbortError" ? "Sidecar check timed out." : e.message); }
    finally { clearTimeout(timer); setRtkChecking(false); }
  }
  const levels = configure === "ponytail" ? PONYTAIL_LEVELS : CAVEMAN_LEVELS;
  const wenyan = WENYAN_LOCALES.includes(locale) || CAVEMAN_LEVELS.some(l => l.id === draft && l.wenyan) || showWenyan;
  const visibleLevels = configure === "caveman" && !wenyan ? levels.filter(l => !l.wenyan) : levels;
  const rows = [
    { key: "rtk", title: "Compress tool output (RTK)", description: "Local filters and the optional Rust sidecar compress recognized outputs. Unsupported formats stay raw.", checked: settings?.rtkEnabled, field: "rtkEnabled" },
    { key: "dedup", title: "Session Dedup", description: "Exact repeated results in this request only. Recent turns, pending batches and cache/opaque states are protected.", checked: settings?.sessionDedupMode === "on", field: "sessionDedupMode" },
    { key: "caveman", title: "Shorter chat responses (Caveman)", description: "Encourages shorter replies; adds prompt overhead. Net savings depend on workload.", checked: settings?.cavemanEnabled, field: "cavemanEnabled" },
    { key: "ponytail", title: "Lazy senior dev (Ponytail)", description: "Understand first, reuse existing code, then make the smallest complete change.", checked: settings?.ponytailEnabled, field: "ponytailEnabled" },
  ];
  return <div className="space-y-6 p-6">
    <Card>
      <div className="flex justify-between items-center gap-3"><h2 className="text-lg font-semibold">Token Saver</h2><Link className="text-primary underline text-sm" href="/dashboard/token-saver/metrics">View metrics</Link></div>
      {rows.map(row => <div key={row.key} className="flex items-center justify-between gap-4 py-4 border-b border-border flex-wrap">
        <div className="min-w-0 flex-1"><p className="font-medium">{row.title}</p><p className="text-sm text-text-muted">{row.description}</p>{row.key === "dedup" && settings?.sessionDedupMode === "shadow" && <p className="text-sm text-text-muted">Shadow — measurement only</p>}</div>
        <div className="flex items-center gap-3">
          {row.key !== "dedup" && <Button variant="ghost" disabled={!settings || saving} onClick={event => open(row.key, event)}>Configure{row.key === "rtk" ? " RTK" : ""}</Button>}
          <Toggle label={`${row.key === "dedup" ? "Session Dedup" : row.key} enabled`} checked={!!row.checked} disabled={!settings || saving} onChange={checked => patch({ [row.field]: row.key === "dedup" ? checked ? "on" : "off" : checked })} />
        </div>
      </div>)}
      {error && <p role="alert" className="text-sm text-warning mt-3">{error}</p>}
      {settings?.sessionDedupMode === "on" && <p className="text-sm text-text-muted mt-3">Historical rewrites can reduce prompt-cache reuse. Saved source bytes are not billed-token or cost savings.</p>}
      <p className="text-xs text-text-muted mt-3">Style instructions skip native passthrough, structured output and token-saver opt-out.</p>
    </Card>
    <Modal isOpen={!!configure} onClose={close} showTrafficLights={false} closeOnOverlay={!saving && !rtkChecking}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="token-saver-configure-title" tabIndex={-1} onKeyDown={trap} className="space-y-4">
        <h2 id="token-saver-configure-title" className="text-lg font-semibold">Configure {configure === "rtk" ? "RTK" : configure === "caveman" ? "Caveman" : "Ponytail"}</h2>
        {configure === "rtk" ? <>
          <p className="text-sm text-text-muted">Local filters work without a sidecar. Configure RTK_URL in the server environment to enable the pinned Rust sidecar, then restart the server. The URL cannot be edited here.</p>
          <p className="text-sm">Sidecar: {rtkStatus?.config?.endpointState || "Loading…"} · Version: {rtkStatus?.client?.check?.rtkVersion || "—"}</p>
          <p className="text-sm">{rtkStatus?.client?.check ? `Check ${rtkStatus.client.check.status}: ${rtkStatus.client.check.reason || "healthy"}` : "No synthetic check yet"}</p>
          <Button onClick={checkRtk} disabled={rtkChecking}>{rtkChecking ? "Checking…" : "Check sidecar"}</Button>
          <p className="text-xs text-text-muted">Synthetic check — does not count as real usage.</p>
        </> : <>
          <div className="flex flex-wrap gap-2">{visibleLevels.map(level => <button type="button" key={level.id} disabled={saving} aria-pressed={draft === level.id} title={level.desc} onClick={() => setDraft(level.id)} className={`px-3 py-2 rounded border text-sm ${draft === level.id ? "bg-primary text-white border-primary" : "border-border hover:bg-surface-2"}`}>{level.label}</button>)}</div>
          {configure === "caveman" && !wenyan && <Button variant="ghost" onClick={() => setShowWenyan(true)}>+ 文言</Button>}
          <p className="text-sm text-text-muted">{levels.find(l => l.id === draft)?.desc}</p>
        </>}
        {modalError && <p role="alert" className="text-sm text-warning">{modalError}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={saving || rtkChecking} onClick={close}>{configure === "rtk" ? "Close" : "Cancel"}</Button>{configure !== "rtk" && <Button disabled={saving} onClick={() => patch({ [`${configure}Level`]: draft }, true)}>{saving ? "Saving…" : "Save"}</Button>}</div>
      </div>
    </Modal>
  </div>;
}
