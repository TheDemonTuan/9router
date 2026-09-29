import {
  RTK_CONFIG,
  RTK_REJECTIONS,
  RTK_PIPE_FILTERS,
  RTK_LOCAL_FILTERS,
  RTK_TOOL_FAMILIES,
  RTK_TRACKED_FAMILIES,
  RTK_DIAGNOSTIC_DETAILS,
  RTK_DIAGNOSTIC_OUTCOMES,
} from "../config/rtkConfig.js";
import { randomUUID } from "node:crypto";

const KEY = Symbol.for("9router.rtk.runtime.v1");
const reasons = ["disabled", "opted_out", "structured_output", "native_passthrough", "unsupported_shape", "no_eligible_output", "no_change", "compressed", "timeout", "cancelled", "failed"];
const outcomes = ["attempts", "succeeded", "unchanged", "failed", "busy", "rejected", "timedOut", "cancelled", "totalDurationMs"];
const skips = ["unconfigured", "invalid_url", "invalid_text", "size_limit", "circuit_open", "probe_in_flight", "saturated", "payload_limit"];
const zero = keys => Object.fromEntries(keys.map(key => [key, 0]));
const validFamilies = new Set(RTK_TOOL_FAMILIES);
const validRejections = new Set(RTK_REJECTIONS);
const validDetails = new Set(RTK_DIAGNOSTIC_DETAILS);
const validFilters = new Set([...RTK_PIPE_FILTERS, ...RTK_LOCAL_FILTERS]);
const validOutcomes = new Set(RTK_DIAGNOSTIC_OUTCOMES);
const trackedFamilies = new Set(RTK_TRACKED_FAMILIES);

function toSafeInt(val) {
  if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) return 0;
  return val >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.floor(val);
}

function safeAdd(a, b) {
  const sum = (Number.isFinite(a) && a > 0 ? a : 0) + (Number.isFinite(b) && b > 0 ? b : 0);
  return sum >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.floor(sum);
}

function getDiagnosticsSnapshot(diagnostics) {
  if (!diagnostics) return { rejections: [], filters: [], overflow: { rejections: 0, filters: 0 } };
  const rejections = Object.values(diagnostics.rejections || {})
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || `${a.toolFamily}:${a.reason}:${a.detail}`.localeCompare(`${b.toolFamily}:${b.reason}:${b.detail}`))
    .map(row => ({ ...row }));
  const filters = Object.values(diagnostics.filters || {})
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || `${a.toolFamily}:${a.filter}:${a.engine}:${a.fallback}:${a.outcome}`.localeCompare(`${b.toolFamily}:${b.filter}:${b.engine}:${b.fallback}:${b.outcome}`))
    .map(row => ({ ...row }));
  return {
    rejections,
    filters,
    overflow: {
      rejections: diagnostics.overflow?.rejections ?? 0,
      filters: diagnostics.overflow?.filters ?? 0,
    },
  };
}
export function getRtkState() {
  const state = globalThis[KEY] ??= {
    session: { id: randomUUID(), startedAt: new Date().toISOString(), slot: ["blue", "green"].includes(process.env.DEPLOY_SLOT) ? process.env.DEPLOY_SLOT : null },
    usage: {
      preparations: 0, compressedPreparations: 0, appliedOutputs: 0,
      bytesBefore: 0, bytesAfter: 0, estimatedTokensSaved: 0, lastAppliedAt: null,
      preparationReasons: zero(reasons), http: zero(outcomes), local: { attempts: 0, applied: 0, fallbacks: 0 }, skipped: zero(skips), filters: {},
      eligibility: { toolResults: 0, textLeaves: 0, resultsWithoutText: 0, noToolResultsPreparations: 0, rejected: zero(RTK_REJECTIONS) },
    },
    client: { initialized: false, endpoint: null, endpointState: "unconfigured", dispatcher: null, active: 0, openUntil: 0, generation: 0, probe: false, warningAt: 0, lastSuccessAt: null, lastFailure: null, check: null, checkPromise: null },
  };
  state.diagnosticsLastLogAt ??= null;
  state.usage.diagnostics ??= {
    rejections: {},
    filters: {},
    overflow: { rejections: 0, filters: 0 },
  };
  return state;
}
export function getRtkSnapshot() {
  const { session, usage } = getRtkState();
  const diagnostics = getDiagnosticsSnapshot(usage.diagnostics);
  return {
    session: { ...session },
    usage: {
      ...usage, preparationReasons: { ...usage.preparationReasons }, http: { ...usage.http }, local: { ...usage.local },
      skipped: { ...usage.skipped }, filters: Object.values(usage.filters).map(row => ({ ...row, engines: { ...row.engines } })),
      eligibility: { ...usage.eligibility, rejected: { ...usage.eligibility.rejected } },
      diagnostics,
    },
    diagnostics,
  };
}

