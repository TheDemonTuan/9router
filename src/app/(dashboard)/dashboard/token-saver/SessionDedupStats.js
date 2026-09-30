"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Button } from "@/shared/components";
import { RTK_CONFIG } from "open-sse/config/rtkConfig.js";

const num = value => value == null ? "—" : value.toLocaleString();
const ms = value => value == null ? "—" : `${value.toFixed(2)} ms`;
function Metric({ label, value, sub }) {
  return <Card className="p-4"><p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
    <p className="text-xl font-semibold mt-1">{value}</p><p className="text-xs text-text-muted mt-0.5">{sub || "\u00a0"}</p></Card>;
}
function Rows({ title, values }) {
  return <div><h4 className="font-medium mb-2">{title}</h4>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">{Object.entries(values ?? {}).map(([label, count]) =>
      <div className="flex justify-between gap-3" key={label}><dt>{label.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}</dt><dd>{num(count)}</dd></div>)}</dl></div>;
}
export default function SessionDedupStats({ mode }) {
  const [snapshot, setSnapshot] = useState(null);
  const [receivedAt, setReceivedAt] = useState(null);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [newSession, setNewSession] = useState(false);
  const sessionId = useRef(null);
  useEffect(() => {
    if (authRequired) return;
    let timer;
    let controller;
    let alive = true;
    let running = false;
    let queued = false;
    async function refresh() {
      if (!alive || document.hidden) return;
      if (running) { queued = true; return; }
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/token-saver/status", { signal: controller.signal, cache: "no-store" });
        if (response.status === 401 || response.status === 403) {
          setAuthRequired(true); setError("Sign in to view Session Dedup status. Reload after signing in."); return;
        }
        if (!response.ok) throw Error("Status unavailable");
        const data = await response.json();
        if (!alive) return;
        if (sessionId.current && sessionId.current !== data.session.id) setNewSession(true);
        sessionId.current = data.session.id;
        setSnapshot(data);
        setReceivedAt(new Date().toISOString());
        setError("");
      } catch {
        if (alive && !controller.signal.aborted) setError("Status unavailable; showing last received values.");
      } finally {
        running = false;
        if (alive && !authRequired && !document.hidden) {
          timer = setTimeout(refresh, queued ? 0 : RTK_CONFIG.statusPollMs);
          queued = false;
        }
      }
    }
    function visibility() { clearTimeout(timer); if (document.hidden) controller?.abort(); else refresh(); }
    document.addEventListener("visibilitychange", visibility);
    refresh();
    return () => { alive = false; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [mode, refreshKey, authRequired]);
  const usage = snapshot?.usage;
  const cleanup = usage?.cleanupShadow;
  return <section aria-label="Session Dedup session status" className="py-5 space-y-4 border-b border-border">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">Session Dedup session status</h3>
      <div className="flex items-center gap-2 text-sm" aria-live="polite">
        <span className="rounded bg-surface-2 px-2 py-1">{snapshot?.config?.sessionDedupMode || "—"}</span>
        {error && <span className="text-warning">Stale · {receivedAt ? new Date(receivedAt).toLocaleString() : "—"}</span>}
        <Button size="sm" variant="ghost" onClick={() => setRefreshKey(key => key + 1)} disabled={authRequired}>Refresh</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    {newSession && <p role="status" className="text-sm text-warning">Runtime statistics session changed; counters reset.</p>}
    <p className="text-sm text-text-muted">Counts are request preparations, not logical requests. Shadow only measures; existing enabled savers may still run outside cached prefixes. Bytes saved are source-payload-equivalent estimates, not billed-token, provider-cache or cost savings.</p>
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Metric label="Applied results" value={num(usage?.appliedResults)} sub="Final correspondence verified · On" />
      <Metric label="Bytes saved" value={num(usage?.bytesSaved)} sub="Source-payload-equivalent · On" />
      <Metric label="Source opportunities" value={num(usage?.wouldDedupResults)} sub="Source-stage only · Shadow" />
      <Metric label="Would save bytes" value={num(usage?.wouldSaveBytes)} sub="Not guaranteed at dispatch · Shadow" />
      <Metric label="Estimated tokens saved" value={num(usage?.estimatedTokensSaved)} sub="Active estimate only" />
      <Metric label="Cross-family duplicates" value={num(usage?.crossFamilyDuplicates)} sub="Observed only · never deduplicated" />
    </div>
    <p className="text-sm text-text-muted">Preparations: {num(usage?.preparations)} · Indexed tool-result containers: {num(usage?.scannedResults)} · Hashed results: {num(usage?.hashedResults)} · Intra-turn eligible results: {num(usage?.intraTurnEligibleResults)} · Intra-turn exact duplicates: {num(usage?.intraTurnDuplicatesFound)} · Scanned bytes: {num(usage?.scannedBytes)} · Exact duplicates: {num(usage?.exactDuplicatesFound)}.</p>
    <p className="text-sm text-text-muted">Current recent batches: {num(usage?.protected?.current)} · Incomplete batches: {num(usage?.protected?.incompleteBatch)} · Previous two user turns: {num(usage?.protected?.recent)} · Cache fence: {num(usage?.protected?.cacheFence)} · Errors: {num(usage?.protected?.error)} · Budget-stopped preparations: {num(usage?.budgetStoppedPreparations)} · Final guard skipped preparations: {num(usage?.finalGuardSkippedPreparations)}.</p>
    {usage?.scannedResults > 0 && (usage?.hashedResults ?? 0) === 0 && (
      <p className="text-xs text-text-muted bg-surface-2 p-2 rounded">
        Indexed tool-result containers were detected, but no candidate results were hashed due to guard policies (unreliable turn boundaries, active working-set batch protection, or cache/opaque states). Zero hashed bytes does not imply absence of duplicates in the underlying workload.
      </p>
    )}
    <div className="grid gap-3 md:grid-cols-2">
      {(["shadow", "on"]).map(key => <div className="text-sm" key={key}><h4 className="font-medium capitalize">{key} preparation latency</h4>
        <p>p50: {ms(usage?.latency?.[key]?.p50Ms)} · p95: {ms(usage?.latency?.[key]?.p95Ms)} · Samples: {num(usage?.latency?.[key]?.sampleCount)} / {num(usage?.latency?.[key]?.capacity)} · Soft target exceeded: {num(usage?.latency?.[key]?.softTargetExceeded)}</p></div>)}
    </div>
    <details><summary className="cursor-pointer font-medium">Measurement details</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-text-muted">Generic cleanup is measurement-only. Categories overlap; do not sum as total savings. Protected or unscanned text is excluded.</p>
        <p className="text-sm">Complete: {num(cleanup?.completePreparations)} · Partial: {num(cleanup?.partialPreparations)} · Budget stopped: {num(cleanup?.budgetStoppedPreparations)} · Visited segments: {num(cleanup?.visitedSegments)} · Measured segments: {num(cleanup?.measuredSegments)} · Protected segments: {num(cleanup?.protectedSegments)}.</p>
        <Rows title="Generic cleanup opportunity bytes" values={cleanup && Object.fromEntries(["trailingWhitespaceBytes", "blankLineBytes", "ansiBytes", "adjacentDuplicateBytes", "duplicateSystemBytes", "oldToolTruncationBytes"].map(key => [key, cleanup[key]]))} />
        <Rows title="Preparation modes" values={usage?.byMode} />
        <Rows title="Preparations by genuine user turns (unknown = missing user turn or ambiguous wrapper)" values={usage?.preparationsByUserTurns} />
        <div className="text-sm">
          <h4 className="font-medium mb-1">Implicit Responses user messages</h4>
          <p className="text-text-muted">{num(usage?.responsesImplicitUserMessages)} user message(s) identified via role-based fallback.</p>
        </div>
        <Rows title="Current-turn tool batches" values={usage?.toolBatches} />
        <Rows title="Source opaque-state reasons (unique per preparation; categories may overlap)" values={usage?.opaqueReasons} />
        <Rows title="Skipped by reason (result and preparation counts have different units)" values={usage?.skipped} />
      </div>
    </details>
  </section>;
}
