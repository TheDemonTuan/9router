import { ROUTER_PRE_RESPONSE_BUDGET_MS } from "../config/runtimeConfig.js";

const now = () => performance.now();

function createDeadlineError() {
  const error = new Error("Pre-response deadline exceeded");
  error.code = "PRE_RESPONSE_DEADLINE_EXCEEDED";
  error.status = 504;
  error.retryable = true;
  return error;
}

function createClientAbortError() {
  const error = new Error("Client closed request");
  error.code = "CLIENT_ABORT";
  error.status = 499;
  error.retryable = false;
  return error;
}

function responseBody(value) {
  if (!value) return null;
  if (typeof Response !== "undefined" && value instanceof Response) return value.body;
  if (typeof value === "object" && value.response) return responseBody(value.response);
  return null;
}

function cancelLateResponse(value) {
  const body = responseBody(value);
  if (!body || typeof body.cancel !== "function") return;
  try {
    const cancellation = body.cancel();
    cancellation?.catch?.(() => {});
  } catch {
    // Best effort: a response may already have been consumed or cancelled.
  }
}

/**
 * Bound all work required before a response is returned to the client.
 * The signal remains usable by downstream work until dispose() is called.
 */
export function createPreResponseBudget({ clientSignal = null, budgetMs = ROUTER_PRE_RESPONSE_BUDGET_MS } = {}) {
  const startedAt = now();
  const duration = Number.isFinite(Number(budgetMs)) ? Math.max(0, Number(budgetMs)) : ROUTER_PRE_RESPONSE_BUDGET_MS;
  const deadlineAt = startedAt + duration;
  const controller = new AbortController();
  let deadlineTimer = null;
  let disposed = false;
  let clientAbortListener = null;

  const abortDeadline = () => {
    if (controller.signal.aborted) return;
    controller.abort(createDeadlineError());
  };
  const abortClient = () => {
    if (controller.signal.aborted) return;
    controller.abort(createClientAbortError());
  };

  if (clientSignal) {
    clientAbortListener = abortClient;
    if (clientSignal.aborted) abortClient();
    else clientSignal.addEventListener("abort", clientAbortListener, { once: true });
  }

  if (!controller.signal.aborted) {
    if (duration <= 0) abortDeadline();
    else {
      deadlineTimer = setTimeout(abortDeadline, duration);
      deadlineTimer.unref?.();
    }
  }

  const reason = () => controller.signal.reason || createDeadlineError();
  const remainingMs = () => Math.max(0, deadlineAt - now());
  const expireIfNeeded = () => {
    if (!controller.signal.aborted && remainingMs() <= 0) abortDeadline();
    return controller.signal.aborted;
  };

  const run = (fn) => {
    if (expireIfNeeded()) return Promise.reject(reason());

    let raceSettled = false;
    let abortListener;
    const operation = Promise.resolve().then(() => {
      if (expireIfNeeded()) throw reason();
      return fn();
    });

    return new Promise((resolve, reject) => {
      const settle = (callback, value) => {
        if (raceSettled) return;
        raceSettled = true;
        controller.signal.removeEventListener("abort", abortListener);
        callback(value);
      };
      abortListener = () => settle(reject, reason());
      controller.signal.addEventListener("abort", abortListener, { once: true });

      operation.then(
        (value) => {
          if (expireIfNeeded()) {
            cancelLateResponse(value);
            return;
          }
          settle(resolve, value);
        },
        (error) => settle(reject, error),
      );
    });
  };

  const sleep = (ms) => {
    const delay = Math.max(0, Number(ms) || 0);
    if (expireIfNeeded()) return Promise.reject(reason());
    if (remainingMs() <= delay) return Promise.reject(createDeadlineError());

    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        clearTimeout(timer);
        timer = null;
        controller.signal.removeEventListener("abort", onAbort);
        reject(reason());
      };
      const done = () => {
        if (timer == null) return;
        timer = null;
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      timer = setTimeout(done, delay);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
    if (clientSignal && clientAbortListener) {
      clientSignal.removeEventListener("abort", clientAbortListener);
      clientAbortListener = null;
    }
  };

  return { startedAt, deadlineAt, signal: controller.signal, remainingMs, run, sleep, dispose };
}

export { createDeadlineError, createClientAbortError };

export default createPreResponseBudget;
