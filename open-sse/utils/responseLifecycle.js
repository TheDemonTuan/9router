export function bindResponseBody(response, { signal = null, onFinalize = null } = {}) {
  if (!response.body) {
    onFinalize?.();
    return response;
  }

  const reader = response.body.getReader();
  let controller;
  let terminal = false;
  let reading = false;

  const release = () => {
    if (reading) return;
    try { reader.releaseLock(); } catch { /* A pending read still owns the lock. */ }
  };
  const finalize = (reason, kind) => {
    if (terminal) return;
    terminal = true;
    signal?.removeEventListener("abort", onAbort);
    if (kind === "abort" || kind === "error") controller.error(reason);
    if (kind === "eof") controller.close();
    if (kind === "abort" || kind === "cancel") {
      try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { /* Source already terminal. */ }
    }
    try { onFinalize?.(); } catch { /* Cleanup must not replace the body outcome. */ } finally { release(); }
  };
  const onAbort = () => finalize(signal.reason, "abort");
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(streamController) {
      if (terminal) return;
      reading = true;
      try {
        const { value, done } = await reader.read();
        if (terminal) return;
        if (done) finalize(null, "eof");
        else streamController.enqueue(value);
      } catch (error) {
        if (!terminal) finalize(error, "error");
      } finally {
        reading = false;
        if (terminal) release();
      }
    },
    cancel(reason) {
      finalize(reason, "cancel");
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
