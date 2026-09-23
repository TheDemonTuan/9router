// Lightweight event-loop lag watchdog without external dependencies
let lastTick = Date.now();
const intervalMs = 1000;

export function startPerfWatchdog() {
  lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - intervalMs;
    lastTick = now;
    if (lag > 250) {
      console.warn(`[PERF] event-loop lag ${lag}ms`);
    }
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

startPerfWatchdog();
