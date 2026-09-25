// open-sse/rtk/headroomWarmup.js
// Dedicated background session prewarm orchestration for Headroom Gateway sidecar.
// Handles bounded concurrency, deduplication per session, safe snapshot isolation,
// and state tracking without creating fake usage obligations or polluting provider stream.

import crypto from "node:crypto";
import {
  HEADROOM_PREWARM_ENABLED,
  HEADROOM_PREWARM_MIN_TOKENS,
  HEADROOM_PREWARM_MAX_QUEUE,
  HEADROOM_PREWARM_MAX_BYTES,
  HEADROOM_PREWARM_SESSION_CAP,
  HEADROOM_PREWARM_TIMEOUT_MS,
  HEADROOM_PREWARM_QUEUE_EXPIRY_MS,
  HEADROOM_PREWARM_COOLDOWN_MS,
  HEADROOM_PREWARM_SESSION_TTL_MS,
} from "../config/runtimeConfig.js";

const WARMUP_STORE = Symbol.for("9router.headroom.warmup");

function getWarmupStore() {
  if (!globalThis[WARMUP_STORE]) {
    globalThis[WARMUP_STORE] = {
      sessions: new Map(), // key -> { state, fingerprint, lastSeen, readyUntil, failureCount, cooldownUntil, frozenCount, unit }
      queue: [],           // array of queued job objects
      runningCount: 0,     // active background calls
      queuedBytes: 0,      // total bytes in queued snapshots
      metrics: {
        queuedTotal: 0,
        completedTotal: 0,
        failedTotal: 0,
        timeoutTotal: 0,
        droppedTotal: 0,
        dedupedTotal: 0,
        expiredTotal: 0,
      },
    };
  }
  return globalThis[WARMUP_STORE];
}

export function resetWarmupStoreForTest() {
  const store = getWarmupStore();
  store.sessions.clear();
  store.queue = [];
  store.runningCount = 0;
  store.queuedBytes = 0;
  store.metrics = {
    queuedTotal: 0,
    completedTotal: 0,
    failedTotal: 0,
    timeoutTotal: 0,
    droppedTotal: 0,
    dedupedTotal: 0,
    expiredTotal: 0,
  };
}

export function buildWarmupKey({ endpoint, sessionId, format }) {
  if (!endpoint || !sessionId) return null;
  const cleanEndpoint = String(endpoint).replace(/\/+$/, "");
  return `${cleanEndpoint}|${format || "openai"}|${sessionId}`;
}

export function computeTranscriptFingerprint(body, format) {
  if (!body || typeof body !== "object") return null;
  try {
    let items = [];
    if (format === "openai-responses") {
      items = Array.isArray(body.input) ? body.input : [];
    } else if (format === "kiro") {
      const history = body.conversationState?.history || [];
      const current = body.conversationState?.currentMessage;
      items = current ? [...history, current] : history;
    } else {
      items = Array.isArray(body.messages) ? body.messages : [];
    }
    const digest = crypto.createHash("sha256");
    digest.update(String(items.length));
    for (const item of items) {
      if (typeof item === "string") {
        digest.update(item);
      } else if (item && typeof item === "object") {
        digest.update(JSON.stringify(item));
      }
    }
    return digest.digest("hex").slice(0, 24);
  } catch {
    return null;
  }
}

export function estimateBodyTextTokens(body, format) {
  if (!body || typeof body !== "object") return 0;
  let totalChars = 0;
  const countText = (val) => {
    if (typeof val === "string") totalChars += val.length;
    else if (Array.isArray(val)) {
      for (const p of val) {
        if (typeof p === "string") totalChars += p.length;
        else if (p && typeof p === "object") {
          if (typeof p.text === "string") totalChars += p.text.length;
          if (typeof p.content === "string") totalChars += p.content.length;
        }
      }
    }
  };

  if (format === "openai-responses") {
    if (typeof body.instructions === "string") totalChars += body.instructions.length;
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!item || typeof item !== "object") continue;
        if (item.content) countText(item.content);
        if (item.output) countText(item.output);
        if (item.input && typeof item.input === "string") totalChars += item.input.length;
      }
    }
  } else if (format === "kiro") {
    const history = body.conversationState?.history || [];
    for (const h of history) {
      const msg = h.assistantResponseMessage || h.userInputMessage;
      if (msg?.content) countText(msg.content);
    }
    const curr = body.conversationState?.currentMessage?.userInputMessage;
    if (curr?.content) countText(curr.content);
  } else {
    if (typeof body.system === "string") totalChars += body.system.length;
    else if (Array.isArray(body.system)) countText(body.system);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m) continue;
        if (m.content) countText(m.content);
      }
    }
  }

  // Common heuristic: 1 token ≈ 4 characters of natural language / code / logs
  return Math.ceil(totalChars / 4);
}

