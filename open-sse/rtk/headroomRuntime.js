import {
  HEADROOM_CIRCUIT_FAILURE_THRESHOLD as THRESHOLD,
  HEADROOM_CIRCUIT_COOLDOWN_MS as COOLDOWN,
  HEADROOM_METRIC_SAMPLE_LIMIT as WINDOW,
  HEADROOM_RUNTIME_MAX_ENDPOINTS as CAPACITY,
  HEADROOM_MAX_INFLIGHT,
  HEADROOM_SSE_GUARD_ENABLED,
  HEADROOM_LATENCY_P95_LIMIT_MS,
  HEADROOM_LATENCY_WINDOW_MS,
  HEADROOM_LATENCY_WINDOW_SIZE,
  HEADROOM_LATENCY_MIN_SAMPLES,
  HEADROOM_LATENCY_SINGLE_SPIKE_LIMIT_MS,
  HEADROOM_LATENCY_COOLDOWN_MS,
  HEADROOM_STATELESS_SSE_MAX_BYTES,
} from "../config/runtimeConfig.js";

const STORE = Symbol.for("9router.headroom.runtime");
const store = () => globalThis[STORE] ||= new Map();
const codes = new Set([
  "gateway_timeout", "gateway_dns_error", "gateway_connection_refused", "gateway_connection_reset",
  "gateway_fetch_error", "gateway_http_5xx", "gateway_http_429", "gateway_invalid_json_response",
  "gateway_missing_compressed_body", "gateway_compression_skipped", "gateway_invalid_provider_headers",
  "invariant_violation", "circuit_open", "circuit_probe_in_flight", "runtime_capacity", "capacity_busy", "compression_timeout",
  "payload_too_large", "budget_exhausted", "insufficient_upstream_budget", "unsafe_proxy_origin", "missing_proxy_url", "missing_body",
  "stage_bypass", "gateway_http_4xx", "model_sovereignty_violation", "unsupported_obligation",
  "latency_guard_open", "latency_probe_in_flight", "stateless_sse_payload_too_large", "client_opt_out",
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
    latencyGuard: {
      enabled: HEADROOM_SSE_GUARD_ENABLED,
      state: "CLOSED",
      openUntil: 0,
      generation: 0,
      probeInFlight: false,
      opened: 0,
      recent: [],
    },
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
        if (candidate.inFlight === 0 && candidate.state === "CLOSED" && candidate.latencyGuard?.state === "CLOSED" && (!victim || candidate.lastUsed < victim[1].lastUsed)) victim = [key, candidate];
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

function pruneRecentSamples(guard, now) {
  const cutoff = now - HEADROOM_LATENCY_WINDOW_MS;
  guard.recent = guard.recent.filter((item) => item.ts >= cutoff);
}

function calculateRecentP95(guard, now) {
  pruneRecentSamples(guard, now);
  if (guard.recent.length < HEADROOM_LATENCY_MIN_SAMPLES) return null;
  const sorted = guard.recent.map((x) => x.latencyMs).sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

export function beginHeadroomAttempt(endpoint, { bypassInFlight = false, isSSE = false, hasSession = false, isBackground = false } = {}) {
  const current = entry(endpoint, true);
  if (!current) return { reason: "runtime_capacity" };
  const now = Date.now();

  // 1. Existing service-failure circuit breaker
  if (current.state === "OPEN") {
    if (now < current.openUntil) return { reason: "circuit_open" };
    current.state = "HALF_OPEN";
  }
  if (current.state === "HALF_OPEN" && current.probeInFlight) return { reason: "circuit_probe_in_flight" };

  // 2. Dedicated latency guard for SSE (foreground only)
  let latencyProbe = false;
  const guard = current.latencyGuard ||= {
    enabled: HEADROOM_SSE_GUARD_ENABLED,
    state: "CLOSED",
    openUntil: 0,
    generation: 0,
    probeInFlight: false,
    opened: 0,
    recent: [],
  };

  if (!isBackground && isSSE && guard.enabled) {
    if (guard.state === "OPEN") {
      if (now < guard.openUntil) return { reason: "latency_guard_open" };
      guard.state = "HALF_OPEN";
    }
    if (guard.state === "HALF_OPEN") {
      if (guard.probeInFlight) return { reason: "latency_probe_in_flight" };
      latencyProbe = true;
    }
  }

  const probe = current.state === "HALF_OPEN";
  if (!probe && !latencyProbe && !bypassInFlight && current.inFlight >= HEADROOM_MAX_INFLIGHT) {
    return { reason: "capacity_busy" };
  }

  if (probe) current.probeInFlight = true;
  if (latencyProbe) guard.probeInFlight = true;
  current.inFlight++;

  return {
    ticket: {
      current,
      generation: current.generation,
      probe,
      latencyProbe,
      latencyGeneration: guard.generation,
      isSSE: isBackground ? false : isSSE,
      hasSession: Boolean(hasSession),
      isBackground: Boolean(isBackground),
      attempted: false,
      finalized: false,
    },
  };
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
  const guard = s.latencyGuard;
  const now = Date.now();
  s.inFlight--;
  if (ticket.probe) s.probeInFlight = false;
  if (ticket.latencyProbe && guard) guard.probeInFlight = false;

  const isLatencyLearningOutcome = (
    kind === "success"
    || (kind === "service_failure" && (reason === "gateway_timeout" || reason === "compression_timeout" || Number.isFinite(latencyMs)))
  );

  if (ticket.attempted && Number.isFinite(latencyMs)) {
    s.samples[s.samplePosition++ % WINDOW] = latencyMs;
    s.sampleCount = Math.min(WINDOW, s.sampleCount + 1);
    s.latencyCount++;
    s.latencySum += latencyMs;
    s.latencyMin = Math.min(s.latencyMin ?? latencyMs, latencyMs);
    s.latencyMax = Math.max(s.latencyMax ?? latencyMs, latencyMs);

    if (guard && ticket.isSSE && guard.enabled && isLatencyLearningOutcome) {
      guard.recent.push({ latencyMs, ts: now });
      if (guard.recent.length > HEADROOM_LATENCY_WINDOW_SIZE) {
        guard.recent.splice(0, guard.recent.length - HEADROOM_LATENCY_WINDOW_SIZE);
      }
      pruneRecentSamples(guard, now);
    }
  }

  if (kind === "success") s.success++;
  else if (kind === "cancelled") s.cancelled++;
  else {
    s.bypass++;
    const label = code(reason);
    s.outcomes[label] = (s.outcomes[label] || 0) + 1;
    if (reason === "gateway_timeout" || reason === "compression_timeout") s.timeout++;
  }

  let circuitTransition = null;
  if (ticket.generation === s.generation) {
    if (kind === "service_failure") {
      if (ticket.probe || ++s.failures >= THRESHOLD) {
        s.state = "OPEN";
        s.openUntil = now + COOLDOWN;
        s.failures = 0;
        s.opened++;
        s.generation++;
        circuitTransition = "opened";
      }
    } else if (kind === "success") {
      const recovered = ticket.probe;
      s.state = "CLOSED";
      s.failures = 0;
      s.openUntil = 0;
      if (recovered) {
        s.generation++;
        circuitTransition = "recovered";
      }
    } else if (kind === "neutral") {
      if (ticket.probe) {
        s.state = "OPEN";
        s.openUntil = 0;
      }
    } else if (ticket.probe) {
      s.state = "OPEN";
      s.openUntil = 0;
    }
  }

  // Latency guard state transitions for SSE
  let latencyTransition = null;
  if (guard && guard.enabled && ticket.isSSE) {
    const isTimeout = reason === "gateway_timeout" || reason === "compression_timeout";
    const isSevereSpike = Number.isFinite(latencyMs) && latencyMs >= HEADROOM_LATENCY_SINGLE_SPIKE_LIMIT_MS;
    const recentP95 = calculateRecentP95(guard, now);
    const p95Exceeded = recentP95 != null && recentP95 > HEADROOM_LATENCY_P95_LIMIT_MS;

    if (ticket.latencyProbe) {
      if (ticket.latencyGeneration === guard.generation) {
        if (kind === "success" && Number.isFinite(latencyMs) && latencyMs <= HEADROOM_LATENCY_P95_LIMIT_MS) {
          guard.state = "CLOSED";
          guard.openUntil = 0;
          guard.recent = [];
          guard.generation++;
          latencyTransition = "latency_recovered";
        } else {
          guard.state = "OPEN";
          guard.openUntil = now + HEADROOM_LATENCY_COOLDOWN_MS;
          guard.opened++;
          guard.generation++;
          latencyTransition = "latency_opened";
        }
      }
    } else if (guard.state === "CLOSED" && isLatencyLearningOutcome) {
      const shouldOpen = isTimeout || p95Exceeded || (!ticket.hasSession && isSevereSpike);
      if (shouldOpen) {
        guard.state = "OPEN";
        guard.openUntil = now + HEADROOM_LATENCY_COOLDOWN_MS;
        guard.opened++;
        guard.generation++;
        latencyTransition = "latency_opened";

        const trigger = isTimeout ? "timeout" : (p95Exceeded ? "p95_exceeded" : "severe_spike");
        ticket.latencyTrigger = {
          trigger,
          p95: recentP95,
          threshold: HEADROOM_LATENCY_P95_LIMIT_MS,
          samples: guard.recent.length,
          currentOutcome: reason || kind,
          currentLatency: latencyMs,
          lane: ticket.lane || null,
        };
      }
    }
  }

  return circuitTransition || latencyTransition;
}
export function getHeadroomRuntimeSnapshot(endpoint) {
  const s = entry(endpoint);
  const now = Date.now();
  const samples = s ? Array.from(s.samples.slice(0, s.sampleCount)).sort((a, b) => a - b) : [];
  const percentile = (p) => samples.length ? samples[Math.ceil(p * samples.length) - 1] : null;
  const guard = s?.latencyGuard;
  const recentP95 = guard ? calculateRecentP95(guard, now) : null;

  return {
    scope: "process", sampleWindow: WINDOW, headroom_requests: s?.requests || 0,
    headroom_success: s?.success || 0, headroom_timeout: s?.timeout || 0,
    headroom_bypass: s?.bypass || 0, headroom_circuit_open: s && s.state !== "CLOSED" ? 1 : 0,
    headroom_circuit_open_total: s?.opened || 0, headroom_cancelled: s?.cancelled || 0,
    circuitState: s?.state || "CLOSED", outcomes: { ...s?.outcomes },
    headroom_latency_ms: { count: s?.latencyCount || 0, sum: s?.latencySum || 0,
      min: s?.latencyMin ?? null, max: s?.latencyMax ?? null, sampleCount: samples.length,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    latencyGuard: {
      enabled: Boolean(guard?.enabled),
      state: guard?.state || "CLOSED",
      openUntil: guard?.openUntil || 0,
      remainingCooldownMs: guard?.openUntil ? Math.max(0, guard.openUntil - now) : 0,
      probeInFlight: Boolean(guard?.probeInFlight),
      openedTotal: guard?.opened || 0,
      recentSamples: guard?.recent?.length || 0,
      recentP95,
      thresholdMs: HEADROOM_LATENCY_P95_LIMIT_MS,
      statelessSseCutoffBytes: HEADROOM_STATELESS_SSE_MAX_BYTES,
    },
  };
}
