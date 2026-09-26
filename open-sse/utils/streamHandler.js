// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS, SSE_HEARTBEAT_INTERVAL_MS } from "../config/runtimeConfig.js";

const SSE_KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n");
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, onComplete, log, provider, model, reqTag = "", clientSignal = null } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  const removeClientListener = () => clientSignal?.removeEventListener("abort", clientAbort);
  const clientAbort = () => {
    if (disconnected) return;
    disconnected = true;
    removeClientListener();
    dbg("CTRL", `${provider}/${model} | clientSignal aborted | dur=${Date.now() - startTime}ms`);
    abortController.abort(clientSignal.reason);
    onDisconnect?.({ reason: "client_aborted", duration: Date.now() - startTime });
  };
  if (clientSignal?.aborted) clientAbort();
  else clientSignal?.addEventListener("abort", clientAbort, { once: true });

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;
      removeClientListener();

      // Debug-only: Responses API has no [DONE] sentinel, so codex/droid close the
      // socket on every completed request. "📊 done" is the authoritative outcome line.
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;
      removeClientListener();

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
      onComplete?.();
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;
      removeClientListener();

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        onError?.(error);
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: (reason) => abortController.abort(reason)
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 *
 * @param {function} [onAbortTerminal] - Receives a human-readable abort
 * message and returns terminal SSE bytes to emit downstream.
 */
export function createDisconnectAwareStream(readable, streamController, onAbortTerminal = null, { heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS, onFirstByte = null, heartbeatBytes = SSE_KEEPALIVE_BYTES } = {}) {
  const reader = readable.getReader();
  let heartbeatTimer = null;
  let lastDownstreamAt = Date.now();
  let firstByteEmitted = false;
  let finished = false;
  const markByte = () => {
    if (!firstByteEmitted) { firstByteEmitted = true; onFirstByte?.(); }
    lastDownstreamAt = Date.now();
  };
  const cleanup = () => {
    finished = true;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    streamController.signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    if (finished) return;
    try { Promise.resolve(reader.cancel(streamController.signal.reason)).catch(() => {}); } catch {}
  };
  const emitTerminal = (controller) => {
    if (!onAbortTerminal) return;
    try {
      const bytes = onAbortTerminal();
      if (bytes) { controller.enqueue(bytes); markByte(); }
    } catch { /* Best effort after disconnect. */ }
  };

  return new ReadableStream({
    start(controller) {
      if (streamController.signal?.aborted) onAbort();
      else streamController.signal?.addEventListener("abort", onAbort, { once: true });
      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (finished || !streamController.isConnected()) return;
          if (Date.now() - lastDownstreamAt < heartbeatIntervalMs || controller.desiredSize <= 0) return;
          try { controller.enqueue(heartbeatBytes); markByte(); } catch { cleanup(); }
        }, Math.min(heartbeatIntervalMs, 5000));
        heartbeatTimer.unref?.();
      }
    },
    async pull(controller) {
      if (finished) return;
      if (!streamController.isConnected()) {
        cleanup();
        emitTerminal(controller);
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          const aborted = streamController.signal?.aborted || !streamController.isConnected();
          cleanup();
          if (aborted) emitTerminal(controller);
          else streamController.handleComplete();
          controller.close();
        } else {
          controller.enqueue(value);
          if (value?.byteLength || value?.length) markByte();
        }
      } catch (error) {
        if (finished) return;
        const wasConnected = streamController.isConnected();
        cleanup();
        streamController.handleError(error);
        try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
        const code = error?.code || error?.cause?.code || "";
        const networkClose = error?.name === "AbortError" || /aborted|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE/.test(error?.message || "") || ["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(code);
        if (!wasConnected || networkClose || onAbortTerminal) {
          emitTerminal(controller);
          controller.close();
        } else controller.error(error);
      }
    },
    cancel(reason) {
      cleanup();
      try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch {}
      streamController.handleDisconnect(reason || "cancelled");
    },
  });
}

export function withWireHeartbeat(response, { clientSignal = null, format = "sse" } = {}) {
  const type = format === "ndjson" ? "application/x-ndjson" : "text/event-stream";
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes(type)) return response;
  const streamController = createStreamController({ clientSignal });
  const bytes = format === "ndjson" ? new TextEncoder().encode(" ") : SSE_KEEPALIVE_BYTES;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(createDisconnectAwareStream(response.body, streamController, null, { heartbeatBytes: bytes }), {
    status: response.status, statusText: response.statusText, headers,
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * A pending raw upstream read is subject to STREAM_STALL_TIMEOUT_MS.
 * Downstream backpressure never starts a stall timer.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, { onUpstreamFirstByte = null, onDownstreamFirstByte = null, heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS } = {}) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  let abortMessage = "upstream connection lost";
  const t0 = Date.now();
  const tag = "STREAM";
  const rawReader = providerResponse.body.getReader();
  let reading = false;
  let finished = false;
  const clearStall = () => { clearTimeout(stallTimer); stallTimer = null; };
  const release = () => { if (!reading) { try { rawReader.releaseLock(); } catch {} } };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearStall();
    streamController.signal?.removeEventListener("abort", onAbort);
    release();
  };
  const cancelRaw = (reason) => {
    if (finished) return;
    cleanup();
    try { Promise.resolve(rawReader.cancel(reason)).catch(() => {}); } catch {}
    release();
  };
  const onAbort = () => cancelRaw(streamController.signal.reason);
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); cleanup(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); cleanup(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); cancelRaw(r); streamController.handleDisconnect(r); },
    abort: () => { cancelRaw(); streamController.abort(); }
  };

  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);
  const rawBody = new ReadableStream({
    start() {
      if (streamController.signal?.aborted) onAbort();
      else streamController.signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (finished) { controller.close(); return; }
      reading = true;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (finished) return;
        abortMessage = "stream stall timeout";
        dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
        streamController.handleError?.(new Error(abortMessage));
        streamController.abort?.();
        cancelRaw(abortMessage);
      }, stallTimeoutMs);
      try {
        const { done, value } = await rawReader.read();
        clearStall();
        if (finished) { controller.close(); return; }
        if (done) {
          dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`);
          cleanup();
          controller.close();
          return;
        }
        if (chunkCount === 0) onUpstreamFirstByte?.();
        chunkCount++;
        const sz = value?.byteLength || value?.length || 0;
        totalBytes += sz;
        const now = Date.now();
        const gap = now - lastChunkAt;
        lastChunkAt = now;
        if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
          dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
        }
        controller.enqueue(value);
      } catch (error) {
        if (!finished) { cleanup(); controller.error(error); }
        else controller.close();
      } finally {
        reading = false;
        clearStall();
        if (finished) release();
      }
    },
    cancel: cancelRaw,
  });
  const transformedBody = rawBody.pipeThrough(transformStream);
  return createDisconnectAwareStream(transformedBody, wrappedController,
    onAbortTerminal ? () => onAbortTerminal(abortMessage) : null,
    { heartbeatIntervalMs, onFirstByte: onDownstreamFirstByte });
}

