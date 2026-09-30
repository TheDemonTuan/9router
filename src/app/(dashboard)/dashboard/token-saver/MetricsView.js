"use client";
import { useState } from "react";
import { Card, Button } from "@/shared/components";
export const num = value => value == null ? "—" : value.toLocaleString();
export const date = value => value ? new Date(value).toLocaleString() : "—";
export const ms = value => value == null ? "—" : `${value.toFixed(2)} ms`;
export function Metric({ label, value, sub }) {
  return <Card className="p-4"><p className="text-xs text-text-muted uppercase tracking-wide">{label}</p><p className="text-xl font-semibold mt-1">{value}</p><p className="text-xs text-text-muted mt-1">{sub}</p></Card>;
}
export function StatusHeader({ title, state, mode }) {
  return <><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{title}</h3><div className="flex flex-wrap items-center gap-2 text-sm"><span className="rounded bg-surface-2 px-2 py-1">{mode || "—"}</span>{state.error && <span className="text-warning">{state.snapshot ? "Stale" : "Unavailable"}</span>}<Button size="sm" variant="ghost" disabled={state.authRequired} onClick={state.refresh}>Refresh</Button></div></div>
    <p className="text-xs text-text-muted">Runtime started {date(state.snapshot?.session?.startedAt)} · Last received {date(state.receivedAt)}</p>
    {state.error && <p role="alert" className="text-sm text-warning">{state.error}</p>}
    {state.reset && <p role="status" className="text-sm text-text-muted">Runtime session changed; counters reset. Previous counters are not added.</p>}
  </>;
}
export function InitialState({ state }) {
  return state.error ? <p className="text-sm text-text-muted">Status unavailable. Refresh to retry.</p> : <div role="status" aria-label="Loading metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">{[0,1,2,3].map(i => <div key={i} className="h-24 rounded bg-surface-2 animate-pulse" />)}</div>;
}
export function CounterRows({ title, values, labels = {} }) {
  const rows = Object.entries(values || {}).filter(([,n]) => n > 0).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
  return <div><h4 className="text-sm font-medium mb-2">{title}</h4>{rows.length ? <dl className="grid gap-1 sm:grid-cols-2 text-sm">{rows.map(([k,n]) => <div className="flex justify-between gap-3" key={k}><dt>{labels[k] || k.replaceAll('_',' ')}</dt><dd>{num(n)}</dd></div>)}</dl> : <p className="text-sm text-text-muted">No observations</p>}</div>;
}
export function BoundedTable({ title, rows = [], columns, countKey = "count", overflow = 0 }) {
  const [all, setAll] = useState(false);
  const sorted = [...rows].sort((a,b) => (b[countKey] || 0)-(a[countKey] || 0) || columns.map(c => String(a[c.key] ?? '')).join(':').localeCompare(columns.map(c => String(b[c.key] ?? '')).join(':'))).slice(0,128);
  return <div className="space-y-2"><div className="flex justify-between items-center gap-3"><h4 className="text-sm font-medium">{title}</h4>{sorted.length > 10 && <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show 10" : "Show all"}</Button>}</div>
    {overflow > 0 && <p className="text-xs text-warning">Overflow: {num(overflow)} observations without retained detail. This table is incomplete (128-row bound).</p>}
    {sorted.length ? <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{columns.map(c => <th scope="col" className="py-2 pr-3" key={c.key}>{c.label}</th>)}</tr></thead><tbody>{sorted.slice(0,all ? 128 : 10).map((row,i) => <tr className="border-t border-border" key={i}>{columns.map(c => <td className="py-2 pr-3" key={c.key}>{c.render ? c.render(row) : typeof row[c.key] === 'number' ? num(row[c.key]) : row[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div> : <p className="text-sm text-text-muted">No observations</p>}
  </div>;
}
