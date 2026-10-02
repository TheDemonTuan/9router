"use client";
import useStatusSnapshot from "./useStatusSnapshot";
import { Metric, StatusHeader, InitialState, CounterRows, num, ms } from "./MetricsView";
function FinalReasons({ title, values }) {
  return values ? <CounterRows title={title} values={values} /> : <div><h4 className="text-sm font-medium mb-2">{title}</h4><p className="text-sm text-text-muted">Details unavailable from this server version.</p></div>;
}
function Latency({ mode, value }) {
  const percent = Number.isFinite(value?.totalSamples) && value.totalSamples > 0 && Number.isFinite(value?.softTargetExceeded) ? ` (${(value.softTargetExceeded/value.totalSamples*100).toFixed(1)}% of ${num(value.totalSamples)} cumulative samples)` : "";
  return <div className="text-sm"><h4 className="font-medium">{mode} preparation latency</h4><p>p50 {ms(value?.p50Ms)} · p95 {ms(value?.p95Ms)} · Window {num(value?.sampleCount)} / {num(value?.capacity)} · 2ms target exceeded {num(value?.softTargetExceeded)}{percent}</p><p className="text-xs text-text-muted">Measurement-only target; not a timeout, alarm or SLA. Percentiles use the recent sample window; exceed counts are cumulative.{value?.totalSamples === null && " Cumulative denominator unavailable until process restart."}</p></div>;
}
export default function SessionDedupStats() {
  const state = useStatusSnapshot("/api/token-saver/status");
  const s=state.snapshot, u=s?.usage, latency=u?.latency?.on, cleanup=u?.cleanupShadow;
  const mode=s?.config?.sessionDedupMode;
  let empty;
  if(u?.preparations === 0) empty="No activity in this runtime session.";
  else if(u?.eligibleResults === 0) empty="Preparations observed; no eligible exact-dedup results. Protected/unscanned results do not prove absence of duplicates.";
  else if(u?.exactDuplicatesFound === 0) empty="No raw- or body-byte-identical eligible results observed.";
  else if(u?.plannedResults > 0 && u?.appliedResults === 0) empty=mode==='shadow'?"Shadow candidates measured; no replacements applied.":"Exact candidates planned; no replacements applied. Inspect final guards and mode details.";
  return <section aria-label="Session Dedup metrics" className="space-y-4 pb-6">
    <StatusHeader title="Session Dedup" state={state} mode={mode === 'on' ? 'Enabled' : mode === 'shadow' ? 'Shadow' : mode === 'off' ? 'Off' : null} />
    {!s ? <InitialState state={state} /> : <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Applied results" value={num(u?.appliedResults)} sub="Final correspondence verified · On" />
        <Metric label="Bytes saved" value={num(u?.bytesSaved)} sub="Source-payload-equivalent · On" />
        <Metric label="Exact candidates" value={num(u?.plannedResults)} sub="Planned · On and Shadow" />
        <Metric label="Preparation p95" value={ms(latency?.p95Ms)} sub={`On p50 ${ms(latency?.p50Ms)} · window ${num(latency?.sampleCount)} / ${num(latency?.capacity)}`} />
      </div>
      <p className="text-sm text-text-muted">Coverage: preparations {num(u?.preparations)} → observed tool results (indexed) {num(u?.scannedResults)} → eligible results {num(u?.eligibleResults)} → planned candidates {num(u?.plannedResults)} → applied results {num(u?.appliedResults)}</p>
      <p className="text-xs text-text-muted">Indexed tool results cover planner observations; early-protected or unscanned preparations may be absent. Eligible results pass exact-dedup guards; planned candidates have a preserved anchor and positive byte savings. Applied results pass final correspondence checks. Counts are cumulative preparation observations, not unique requests or tool executions.</p>
      <p className="text-sm text-text-muted">Exact duplicates found {num(u?.exactDuplicatesFound)} (non-double-counted total) · Raw exact {num(u?.rawExactDuplicatesFound)} · Body exact {num(u?.bodyExactDuplicatesFound)}</p>
      <p className="text-sm text-text-muted">Body replacements committed {num(u?.bodyAppliedResults)} · Body replacement bytes saved {num(u?.bodyAppliedSaveBytes)} (included in total savings) · Rejected envelopes {num(u?.envelopeRejected)}</p>
      {empty && <p className="text-sm text-text-muted">{empty}</p>}
      <p className="text-sm text-text-muted">Signed current-turn replay and Claude thinking prefixes stay intact. Zero applied results can be correct when all results are protected.</p>
      {u?.hashedResults > 0 && u?.exactDuplicatesFound === 0 && u?.eligibleResults === 0 && <p className="text-sm text-text-muted">No raw- or body-byte-identical eligible results observed.</p>}
      {mode==='off' && u?.preparations > 0 && <p className="text-sm text-text-muted">Feature off; historical runtime counters remain visible.</p>}
      <details><summary className="cursor-pointer font-medium">Measurement details</summary><div className="space-y-4 mt-3">
        <p className="text-sm text-text-muted">Estimated tokens saved {num(u?.estimatedTokensSaved)} (~4 characters/token; not billing savings) · Planned save bytes {num(u?.plannedSaveBytes)} · Would-save bytes {num(u?.wouldSaveBytes)} (On and Shadow source candidates) · Cross-family duplicates {num(u?.crossFamilyDuplicates)} (never applied) · Intra-turn eligible {num(u?.intraTurnEligibleResults)} / duplicates {num(u?.intraTurnDuplicatesFound)}</p>
        <p className="text-sm text-text-muted">Hashed results {num(u?.hashedResults)} may include protected anchors; not a candidate-rate denominator. Scanned bytes {num(u?.scannedBytes)}.</p>
        <CounterRows title="Protected results" values={u?.protected} />
        <CounterRows title="Skipped results" values={u?.skippedResults} />
        <CounterRows title="Skipped preparations (each reason at most once per preparation)" values={u?.skippedPreparations} />
        <p className="text-sm">Budget stopped preparations {num(u?.budgetStoppedPreparations)} · Final guard skipped preparations {num(u?.finalGuardSkippedPreparations)}</p>
        <Latency mode="On" value={u?.latency?.on} /><Latency mode="Shadow" value={u?.latency?.shadow} />
        <CounterRows title="Preparation modes" values={u?.byMode} />
        <CounterRows title="Preparations by genuine user turns" values={u?.preparationsByUserTurns} />
        <CounterRows title="Current-turn tool batches" values={u?.toolBatches} />
        <CounterRows title="Source opaque state observed (preparations; categories overlap)" values={u?.opaqueReasons} />
        <FinalReasons title="Final opaque guard reasons (rejected preparations; categories overlap)" values={u?.finalOpaqueReasons} />
        <FinalReasons title="Final correspondence reasons (rejected preparations)" values={u?.finalCorrespondenceReasons} />
        <p className="text-sm text-text-muted">New generic-cleanup and old-tool-truncation scans run only in Shadow, never On or Off; no cleanup is applied. Historical totals, including earlier runtime behavior, remain visible in all modes. Categories overlap; never add them to each other or to savings. Protected or unscanned text is excluded.</p>
        <FinalReasons title="Generic cleanup shadow bytes (historical measurements)" values={cleanup && Object.fromEntries(['trailingWhitespaceBytes','blankLineBytes','ansiBytes','adjacentDuplicateBytes','duplicateSystemBytes'].map(k=>[k,cleanup[k]]))} />
        <p className="text-sm">Old tool truncation: {num(cleanup?.oldToolTruncationBytes)} bytes — Shadow estimate — not applied</p>
        <p className="text-xs text-text-muted">Cleanup scanned bytes {num(cleanup?.scannedBytes)} · complete {num(cleanup?.completePreparations)} · partial {num(cleanup?.partialPreparations)} · budget stopped {num(cleanup?.budgetStoppedPreparations)}</p>
      </div></details>
      <p className="text-xs text-text-muted">Request-local raw-result or validated-body exact equality only; body replacement retains each target envelope. No normalization, fuzzy matching or old-output pruning. Current process only; restart/deploy resets counters. Missing fields show —, not zero. Saved bytes are not billed-token, prompt-cache or cost savings.</p>
    </>}
  </section>;
}
