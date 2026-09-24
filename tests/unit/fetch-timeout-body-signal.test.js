import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { fetchWithTimeout } = await import("../../open-sse/services/usage/shared.js");

afterEach(() => vi.useRealTimers());

describe("fetchWithTimeout response body signal", () => {
  it("keeps the upstream abort signal active until a real response body settles", async () => {
    const upstream = new AbortController();
    let requestSignal;
    let sourceCancel;
    mocks.proxyAwareFetch.mockImplementation(async (_url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream({
        pull() {},
        cancel(reason) { sourceCancel = reason; },
      }));
    });

    const response = await fetchWithTimeout("https://smoke.invalid", { signal: upstream.signal }, 1_000);
    const bodyPromise = response.json();
    const reason = new Error("parent stopped");
    upstream.abort(reason);

    await expect(bodyPromise).rejects.toBe(reason);
    expect(requestSignal.aborted).toBe(true);
    expect(sourceCancel).toBe(reason);
  });

  it("times out a stalled body and cancels its source at the full deadline", async () => {
    vi.useFakeTimers();
    let requestSignal;
    let sourceCancel;
    mocks.proxyAwareFetch.mockImplementation(async (_url, options) => {
      requestSignal = options.signal;
      return new Response(new ReadableStream({
        pull() {},
        cancel(reason) { sourceCancel = reason; },
      }));
    });
    const response = await fetchWithTimeout("https://smoke.invalid", {}, 10_000);
    const read = response.body.getReader().read();
    const readRejected = expect(read).rejects.toThrow("Timeout after 10000ms");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await readRejected;
    expect(requestSignal.aborted).toBe(true);
    expect(sourceCancel).toBeInstanceOf(Error);
  });

  it("clears the timeout after EOF", async () => {
    vi.useFakeTimers();
    mocks.proxyAwareFetch.mockResolvedValue(new Response("{}"));
    const response = await fetchWithTimeout("https://smoke.invalid", {}, 1_000);
    await expect(response.json()).resolves.toEqual({});
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it("rejects immediately without calling fetch when external signal is already aborted", async () => {
    const upstream = new AbortController();
    const reason = new Error("already aborted");
    upstream.abort(reason);

    mocks.proxyAwareFetch.mockClear();
    await expect(fetchWithTimeout("https://smoke.invalid", { signal: upstream.signal }, 1_000))
      .rejects.toBe(reason);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