export function getSessionWarmupState(key) {
  if (!key) return null;
  const store = getWarmupStore();
  const entry = store.sessions.get(key);
  if (!entry) return { state: "COLD" };
  const now = Date.now();
  if (entry.cooldownUntil && now < entry.cooldownUntil) {
    return { state: "COOLDOWN", ...entry };
  }
  if (entry.state === "READY" && entry.readyUntil && now > entry.readyUntil) {
    return { state: "EXPIRED", ...entry };
  }
  return entry;
}

export function recordWarmupSuccess(key, { fingerprint, frozenCount = 0, unit = "messages" } = {}) {
  if (!key) return;
  const store = getWarmupStore();
  const now = Date.now();
  store.sessions.set(key, {
    state: "READY",
    fingerprint,
    lastSeen: now,
    readyUntil: now + HEADROOM_PREWARM_SESSION_TTL_MS,
    failureCount: 0,
    cooldownUntil: 0,
    frozenCount,
    unit,
  });
}

export function recordWarmupFailure(key, reason) {
  if (!key) return;
  const store = getWarmupStore();
  const now = Date.now();
  const existing = store.sessions.get(key) || { failureCount: 0 };
  const failureCount = (existing.failureCount || 0) + 1;
  const cooldownDuration = Math.min(HEADROOM_PREWARM_COOLDOWN_MS * failureCount, 120000);
  store.sessions.set(key, {
    state: reason === "gateway_timeout" ? "UNKNOWN_TIMEOUT" : "COOLDOWN",
    lastSeen: now,
    failureCount,
    cooldownUntil: now + cooldownDuration,
  });
}

export function shouldAttemptPrewarm({
  enabled = HEADROOM_PREWARM_ENABLED,
  isSSE = false,
  sessionId = null,
  body = null,
  format = "openai",
  endpoint = null,
} = {}) {
  if (!enabled || !isSSE || !sessionId || !body || !endpoint) {
    return { eligible: false, reason: "precondition_unmet" };
  }

  const key = buildWarmupKey({ endpoint, sessionId, format });
  const sessionStatus = getSessionWarmupState(key);

  // If already warming or queued, avoid concurrent duplicate sidecar runs
  if (sessionStatus.state === "WARMING" || sessionStatus.state === "QUEUED") {
    return { eligible: false, reason: "warmup_in_flight", key, sessionStatus };
  }
  if (sessionStatus.state === "COOLDOWN") {
    return { eligible: false, reason: "warmup_cooldown", key, sessionStatus };
  }

  const estimatedTokens = estimateBodyTextTokens(body, format);
  if (estimatedTokens < HEADROOM_PREWARM_MIN_TOKENS) {
    return { eligible: false, reason: "context_below_threshold", estimatedTokens, key };
  }

  return { eligible: true, key, estimatedTokens, sessionStatus };
}

/**
 * Enqueue a background prewarm job.
 * Creates an immutable snapshot so foreground body translation / mutation cannot pollute the run.
 */
export function enqueuePrewarmJob({
  endpoint,
  proxyToken = "",
  model,
  format,
  body,
  sessionId,
  callGatewayFn,
  log = null,
} = {}) {
  const store = getWarmupStore();
  const key = buildWarmupKey({ endpoint, sessionId, format });
  if (!key) return false;

  // Prune expired sessions if store exceeds cap
  if (store.sessions.size >= HEADROOM_PREWARM_SESSION_CAP) {
    const now = Date.now();
    for (const [k, v] of store.sessions) {
      if ((v.readyUntil && now > v.readyUntil) || (v.cooldownUntil && now > v.cooldownUntil)) {
        store.sessions.delete(k);
      }
    }
  }

  // Queue limits
  if (store.queue.length >= HEADROOM_PREWARM_MAX_QUEUE) {
    store.metrics.droppedTotal++;
    log?.warn?.("HEADROOM_PREWARM", `dropped job for ${sessionId}: queue full (${store.queue.length})`);
    return false;
  }

  // Snapshot memory budget
  let snapshotString = "";
  try {
    snapshotString = JSON.stringify(body);
  } catch {
    return false;
  }
  const snapshotBytes = new TextEncoder().encode(snapshotString).length;
  if (store.queuedBytes + snapshotBytes > HEADROOM_PREWARM_MAX_BYTES) {
    store.metrics.droppedTotal++;
    log?.warn?.("HEADROOM_PREWARM", `dropped job for ${sessionId}: memory cap reached (${store.queuedBytes} bytes)`);
    return false;
  }

  const fingerprint = computeTranscriptFingerprint(body, format);
  const now = Date.now();

  // Atomically reserve session state
  store.sessions.set(key, {
    state: "QUEUED",
    fingerprint,
    lastSeen: now,
    queuedAt: now,
  });

  const job = {
    id: crypto.randomUUID(),
    key,
    endpoint,
    proxyToken,
    model,
    format,
    sessionId,
    fingerprint,
    snapshotString,
    snapshotBytes,
    queuedAt: now,
    callGatewayFn,
    log,
  };

  store.queue.push(job);
  store.queuedBytes += snapshotBytes;
  store.metrics.queuedTotal++;

  log?.info?.("HEADROOM_PREWARM", `job queued id=${job.id} session=${sessionId} bytes=${snapshotBytes}`);

  // Schedule async consumer on next event loop tick
  queueMicrotask(() => processWarmupQueue());
  return true;
}

