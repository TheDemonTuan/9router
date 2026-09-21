import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

function makeExec(config) {
  return new BaseExecutor("test", config);
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor — timeout and abort classification", () => {
  it("Case A: upstream connect timeout retries 504 and throws 504 UPSTREAM_CONNECT_TIMEOUT (not 499)", async () => {
    const ex = makeExec({
      baseUrl: "https://x/api",
      timeoutMs: 10,
      retry: { 504: { attempts: 2, delayMs: 0 } }
    });

    // Mock fetch that hangs until signal is aborted
    fetchMock.mockImplementation((url, opts) => {
      const signal = opts?.signal;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          return reject(err);
        }
        const timer = setTimeout(() => resolve(res(200)), 1000);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        }
      });
    });

    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.name).not.toBe("AbortError");
    expect(thrown.code).toBe("UPSTREAM_CONNECT_TIMEOUT");
    expect(thrown.status).toBe(504);
    expect(thrown.retryable).toBe(true);
    // Initial call + 2 retries = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Case B: client cancel throws CLIENT_ABORT (499, retryable=false) immediately with no retry", async () => {
    const ex = makeExec({
      baseUrl: "https://x/api",
      timeoutMs: 1000,
      retry: { 502: { attempts: 3, delayMs: 0 }, 504: { attempts: 3, delayMs: 0 } }
    });

    const clientController = new AbortController();

    fetchMock.mockImplementation((url, opts) => {
      const signal = opts?.signal;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(res(200)), 500);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            const err = new Error("client aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        }
        // Client aborts while in flight
        setTimeout(() => clientController.abort(), 10);
      });
    });

    let thrown = null;
    try {
      await ex.execute({
        model: "m",
        body: {},
        stream: false,
        credentials: creds,
        signal: clientController.signal
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe("CLIENT_ABORT");
    expect(thrown.status).toBe(499);
    expect(thrown.retryable).toBe(false);
    // Client cancel must terminate immediately without retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Case B2: first abort reason remains upstream timeout when client abort follows", () => {
    const timeoutError = Object.assign(new Error("connect timeout"), {
      code: "UPSTREAM_CONNECT_TIMEOUT",
      status: 504,
      retryable: true,
    });
    const clientError = Object.assign(new Error("client closed"), {
      code: "CLIENT_ABORT",
      status: 499,
      retryable: false,
    });
    const upstream = new AbortController();
    const client = new AbortController();
    const merged = AbortSignal.any([upstream.signal, client.signal]);

    upstream.abort(timeoutError);
    client.abort(clientError);

    expect(merged.reason).toBe(timeoutError);
    expect(merged.reason.code).toBe("UPSTREAM_CONNECT_TIMEOUT");
    expect(merged.reason.status).toBe(504);
    expect(merged.reason.retryable).toBe(true);
  });

  it("Case C: network reset (ECONNRESET) retries and throws network error (502 mapping)", async () => {
    const ex = makeExec({
      baseUrl: "https://x/api",
      retry: { 502: { attempts: 2, delayMs: 0 } }
    });

    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.message).toContain("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Case D: stream stall watchdog after 200 SSE produces terminal failure, not 499", async () => {
    const { pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");
    const { buildAbortedResponsesTerminalBytes } = await import("../../open-sse/utils/responsesStreamHelpers.js");

    let status = 200;
    const controller = new AbortController();
    const upstream = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.signal.addEventListener("abort", () => streamController.error(new Error("aborted")), { once: true });
      },
    });
    const streamController = {
      signal: controller.signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: () => {},
      handleError: (error) => { if (error.message === "stream stall timeout") controller.abort(); },
      handleDisconnect: () => {},
      abort: () => controller.abort(),
    };

    const out = pipeWithDisconnect(
      { body: upstream },
      new TransformStream(),
      streamController,
      (message) => buildAbortedResponsesTerminalBytes({ model: "gpt-5.6-luna", message }),
      20
    );

    const reader = out.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    // Must be valid terminal event response.failed and [DONE], not HTTP 499 abort
    expect(status).toBe(200);
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"type":"response.failed"');
    expect(text).toContain("stream stall timeout");
    expect(text).toContain("data: [DONE]");
  });
});
