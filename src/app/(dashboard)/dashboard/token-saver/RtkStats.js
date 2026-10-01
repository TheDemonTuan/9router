"use client";
import useStatusSnapshot from "./useStatusSnapshot";
import { Metric, StatusHeader, InitialState, CounterRows, BoundedTable, num } from "./MetricsView";
import { RTK_NATIVE_GREP_SHAPES } from "open-sse/config/rtkConfig.js";
const labels = { not_applicable_tool: "Not applicable — file/source tool", native_metadata_missing: "Missing native metadata", missing_command: "Shell command missing", unsupported_output_format: "Unsupported output format" };
export default function RtkStats() {
  const state = useStatusSnapshot("/api/rtk/status");
  const s = state.snapshot, u = s?.usage, http = u?.http, client = s?.client;
  const saved = u ? u.bytesBefore-u.bytesAfter : null;
  const diagnostics = s?.diagnostics ?? u?.diagnostics;
  const filterRows = diagnostics?.filters;
  const filterDetailsAvailable = Array.isArray(filterRows) && (filterRows.length ? filterRows.every(row => Object.hasOwn(row, "detail")) : u?.nativeGrepShapes != null);
  const nativeShapes = u?.nativeGrepShapes == null ? null : RTK_NATIVE_GREP_SHAPES.map(shape => ({ shape, ...u.nativeGrepShapes[shape] })).filter(row => row.count > 0);
  return <section aria-label="RTK metrics" className="space-y-4 border-b border-border pb-6">
    <StatusHeader title="RTK" state={state} mode={s ? s.config?.enabled ? "Enabled" : "Off" : null} />
    {!s ? <InitialState state={state} /> : <>
      {s.config?.endpointState === "unconfigured" && <p className="text-sm text-text-muted">Local filters available; Rust sidecar not configured</p>}
      {(s.config?.endpointState === "invalid" || client?.circuit === "open") && <p className="text-sm text-warning">{s.config?.endpointState === "invalid" ? "Invalid sidecar configuration" : "Sidecar circuit cooldown"}</p>}
      {s.config?.endpointState === "configured" && http?.attempts === 0 && <p className="text-sm text-text-muted">No eligible output sent to the sidecar in this runtime session.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Outputs compressed" value={num(u?.appliedOutputs)} sub={`${num(u?.compressedPreparations)} compressed preparations`} />
        <Metric label="Bytes saved" value={num(saved)} sub={`${u?.bytesBefore ? (saved/u.bytesBefore*100).toFixed(1)+'%' : '—'} of applied outputs only`} />
        <Metric label="Estimated tokens saved" value={num(u?.estimatedTokensSaved)} sub="~4 characters/token; not billing savings" />
        <Metric label="Sidecar failures" value={num(http?.failed)} sub={`Timed out: ${num(http?.timedOut)}`} />
      </div>
      <p className="text-sm text-text-muted">Local attempts {num(u?.local?.attempts)} / applied {num(u?.local?.applied)} · Sidecar attempts {num(http?.attempts)} / unchanged {num(http?.unchanged)} / busy {num(http?.busy)} / cancelled {num(http?.cancelled)} · Circuit {client?.circuit || "—"}</p>
      {u?.preparations === 0 ? <p className="text-sm text-text-muted">No activity in this runtime session.</p> : u?.appliedOutputs === 0 && <p className="text-sm text-text-muted">Preparations observed; no eligible output compressed. Diagnostics distinguish inapplicable tools from processing failures.</p>}
      {!s.config?.enabled && u?.preparations > 0 && <p className="text-sm text-text-muted">Feature off; historical runtime counters remain visible.</p>}
      <details><summary className="cursor-pointer font-medium">Diagnostics</summary><div className="space-y-4 mt-3">
        <CounterRows title="Preparation outcomes (preparations)" values={u?.preparationReasons} />
        <CounterRows title="Skipped before HTTP (attempts)" values={u?.skipped} />
        <CounterRows title="Rejected text leaves" values={u?.eligibility?.rejected} labels={labels} />
        <p className="text-xs text-text-muted">Observed result containers {num(u?.eligibility?.toolResults)} · text leaves {num(u?.eligibility?.textLeaves)}. Filter attempts are evaluation steps, not unique outputs. No command, path or payload is retained.</p>
        <BoundedTable title="Command families (linked shell text leaves)" rows={u?.commandFamilies} columns={[{key:'commandFamily',label:'Command family'},{key:'count',label:'Count'},{key:'inputBytes',label:'Input bytes'}]} />
        <BoundedTable title="Rejected tool output" rows={diagnostics?.rejections} overflow={diagnostics?.overflow?.rejections} columns={[{key:'toolFamily',label:'Tool family'},{key:'commandFamily',label:'Command family'},{key:'reason',label:'Reason',render:r=>labels[r.reason]||r.reason},{key:'detail',label:'Detail'},{key:'count',label:'Observations'},{key:'inputBytes',label:'Input bytes'}]} />
        {filterDetailsAvailable || filterRows?.length > 0 ? <BoundedTable title="Filter outcomes" rows={filterRows} overflow={diagnostics?.overflow?.filters} columns={[{key:'commandFamily',label:'Command family'},{key:'filter',label:'Filter'},{key:'engine',label:'Engine'},{key:'fallback',label:'Route',render:r=>r.fallback?'Fallback':'Direct'},{key:'outcome',label:'Outcome'},{key:'detail',label:'Detail'},{key:'count',label:'Attempts'},{key:'inputBytes',label:'Input bytes'},{key:'outputBytes',label:'Candidate bytes'}]} /> : <h4 className="text-sm font-medium">Filter outcomes</h4>}
        {!filterDetailsAvailable && <p className="text-sm text-text-muted">Details unavailable from this server version.</p>}
        {nativeShapes ? <BoundedTable title="Native Grep output shapes" rows={nativeShapes} columns={[{key:'shape',label:'Shape'},{key:'count',label:'Observations'},{key:'inputBytes',label:'Input bytes'}]} /> : <div><h4 className="text-sm font-medium mb-2">Native Grep output shapes</h4><p className="text-sm text-text-muted">Details unavailable from this server version.</p></div>}
        <BoundedTable title="Applied filters" rows={u?.filters} countKey="appliedOutputs" columns={[{key:'filter',label:'Filter'},{key:'appliedOutputs',label:'Outputs'},{key:'saved',label:'Bytes saved',render:r=>num(r.bytesBefore-r.bytesAfter)},{key:'estimatedTokensSaved',label:'Estimated tokens'}]} />
      </div></details>
      <p className="text-xs text-text-muted">Current process only; restart/deploy resets counters. Applied during source request preparation, not proof of provider receipt or completion. Estimates are not provider tokens, prompt-cache or billing savings.</p>
    </>}
  </section>;
}