export function recordRtkRejection(toolFamily, reason, detail, inputBytes) {
  if (!trackedFamilies.has(toolFamily)) return;
  const diagnostics = getRtkState().usage.diagnostics;
  const safeFamily = validFamilies.has(toolFamily) ? toolFamily : "other";
  const safeReason = validRejections.has(reason) ? reason : "unknown";
  const safeDetail = validDetails.has(detail) ? detail : "none";
  const safeBytes = toSafeInt(inputBytes);
  const key = `${safeFamily}:${safeReason}:${safeDetail}`;
  const existing = diagnostics.rejections[key];
  if (existing) {
    existing.count = safeAdd(existing.count, 1);
    existing.inputBytes = safeAdd(existing.inputBytes, safeBytes);
    return;
  }
  if (Object.keys(diagnostics.rejections).length >= RTK_CONFIG.diagnosticMaxRows) {
    diagnostics.overflow.rejections = safeAdd(diagnostics.overflow.rejections, 1);
    return;
  }
  diagnostics.rejections[key] = {
    toolFamily: safeFamily,
    reason: safeReason,
    detail: safeDetail,
    count: 1,
    inputBytes: safeBytes,
  };
}

export function recordRtkFilterOutcome(toolFamily, filter, engine, fallback, outcome, inputBytes, outputBytes) {
  if (engine !== "local" && engine !== "sidecar") return;
  if (typeof fallback !== "boolean") return;
  const diagnostics = getRtkState().usage.diagnostics;
  const safeFamily = validFamilies.has(toolFamily) ? toolFamily : "other";
  const safeFilter = validFilters.has(filter) ? filter : "unknown";
  const safeOutcome = validOutcomes.has(outcome) ? outcome : "unknown";
  const safeIn = toSafeInt(inputBytes);
  const safeOut = toSafeInt(outputBytes);
  const key = `${safeFamily}:${safeFilter}:${engine}:${fallback ? 1 : 0}:${safeOutcome}`;
  const existing = diagnostics.filters[key];
  if (existing) {
    existing.count = safeAdd(existing.count, 1);
    existing.inputBytes = safeAdd(existing.inputBytes, safeIn);
    existing.outputBytes = safeAdd(existing.outputBytes, safeOut);
    return;
  }
  if (Object.keys(diagnostics.filters).length >= RTK_CONFIG.diagnosticMaxRows) {
    diagnostics.overflow.filters = safeAdd(diagnostics.overflow.filters, 1);
    return;
  }
  diagnostics.filters[key] = {
    toolFamily: safeFamily,
    filter: safeFilter,
    engine,
    fallback,
    outcome: safeOutcome,
    count: 1,
    inputBytes: safeIn,
    outputBytes: safeOut,
  };
}

export function maybeLogRtkDiagnostics() {
  const state = getRtkState();
  const now = performance.now();
  if (state.diagnosticsLastLogAt !== null && now - state.diagnosticsLastLogAt < RTK_CONFIG.diagnosticLogMs) return;
  state.diagnosticsLastLogAt = now;
  try {
    const snapshot = getRtkSnapshot();
    const topRejections = snapshot.diagnostics.rejections.slice(0, RTK_CONFIG.diagnosticLogRows);
    const topFilters = snapshot.diagnostics.filters.slice(0, RTK_CONFIG.diagnosticLogRows);
    const payload = {
      session: snapshot.session,
      preparations: snapshot.usage.preparations,
      appliedOutputs: snapshot.usage.appliedOutputs,
      http: {
        attempts: snapshot.usage.http.attempts,
        succeeded: snapshot.usage.http.succeeded,
        unchanged: snapshot.usage.http.unchanged,
        failed: snapshot.usage.http.failed,
      },
      local: {
        attempts: snapshot.usage.local.attempts,
        applied: snapshot.usage.local.applied,
        fallbacks: snapshot.usage.local.fallbacks,
      },
      rejections: topRejections,
      filters: topFilters,
      omittedRows: {
        rejections: Math.max(0, snapshot.diagnostics.rejections.length - topRejections.length),
        filters: Math.max(0, snapshot.diagnostics.filters.length - topFilters.length),
      },
      overflow: { ...snapshot.diagnostics.overflow },
    };
    console.log(`[RTK diagnostics] ${JSON.stringify(payload)}`);
  } catch {}
}
