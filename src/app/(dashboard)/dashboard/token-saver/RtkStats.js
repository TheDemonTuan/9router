"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/shared/components";
import { RTK_CONFIG } from "open-sse/config/rtkConfig.js";

const labels = {
  disabled: "Disabled", opted_out: "Client opted out", structured_output: "Structured output", native_passthrough: "Native passthrough",
  unsupported_shape: "Unsupported request shape", no_eligible_output: "No eligible tool output", no_change: "No compression applied",
  compressed: "Compressed", timeout: "Timed out", cancelled: "Preparation cancelled", failed: "Preparation failed",
  unconfigured: "RTK_URL not configured", invalid_url: "Invalid RTK_URL", invalid_text: "Invalid text", size_limit: "Text outside size limits",
  circuit_open: "Circuit cooldown", probe_in_flight: "Recovery probe in flight", saturated: "Request concurrency full", payload_limit: "HTTP payload too large",
  unreachable: "Sidecar unreachable", transport_error: "Transport error", bad_response: "Invalid sidecar response", busy: "Sidecar busy",
};
const eligibilityLabels = {
  toolResults: "Tool result containers", textLeaves: "Supported text leaves", resultsWithoutText: "Results without supported text",
  noToolResultsPreparations: "Preparations without tool results",
  error_result: "Error result", cache_marker: "Prompt-cache breakpoint", below_min_bytes: "Below minimum bytes", above_max_bytes: "Above maximum bytes",
  selection_budget: "Selection byte budget", unlinked_call: "Missing or ambiguous call metadata",
  invalid_command_metadata: "Invalid command metadata", metadata_limit: "Command metadata too large",
  missing_command: "Missing command", unsupported_shell_syntax: "Unsupported shell syntax", already_rtk: "Already RTK",
  unsupported_command: "Unsupported command", unsupported_mode: "Unsupported command mode", unsupported_output_format: "Unsupported output format",
};
const detailLabels = {
  none: "None",
  no_command: "No command provided",
  native_metadata_missing: "Missing native tool parameters",
  native_output_mismatch: "Native output shape mismatch",
  serialized_metadata_limit: "Serialized input exceeds 8 KB limit",
  command_length_limit: "Command exceeds 8 KB limit",
};
const familyLabels = {
  shell: "Shell",
  grep: "Grep",
  glob: "Glob",
  read: "Read",
  edit: "Edit",
  write: "Write",
  other: "Other",
  unlinked: "Unlinked",
};
const outcomeLabels = {
  applied: "Applied",
  discarded_deadline: "Discarded (preparation deadline reached)",
  discarded_cancelled: "Discarded (client cancelled request)",
  not_smaller: "Not smaller than input",
  empty_output: "Empty output",
  invalid_text: "Invalid text (NUL or ill-formed Unicode)",
  format_not_accepted: "Format not accepted (output protected or unrecognized)",
  busy: "Sidecar busy (503)",
  rejected: "Sidecar rejected (400/413)",
  timeout: "Timed out",
  cancelled: "Cancelled",
  failed: "Failed",
  skip_unconfigured: "Skipped (RTK_URL unconfigured)",
  skip_invalid_url: "Skipped (invalid RTK_URL)",
  skip_invalid_text: "Skipped (invalid text)",
  skip_size_limit: "Skipped (outside size limits)",
  skip_circuit_open: "Skipped (circuit open)",
  skip_probe_in_flight: "Skipped (recovery probe in flight)",
  skip_saturated: "Skipped (concurrency saturated)",
  skip_payload_limit: "Skipped (payload limit exceeded)",
  unknown: "Unknown",
};
const num = value => value == null ? "—" : value.toLocaleString();
const date = value => value ? new Date(value).toLocaleString() : "—";
function Metric({ label, value, sub }) {
  return <Card className="p-4"><p className="text-xs text-text-muted uppercase tracking-wide">{label}</p><p className="text-xl font-semibold mt-1">{value}</p><p className="text-xs text-text-muted mt-0.5">{sub || "\u00a0"}</p></Card>;
}
function Breakdown({ title, values, names = labels, showZeros = false }) {
  const entries = Object.entries(values).filter(([, count]) => showZeros || count > 0);
  return <div><h4 className="font-medium mb-2">{title}</h4>{entries.length ? <dl className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">{entries.map(([key, count]) => <div className="flex justify-between gap-3" key={key}><dt>{names[key] || key}</dt><dd>{num(count)}</dd></div>)}</dl> : <p className="text-sm text-text-muted">None in this process yet</p>}</div>;
}

export default function RtkStats({ enabled }) {
  const [snapshot, setSnapshot] = useState(null);
  const [receivedAt, setReceivedAt] = useState(null);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [checking, setChecking] = useState(false);
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
        const response = await fetch("/api/rtk/status", { signal: controller.signal, cache: "no-store" });
        if (response.status === 401 || response.status === 403) { setAuthRequired(true); setError("Sign in to view RTK status. Reload after signing in."); return; }
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
  }, [enabled, refreshKey, authRequired]);

  async function check() {
    setChecking(true);
    try {
      const response = await fetch("/api/rtk/check", { method: "POST", cache: "no-store" });
      if (!response.ok) throw Error("Check unavailable");
      setError("");
    } catch { setError("Sidecar check unavailable; previous metrics remain visible."); }
    finally { setChecking(false); setRefreshKey(key => key + 1); }
  }

  const usage = snapshot?.usage;
  const http = usage?.http;
  const client = snapshot?.client;
  const config = snapshot?.config;
  const saved = usage ? usage.bytesBefore - usage.bytesAfter : null;
  const percentage = usage?.bytesBefore ? `${(saved / usage.bytesBefore * 100).toFixed(1)}%` : "—";
  const average = http && http.attempts > client.active ? `${(http.totalDurationMs / (http.attempts - client.active)).toFixed(0)} ms` : "—";
  const endpoint = config?.endpointState;
  const checkResult = client?.check;

  return <section aria-label="RTK session status" className="py-5 space-y-4 border-b border-border">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">RTK session status</h3>
      <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <span className="rounded bg-surface-2 px-2 py-1">{config ? config.enabled ? "Enabled" : "Disabled" : "—"}</span>
        <span className="rounded bg-surface-2 px-2 py-1">{endpoint === "configured" ? "Configured" : endpoint === "invalid" ? "Invalid configuration" : endpoint === "unconfigured" ? "Not configured" : "—"}</span>
        {error && <span className="text-warning">Stale · {date(receivedAt)}</span>}
        <Button size="sm" variant="ghost" onClick={() => setRefreshKey(key => key + 1)} disabled={authRequired}>Refresh</Button>
        <Button size="sm" onClick={check} disabled={checking || authRequired || endpoint !== "configured"}>{checking ? "Checking…" : "Check sidecar"}</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-warning">{error}</p>}
    {newSession && <p className="text-sm text-warning" role="status">Gateway process restarted; session counters reset.</p>}
    {endpoint !== "configured" && <p className="text-sm text-text-muted">The local filters remain available. For Rust pipe filters set RTK_URL on the server, then restart. Docker: <code>http://rtk:8080</code>; Bun local: <code>http://127.0.0.1:8080</code> (only with a running sidecar).</p>}
    <p className="text-sm text-text-muted" aria-live="polite">{checkResult ? <>{checkResult.status === "passed" ? "Check passed" : `Check failed: ${labels[checkResult.reason] || "Sidecar unavailable"}`} · {date(checkResult.checkedAt)}{checkResult.status === "passed" && ` · RTK ${checkResult.rtkVersion}, wrapper ${checkResult.wrapperRevision}`}</> : "No manual synthetic check yet"}. Check uses synthetic text; usage below counts real request preparation only.</p>
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Metric label="Sidecar calls" value={num(http?.attempts)} sub={`Active: ${num(client?.active)} · average completed: ${average}`} />
      <Metric label="Processed successfully" value={num(http?.succeeded)} sub={`Unchanged: ${num(http?.unchanged)}`} />
      <Metric label="Outputs compressed" value={num(usage?.appliedOutputs)} sub={`${num(usage?.compressedPreparations)} / ${num(usage?.preparations)} preparations`} />
      <Metric label="Bytes saved" value={num(saved)} sub={`${num(usage?.bytesBefore)} before · ${num(usage?.bytesAfter)} after · ${percentage}`} />
      <Metric label="Estimated tokens saved" value={num(usage?.estimatedTokensSaved)} />
      <Metric label="Failed calls" value={num(http?.failed)} sub={`Timed out: ${num(http?.timedOut)}`} />
    </div>
    <p className="text-sm text-text-muted">Busy: {num(http?.busy)} · Rejected: {num(http?.rejected)} · Cancelled: {num(http?.cancelled)}. These are not successful or failed calls.</p>
    <p className="text-sm text-text-muted">Local filter attempts: {num(usage?.local?.attempts)} · Applied: {num(usage?.local?.applied)} · Sidecar fallbacks applied: {num(usage?.local?.fallbacks)}. Sidecar calls and local attempts are different units.</p>
    {Boolean(config?.routableFilters?.length) && <p className="text-xs text-text-muted">Available from upstream Rust pipe: {num(config?.pipeFilters?.length || config?.sidecarFilters?.length)} · Routed by 9router: {num(config?.routableFilters?.length)} · Local guarded filters: {num(config?.localFilters?.length)}.</p>}
    <div className="grid gap-4 md:grid-cols-2"><Breakdown title="Preparation outcomes" values={usage?.preparationReasons || {}} /><Breakdown title="Skipped before HTTP" values={usage?.skipped || {}} /></div>
    <div aria-label="Tool output eligibility" className="space-y-2">
      <h4 className="font-medium">Tool output eligibility</h4>
      <p className="text-sm text-text-muted">Session counts: containers, text leaves, and preparations have different units. One result may contain multiple leaves. Each rejected leaf has at most one reason; deadlines or cancellation can leave counts incomplete. No historical requests are reconstructed.</p>
      <div className="grid gap-4 md:grid-cols-2"><Breakdown title="Observed results and preparations" values={usage?.eligibility ? { toolResults: usage.eligibility.toolResults, textLeaves: usage.eligibility.textLeaves, resultsWithoutText: usage.eligibility.resultsWithoutText, noToolResultsPreparations: usage.eligibility.noToolResultsPreparations } : {}} names={eligibilityLabels} showZeros /><Breakdown title="Rejected text leaves" values={usage?.eligibility?.rejected || {}} names={eligibilityLabels} /></div>
    </div>
    <div aria-label="RTK diagnostics" className="space-y-4">
      <h4 className="font-medium">RTK diagnostics</h4>
      <p className="text-sm text-text-muted">
        Diagnostic counters are privacy-safe and bounded: only RTK-relevant tool families (Shell, Grep, Glob) are tracked in rejections to focus on command syntax, format, and size limits rather than routine file operations (Read, Edit, Write). Filter attempts represent individual evaluation steps, not unique outputs. Applied outputs represent preparation mutations before translation, not provider delivery.
      </p>
      {!(snapshot?.diagnostics ?? usage?.diagnostics) ? (
        <p className="text-sm text-text-muted">Diagnostics unavailable in this process</p>
      ) : (
        <>
          <div className="overflow-x-auto space-y-2">
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-medium">Rejected tool output</h5>
              {(snapshot?.diagnostics?.overflow?.rejections ?? usage?.diagnostics?.overflow?.rejections ?? 0) > 0 && (
                <span className="text-xs text-warning">
                  Overflow: {num(snapshot?.diagnostics?.overflow?.rejections ?? usage?.diagnostics?.overflow?.rejections)} observations not tracked (max 128 keys)
                </span>
              )}
            </div>
            {(snapshot?.diagnostics?.rejections ?? usage?.diagnostics?.rejections)?.length ? (
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-3">Tool family</th>
                    <th scope="col" className="py-2 pr-3">Reason</th>
                    <th scope="col" className="py-2 pr-3">Detail</th>
                    <th scope="col" className="py-2 pr-3">Observations</th>
                    <th scope="col" className="py-2">Input bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.diagnostics?.rejections ?? usage?.diagnostics?.rejections).map((row, idx) => (
                    <tr key={`${row.toolFamily}:${row.reason}:${row.detail}:${idx}`} className="border-t border-border">
                      <td className="py-2 pr-3">{familyLabels[row.toolFamily] || row.toolFamily}</td>
                      <td className="py-2 pr-3">{eligibilityLabels[row.reason] || row.reason}</td>
                      <td className="py-2 pr-3">{detailLabels[row.detail] || row.detail}</td>
                      <td className="py-2 pr-3">{num(row.count)}</td>
                      <td className="py-2">{num(row.inputBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-text-muted">No observations yet</p>
            )}
          </div>

          <div className="overflow-x-auto space-y-2">
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-medium">Filter attempts</h5>
              {(snapshot?.diagnostics?.overflow?.filters ?? usage?.diagnostics?.overflow?.filters ?? 0) > 0 && (
                <span className="text-xs text-warning">
                  Overflow: {num(snapshot?.diagnostics?.overflow?.filters ?? usage?.diagnostics?.overflow?.filters)} attempts not tracked (max 128 keys)
                </span>
              )}
            </div>
            {(snapshot?.diagnostics?.filters ?? usage?.diagnostics?.filters)?.length ? (
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 pr-3">Tool family</th>
                    <th scope="col" className="py-2 pr-3">Filter</th>
                    <th scope="col" className="py-2 pr-3">Engine</th>
                    <th scope="col" className="py-2 pr-3">Direct or fallback</th>
                    <th scope="col" className="py-2 pr-3">Outcome</th>
                    <th scope="col" className="py-2 pr-3">Attempts</th>
                    <th scope="col" className="py-2 pr-3">Input bytes</th>
                    <th scope="col" className="py-2">Candidate output bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.diagnostics?.filters ?? usage?.diagnostics?.filters).map((row, idx) => (
                    <tr key={`${row.toolFamily}:${row.filter}:${row.engine}:${row.fallback}:${row.outcome}:${idx}`} className="border-t border-border">
                      <td className="py-2 pr-3">{familyLabels[row.toolFamily] || row.toolFamily}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{row.filter}</td>
                      <td className="py-2 pr-3">{row.engine === "sidecar" ? "Rust sidecar" : "Local"}</td>
                      <td className="py-2 pr-3">{row.fallback ? "Fallback" : "Direct"}</td>
                      <td className="py-2 pr-3">{outcomeLabels[row.outcome] || row.outcome}</td>
                      <td className="py-2 pr-3">{num(row.count)}</td>
                      <td className="py-2 pr-3">{num(row.inputBytes)}</td>
                      <td className="py-2">{num(row.outputBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-text-muted">No observations yet</p>
            )}
          </div>
        </>
      )}
    </div>
    <div className="overflow-x-auto"><h4 className="font-medium mb-2">Applied filters</h4>{usage?.filters.length ? <table className="w-full text-sm text-left"><thead><tr><th scope="col">Filter</th><th scope="col">Rust / local</th><th scope="col">Outputs</th><th scope="col">Bytes saved</th><th scope="col">Estimated tokens</th></tr></thead><tbody>{usage.filters.map(row => <tr key={row.filter} className="border-t border-border"><th scope="row">{row.filter}</th><td>{num(row.engines?.sidecar)} / {num(row.engines?.local)}</td><td>{num(row.appliedOutputs)}</td><td>{num(row.bytesBefore - row.bytesAfter)}</td><td>{num(row.estimatedTokensSaved)}</td></tr>)}</tbody></table> : <p className="text-sm text-text-muted">No tool output compressed in this process yet. Requires linked tool metadata and text ≥{num(config?.minTextBytes)} UTF-8 bytes.</p>}</div>
    <p className="text-sm text-text-muted">Last compression: {date(usage?.lastAppliedAt)} · Last successful RTK call: {date(client?.lastSuccessAt)} · Circuit: {client?.circuit || "—"}{client?.circuit === "open" && ` until ${date(client.openUntil)}`} · Active: {num(client?.active)} · Last failure: {client?.lastFailure ? `${labels[client.lastFailure.reason] || client.lastFailure.reason} at ${date(client.lastFailure.at)}` : "—"}</p>
    <p className="text-xs text-text-muted">Current gateway process only. Session started {date(snapshot?.session.startedAt)}{snapshot?.session.slot ? ` · ${snapshot.session.slot} slot` : ""}. Resets on restart/deploy; fallback preparations may be counted again. Applied during request preparation; not proof of provider receipt, completion or billing. Estimate from text length (~4 characters/token), not provider token usage or billed savings.</p>
  </section>;
}