async function processWarmupQueue() {
  const store = getWarmupStore();
  // Bound concurrency to 1 active worker to avoid overloading sidecar
  if (store.runningCount >= 1 || store.queue.length === 0) return;

  const now = Date.now();
  // Discard expired jobs
  while (store.queue.length > 0) {
    const front = store.queue[0];
    if (now - front.queuedAt > HEADROOM_PREWARM_QUEUE_EXPIRY_MS) {
      const expired = store.queue.shift();
      store.queuedBytes = Math.max(0, store.queuedBytes - expired.snapshotBytes);
      store.metrics.expiredTotal++;
      recordWarmupFailure(expired.key, "queue_expired");
      continue;
    }
    break;
  }

  if (store.queue.length === 0) return;
  const job = store.queue.shift();
  store.queuedBytes = Math.max(0, store.queuedBytes - job.snapshotBytes);
  store.runningCount++;

  const sessionEntry = store.sessions.get(job.key);
  if (sessionEntry) sessionEntry.state = "WARMING";

  try {
    let cleanSnapshotBody;
    try {
      cleanSnapshotBody = JSON.parse(job.snapshotString);
    } catch {
      recordWarmupFailure(job.key, "parse_error");
      return;
    }

    const diagnostics = {};
    const res = await job.callGatewayFn({
      url: job.endpoint,
      proxyToken: job.proxyToken,
      model: job.model,
      format: job.format,
      body: cleanSnapshotBody,
      sessionId: job.sessionId,
      isSSE: false,
      timeoutMs: HEADROOM_PREWARM_TIMEOUT_MS,
      diagnostics,
      isBackgroundPrewarm: true, // Informs gateway to set can_relay_response=false and omit relay obligation
    });

    if (res && diagnostics.accepted) {
      store.metrics.completedTotal++;
      const sessionDiag = diagnostics.session || {};
      recordWarmupSuccess(job.key, {
        fingerprint: job.fingerprint,
        frozenCount: sessionDiag.frozen_message_count || 0,
        unit: job.format === "openai-responses" ? "responses_text_slots" : "messages",
      });
      job.log?.info?.("HEADROOM_PREWARM", `warmup completed id=${job.id} frozen=${sessionDiag.frozen_message_count ?? 0}`);
    } else {
      const reason = diagnostics.reason || "warmup_failed";
      if (reason === "gateway_timeout" || reason === "compression_timeout") {
        store.metrics.timeoutTotal++;
      } else {
        store.metrics.failedTotal++;
      }
      recordWarmupFailure(job.key, reason);
      job.log?.warn?.("HEADROOM_PREWARM", `warmup failed id=${job.id} reason=${reason}`);
    }
  } catch (error) {
    store.metrics.failedTotal++;
    recordWarmupFailure(job.key, error?.code || "unexpected_error");
    job.log?.error?.("HEADROOM_PREWARM", `warmup exception id=${job.id}: ${error?.message || error}`);
  } finally {
    store.runningCount = Math.max(0, store.runningCount - 1);
    if (store.queue.length > 0) {
      queueMicrotask(() => processWarmupQueue());
    }
  }
}

export function getWarmupRuntimeSnapshot() {
  const store = getWarmupStore();
  return {
    queueLength: store.queue.length,
    queuedBytes: store.queuedBytes,
    runningCount: store.runningCount,
    trackedSessions: store.sessions.size,
    metrics: { ...store.metrics },
  };
}
