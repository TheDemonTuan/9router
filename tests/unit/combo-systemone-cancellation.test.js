import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceKeyAccess } from "../../src/sse/services/keyAccess.js";
import { createPreResponseBudget } from "../../open-sse/utils/preResponseBudget.js";

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "opencode", model: "jev-test" })),
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ apiKey: "test-key" })),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("../../open-sse/providers/index.js", () => ({
  PROVIDER_MEDIA: { opencode: { systemoneConfig: { baseUrl: "https://router.example/v1/systemone" } } },
}));
vi.mock("../../open-sse/config/providerModels.js", () => ({
  getModelUpstreamId: (_provider, model) => model,
}));
vi.mock("../../open-sse/executors/opencode-zen.js", () => ({
  generateSessionId: () => "router-test-session",
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  enforceKeyAccess: vi.fn(async () => null),
  extractClientApiKey: (request) => request?.headers?.get("x-api-key") || null,
}));

import { resolveSmartChoice, getSmartComboSessionId } from "../../src/sse/services/systemoneRouter.js";

const options = {
  body: { messages: [{ role: "user", content: "Choose a model" }] },
  models: ["openai/first", "openai/second"],
};

function capturePendingFetch() {
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const fetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    resolveStarted(signal);
    if (signal.aborted) reject(signal.reason);
  }));
  vi.stubGlobal("fetch", fetch);
  return { started, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(enforceKeyAccess).mockReset().mockResolvedValue(null);
});

describe("smart-router cancellation", () => {
  it("scopes explicit session hints to the caller key, never matching prompts", () => {
    const request = (key) => new Request("https://gateway.example", { headers: { "x-api-key": key } });
    const body = { session_id: "explicit-thread" };
    const first = getSmartComboSessionId(request("key-one"), {}, body);
    expect(first).toBe(getSmartComboSessionId(request("key-one"), {}, body));
    expect(first).not.toBe(getSmartComboSessionId(request("key-two"), {}, body));
    expect(first).not.toContain("key-one");
    expect(getSmartComboSessionId(new Request("https://gateway.example"), {}, body)).toBeNull();
    const inferred = {
      prompt_cache_key: "same-prompt", metadata: { user_id: "same-user" },
      messages: [{ role: "assistant", content: "Same assistant output repeated across independent clients." }],
    };
    expect(getSmartComboSessionId(request("key-one"), {}, inferred)).toBeNull();
  });

  it("does not touch credentials or transport for a forbidden router model", async () => {
    vi.mocked(enforceKeyAccess).mockResolvedValueOnce(new Response(null, { status: 403 }));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await resolveSmartChoice({ ...options, keyAccess: { keyId: "restricted" } })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts its underlying request on classification timeout and retains fallback", async () => {
    vi.useFakeTimers();
    const { started, fetch } = capturePendingFetch();
    const result = resolveSmartChoice({ ...options, timeoutMs: 20 });
    const signal = await started;
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates external cancellation without dispatching generation", async () => {
    const client = new AbortController();
    const preResponse = createPreResponseBudget({ clientSignal: client.signal, budgetMs: 10_000 });
    const { started, fetch } = capturePendingFetch();
    try {
      const result = resolveSmartChoice({ ...options, preResponse });
      const signal = await started;
      const rejected = expect(result).rejects.toMatchObject({ code: "CLIENT_ABORT" });
      client.abort();
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      preResponse.dispose();
    }
  });
});
