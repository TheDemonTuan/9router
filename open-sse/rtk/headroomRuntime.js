import {
  HEADROOM_CIRCUIT_FAILURE_THRESHOLD as THRESHOLD,
  HEADROOM_CIRCUIT_COOLDOWN_MS as COOLDOWN,
  HEADROOM_METRIC_SAMPLE_LIMIT as WINDOW,
  HEADROOM_RUNTIME_MAX_ENDPOINTS as CAPACITY,
} from "../config/runtimeConfig.js";

const STORE = Symbol.for("9router.headroom.runtime");
const store = () => globalThis[STORE] ||= new Map();
const codes = new Set([
  "gateway_timeout", "gateway_dns_error", "gateway_connection_refused", "gateway_connection_reset",
  "gateway_fetch_error", "gateway_http_5xx", "gateway_http_429", "gateway_invalid_json_response",
  "gateway_missing_compressed_body", "gateway_compression_skipped", "gateway_invalid_provider_headers",
  "invariant_violation", "circuit_open", "circuit_probe_in_flight", "runtime_capacity",
  "payload_too_large", "budget_exhausted", "unsafe_proxy_origin", "missing_proxy_url", "missing_body",
  "stage_bypass", "gateway_http_4xx", "model_sovereignty_violation", "unsupported_obligation",
]);
function code(reason) {
  if (codes.has(reason)) return reason;
  if (/^gateway_http_\d{3}$/.test(reason || "")) return "gateway_http_4xx";
  return "invariant_violation";
}
function state() {
  return {
    state: "CLOSED", failures: 0, openUntil: 0, generation: 0, probeInFlight: false,
    inFlight: 0, lastUsed: Date.now(), requests: 0, success: 0, timeout: 0, bypass: 0,
    opened: 0, cancelled: 0, outcomes: Object.create(null), samples: new Float64Array(WINDOW),
    samplePosition: 0, sampleCount: 0, latencyCount: 0, latencySum: 0, latencyMin: null, latencyMax: null,
  };
}
function entry(endpoint, create = false) {
  if (!endpoint) return null;
  const map = store();
  let current = map.get(endpoint);
  if (!current && create) {
    if (map.size >= CAPACITY) {
      let victim;
      for (const [key, candidate] of map) {
        if (candidate.inFlight === 0 && candidate.state === "CLOSED" && (!victim || candidate.lastUsed < victim[1].lastUsed)) victim = [key, candidate];
      }
      if (!victim) return null;
      map.delete(victim[0]);
    }
    current = state();
    map.set(endpoint, current);
  }
  if (current && create) current.lastUsed = Date.now();
  return current;
}
export function beginHeadroomAttempt(endpoint) {
  const current = entry(endpoint, true);
  if (!current) return { reason: "runtime_capacity" };
  if (current.state === "OPEN") {
    if (Date.now() < current.openUntil) return { reason: "circuit_open" };
    current.state = "HALF_OPEN";
  }
  if (current.state === "HALF_OPEN" && current.probeInFlight) return { reason: "circuit_probe_in_flight" };
  const probe = current.state === "HALF_OPEN";
  if (probe) current.probeInFlight = true;
  current.inFlight++;
  return { ticket: { current, generation: current.generation, probe, attempted: false, finalized: false } };
}
export function markHeadroomAttemptStarted(ticket) {
  if (ticket.finalized || ticket.attempted) return;
  ticket.attempted = true;
  ticket.current.requests++;
}
export function recordHeadroomBypass(endpoint, reason) {
  const current = entry(endpoint, true);
  if (!current) return;
  current.bypass++;
  const label = code(reason);
  current.outcomes[label] = (current.outcomes[label] || 0) + 1;
}
export function finishHeadroomAttempt(ticket, { kind, reason, latencyMs } = {}) {
  if (ticket.finalized) return null;
  ticket.finalized = true;
  const s = ticket.current;
  s.inFlight--;
  if (ticket.probe) s.probeInFlight = false;
  if (ticket.attempted && Number.isFinite(latencyMs)) {
    s.samples[s.samplePosition++ % WINDOW] = latencyMs;
    s.sampleCount = Math.min(WINDOW, s.sampleCount + 1);
    s.latencyCount++;
    s.latencySum += latencyMs;
    s.latencyMin = Math.min(s.latencyMin ?? latencyMs, latencyMs);
    s.latencyMax = Math.max(s.latencyMax ?? latencyMs, latencyMs);
  }
  if (kind === "success") s.success++;
  else if (kind === "cancelled") s.cancelled++;
  else {
    s.bypass++;
    const label = code(reason);
    s.outcomes[label] = (s.outcomes[label] || 0) + 1;
    if (reason === "gateway_timeout") s.timeout++;
  }
  if (ticket.generation !== s.generation) return null;
  if (kind === "service_failure") {
    if (ticket.probe || ++s.failures >= THRESHOLD) {
      s.state = "OPEN";
      s.openUntil = Date.now() + COOLDOWN;
      s.failures = 0;
      s.opened++;
      s.generation++;
      return "opened";
    }
  } else if (kind === "success" || kind === "neutral") {
    const recovered = ticket.probe;
    s.state = "CLOSED";
    s.failures = 0;
    s.openUntil = 0;
    if (recovered) { s.generation++; return "recovered"; }
  } else if (ticket.probe) {
    s.state = "OPEN";
    s.openUntil = 0;
  }
  return null;
}
export function getHeadroomRuntimeSnapshot(endpoint) {
  const s = entry(endpoint);
  const samples = s ? Array.from(s.samples.slice(0, s.sampleCount)).sort((a, b) => a - b) : [];
  const percentile = (p) => samples.length ? samples[Math.ceil(p * samples.length) - 1] : null;
  return {
    scope: "process", sampleWindow: WINDOW, headroom_requests: s?.requests || 0,
    headroom_success: s?.success || 0, headroom_timeout: s?.timeout || 0,
    headroom_bypass: s?.bypass || 0, headroom_circuit_open: s && s.state !== "CLOSED" ? 1 : 0,
    headroom_circuit_open_total: s?.opened || 0, headroom_cancelled: s?.cancelled || 0,
    circuitState: s?.state || "CLOSED", outcomes: { ...s?.outcomes },
    headroom_latency_ms: { count: s?.latencyCount || 0, sum: s?.latencySum || 0,
      min: s?.latencyMin ?? null, max: s?.latencyMax ?? null, sampleCount: samples.length,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}
