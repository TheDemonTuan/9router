import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { fetchWithTimeout } = await import("../../open-sse/services/usage/shared.js");

describe("fetchWithTimeout response body signal", () => {
  it("keeps the upstream abort signal active until json resolves", async () => {
    const upstream = new AbortController();
    let requestSignal;
    let rejectBody;
    mocks.proxyAwareFetch.mockImplementation(async (_url, options) => {
      requestSignal = options.signal;
      return {
        json: () => new Promise((resolve, reject) => {
          rejectBody = reject;
          requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        }),
      };
    });

    const response = await fetchWithTimeout("https://smoke.invalid", { signal: upstream.signal }, 1_000);
    const bodyPromise = response.json();
    const reason = new Error("parent stopped");
    upstream.abort(reason);

    await expect(bodyPromise).rejects.toBe(reason);
    expect(requestSignal.aborted).toBe(true);
    expect(rejectBody).toBeDefined();
  });

  it("keeps the upstream abort signal active through body.getReader", async () => {
    const upstream = new AbortController();
    let requestSignal;
    let bodyController;
    mocks.proxyAwareFetch.mockImplementation(async (_url, options) => {
      requestSignal = options.signal;
      const body = new ReadableStream({ start(controller) {
        bodyController = controller;
        requestSignal.addEventListener("abort", () => controller.error(requestSignal.reason), { once: true });
      } });
      return new Response(body);
    });

    const response = await fetchWithTimeout("https://smoke.invalid", { signal: upstream.signal }, 1_000);
    const readPromise = response.body.getReader().read();
    const reason = new Error("reader stopped");
    upstream.abort(reason);

    await expect(readPromise).rejects.toBe(reason);
    expect(requestSignal.aborted).toBe(true);
    expect(bodyController).toBeDefined();
  });
});
