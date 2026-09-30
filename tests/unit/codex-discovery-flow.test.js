import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  connections: [],
  disabledModels: {},
  customModels: [],
  aliases: {},
  settings: { requireApiKey: false },
  handleChatCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mocks.proxyAwareFetch(...args),
}));

vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async (query) => {
    if (query?.provider && query.provider !== "codex") return [];
    if (query?.isActive !== undefined) return mocks.connections.filter((c) => c.isActive === query.isActive);
    return mocks.connections;
  }),
  getProviderConnectionById: vi.fn(async (id) => mocks.connections.find((c) => c.id === id) || null),
  getModelAliases: vi.fn(async () => mocks.aliases),
  getCustomModels: vi.fn(async () => mocks.customModels),
  getCombos: vi.fn(async () => []),
  setModelAlias: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async (query) => {
    if (query?.provider && query.provider !== "codex") return [];
    if (query?.isActive !== undefined) return mocks.connections.filter((c) => c.isActive === query.isActive);
    return mocks.connections;
  }),
  getCombos: vi.fn(async () => []),
  getSettings: vi.fn(async () => mocks.settings),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => mocks.disabledModels),
}));
vi.mock("@/lib/customModelsDb", () => ({
  getCustomModels: vi.fn(async () => mocks.customModels),
}));
vi.mock("@/lib/modelAliasesDb", () => ({
  getModelAliases: vi.fn(async () => mocks.aliases),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (provider, excludeIds = new Set()) => {
    const list = mocks.connections.filter((c) => c.provider === provider && !excludeIds.has(c.id));
    if (!list.length) return null;
    const item = list[0];
    return {
      connectionId: item.id,
      connectionName: item.name || item.id,
      accessToken: item.accessToken || item.apiKey || "mock-token",
      apiKey: item.apiKey,
      providerSpecificData: item.providerSpecificData || {},
    };
  }),
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(() => true),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  maskKey: vi.fn((k) => k),
}));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
}));

import {
  CODEX_MODELS_URL,
  CODEX_OFFICIAL_MODELS_URL,
  clearCodexModelCache,
  resolveCodexModels,
  resolveEffectiveCodexCatalog,
} from "open-sse/services/codexModels.js";
import {
  CODEX_MODEL_CACHE_TTL_MS,
  CODEX_DISCOVERY_STATUS,
  CODEX_COMPATIBILITY_REASON,
  CODEX_DISCOVERY_SOURCE,
} from "open-sse/config/codexModels.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { GET as getModelsApi } from "@/app/api/models/route.js";
import { GET as getModelById } from "@/app/api/v1/models/[...model]/route.js";
import { GET as getModelInfo } from "@/app/api/v1/models/info/route.js";
import { handleChat } from "@/sse/handlers/chat.js";

const makeResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => headers[name] || headers[name.toLowerCase()] || null,
  },
  json: async () => body,
});

const syntheticModel = (id, options = {}) => ({
  slug: id,
  display_name: options.name || id.toUpperCase(),
  description: options.description || `Synthetic model ${id}`,
  context_window: options.contextLength || 256000,
  max_context_window: options.maxContextLength || 512000,
  max_output_tokens: options.maxOutputTokens || 64000,
  supported_reasoning_levels: options.reasoningLevels || [{ effort: "low" }, { effort: "ultra" }],
  default_reasoning_level: options.defaultReasoningLevel || "low",
  input_modalities: options.inputModalities || ["text", "image"],
  visibility: options.visibility || "list",
  supported_in_api: options.supportedInApi !== undefined ? options.supportedInApi : true,
  minimal_client_version: options.minimalClientVersion || "0.153.0",
});

describe("Codex discovery flow & regression matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCodexModelCache();
    mocks.connections = [];
    mocks.disabledModels = {};
    mocks.customModels = [];
    mocks.aliases = {};
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: new Response("ok", { status: 200 }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Live [existing], official [existing, M, future(version 9.0.0), hidden, api-disabled]
  it("classifies candidate sources and excludes hidden/disabled/unverified models from regular models", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return makeResponse({ models: [syntheticModel("existing-live")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [
            syntheticModel("existing-live"),
            syntheticModel("gpt-discovery-next"),
            syntheticModel("future-version", { minimalClientVersion: "9.0.0" }),
            syntheticModel("hidden-model", { visibility: "hide" }),
            syntheticModel("api-disabled", { supportedInApi: false }),
          ],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const result = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(result.source).toBe("live");
    expect(result.access).toBe("observed");
    expect(result.models.map((m) => m.id)).toContain("existing-live");
    expect(result.models.map((m) => m.id)).not.toContain("gpt-discovery-next");
    expect(result.models.map((m) => m.id)).not.toContain("future-version");

    const candidateIds = result.candidateModels.map((m) => m.id);
    expect(candidateIds).toContain("gpt-discovery-next");
    expect(candidateIds).toContain("future-version");
    expect(candidateIds).toContain("api-disabled");
    expect(candidateIds).not.toContain("hidden-model");

    const mCandidate = result.candidateModels.find((m) => m.id === "gpt-discovery-next");
    expect(mCandidate).toMatchObject({
      id: "gpt-discovery-next",
      discoveryStatus: CODEX_DISCOVERY_STATUS.OFFICIAL_UNVERIFIED,
      compatibilityReason: CODEX_COMPATIBILITY_REASON.NOT_OBSERVED_IN_ACCOUNT_CATALOG,
      discoverySource: CODEX_DISCOVERY_SOURCE.OFFICIAL,
      stale: false,
    });

    const futureCandidate = result.candidateModels.find((m) => m.id === "future-version");
    expect(futureCandidate).toMatchObject({
      id: "future-version",
      discoveryStatus: CODEX_DISCOVERY_STATUS.OFFICIAL_UNVERIFIED,
      compatibilityReason: CODEX_COMPATIBILITY_REASON.NOT_OBSERVED_IN_ACCOUNT_CATALOG,
      discoverySource: CODEX_DISCOVERY_SOURCE.OFFICIAL,
      stale: false,
    });
  });

  // 2. Live 200 empty + official M -> M candidate, does NOT resurrect static chat models.
  it("keeps live 200 empty authoritative without resurrecting static chat models", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return makeResponse({ models: [] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [
            syntheticModel("gpt-discovery-next"),
            syntheticModel("future-v9", { minimalClientVersion: "9.0.0" }),
          ],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const result = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(result.access).toBe("observed");
    expect(result.source).toBe("live");
    // Models should not contain static LLMs like gpt-5.6-sol or gpt-6-sol
    const llmModels = result.models.filter((m) => m.kind === "llm");
    expect(llmModels).toHaveLength(0);

    const candidateIds = result.candidateModels.map((m) => m.id);
    expect(candidateIds).toContain("gpt-discovery-next");
    expect(candidateIds).toContain("future-v9");
  });

  // 3. Same process: before TTL candidate, after TTL +1ms live adds M -> M is promoted to models
  it("promotes candidate to model after TTL when live confirms it", async () => {
    let now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let liveObservedM = false;
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        const models = liveObservedM
          ? [syntheticModel("gpt-discovery-next"), syntheticModel("old-model")]
          : [syntheticModel("old-model")];
        return makeResponse({ models });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [syntheticModel("old-model"), syntheticModel("gpt-discovery-next")],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const initial = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(initial.models.map((m) => m.id)).not.toContain("gpt-discovery-next");
    expect(initial.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");

    // Before TTL, live fetch is cached
    now += CODEX_MODEL_CACHE_TTL_MS - 1000;
    vi.setSystemTime(now);
    liveObservedM = true; // Upstream has added M, but cache hasn't expired
    const beforeTtl = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(beforeTtl.models.map((m) => m.id)).not.toContain("gpt-discovery-next");

    // After TTL + 1ms, cache expires, live fetch runs and returns M
    now += 2000;
    vi.setSystemTime(now);
    const afterTtl = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(afterTtl.models.map((m) => m.id)).toContain("gpt-discovery-next");
    expect(afterTtl.candidateModels.map((m) => m.id)).not.toContain("gpt-discovery-next");

    // If live subsequently drops M, M demotes back to candidate
    now += CODEX_MODEL_CACHE_TTL_MS + 1000;
    vi.setSystemTime(now);
    liveObservedM = false;
    const afterRemoval = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(afterRemoval.models.map((m) => m.id)).not.toContain("gpt-discovery-next");
    expect(afterRemoval.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");
  });

  // 4. Live failure with usable LKG keeps stale; cold failure/no-token falls back to static + candidates
  it("handles LKG on live error and falls back to static + candidates on cold failure", async () => {
    let liveFail = false;
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        if (liveFail) return makeResponse({ error: "gateway error" }, 502);
        return makeResponse({ models: [syntheticModel("base-live")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [syntheticModel("base-live"), syntheticModel("gpt-discovery-next")],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    // Populate LKG
    const first = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" });
    expect(first.access).toBe("observed");
    expect(first.models.map((m) => m.id)).toContain("base-live");

    // Live fails, but LKG is usable
    liveFail = true;
    const staleResult = await resolveCodexModels({ id: "acc-1", accessToken: "token-1" }, { forceRefresh: true });
    expect(staleResult.access).toBe("stale");
    expect(staleResult.models.map((m) => m.id)).toContain("base-live");
    expect(staleResult.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");
    expect(staleResult.warning).toContain("Live Codex catalog unavailable (HTTP 502); using the last known catalog.");

    // Cold failure for an unknown account
    const cold = await resolveCodexModels({ id: "acc-cold", accessToken: "token-cold" }, { forceRefresh: true });
    expect(cold.source).toBe("static");
    expect(cold.access).toBe("unverified");
    expect(cold.models.map((m) => m.id)).toContain("gpt-6-sol");
    expect(cold.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");
    expect(cold.warning).toContain("Live Codex catalog unavailable (HTTP 502); using the static fallback.");
  });

  // 5. Official cache retry cooldown returns stale snapshot, resets on 304
  it("keeps stale official cache during retry cooldown and resets failure count on 304", async () => {
    let now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let officialStatus = 200;
    let officialEtag = "v1";
    let officialFetchCalls = 0;

    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return makeResponse({ models: [syntheticModel("m-live")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        officialFetchCalls += 1;
        if (officialStatus === 500) return makeResponse("error", 500);
        if (officialStatus === 304) {
          if (opts?.headers?.["If-None-Match"] === officialEtag) {
            return makeResponse(null, 304, { etag: officialEtag });
          }
          return makeResponse(null, 500);
        }
        return makeResponse(
          { models: [syntheticModel("m-live"), syntheticModel("gpt-discovery-next")] },
          200,
          { etag: officialEtag }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const init = await resolveCodexModels({ id: "acc-1", accessToken: "t-1" });
    expect(officialFetchCalls).toBe(1);
    expect(init.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");

    // Advance beyond official TTL (5 mins)
    now += CODEX_MODEL_CACHE_TTL_MS + 1000;
    vi.setSystemTime(now);
    officialStatus = 500; // Official fetch fails

    const afterFail = await resolveCodexModels({ id: "acc-1", accessToken: "t-1" }, { forceRefresh: true });
    expect(officialFetchCalls).toBe(2);
    // Should retain M candidate as stale official cache
    expect(afterFail.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");

    // In retry cooldown (10s later), official should not be called again, but stale cache is still returned
    now += 10_000;
    vi.setSystemTime(now);
    const duringCooldown = await resolveCodexModels({ id: "acc-1", accessToken: "t-1" });
    expect(officialFetchCalls).toBe(2); // No new network call
    expect(duringCooldown.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");

    // Now after cooldown (35s from failure), server revalidates with 304
    now += 30_000;
    vi.setSystemTime(now);
    officialStatus = 304;
    const revalidated = await resolveCodexModels({ id: "acc-1", accessToken: "t-1" });
    expect(officialFetchCalls).toBe(3);
    expect(revalidated.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");
  });

  // 6. Multi-account: Account A lacks M, Account B observes M -> effective has M once, candidate M disappears
  it("resolves multi-account effective catalog: confirms M from B and removes effective candidate", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const auth = opts?.headers?.Authorization || "";
      if (url.startsWith(CODEX_MODELS_URL)) {
        if (auth.includes("token-b")) {
          return makeResponse({ models: [syntheticModel("common"), syntheticModel("gpt-discovery-next")] });
        }
        return makeResponse({ models: [syntheticModel("common")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [syntheticModel("common"), syntheticModel("gpt-discovery-next")],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const connA = { id: "cx-a", accessToken: "token-a" };
    const connB = { id: "cx-b", accessToken: "token-b" };

    const effective = await resolveEffectiveCodexCatalog([connA, connB]);
    expect(effective.access).toBe("observed");
    expect(effective.models.map((m) => m.id)).toContain("gpt-discovery-next");
    expect(effective.candidateModels.map((m) => m.id)).not.toContain("gpt-discovery-next");

    // Single account A alone still considers M a candidate
    const singleA = await resolveCodexModels(connA);
    expect(singleA.models.map((m) => m.id)).not.toContain("gpt-discovery-next");
    expect(singleA.candidateModels.map((m) => m.id)).toContain("gpt-discovery-next");
  });

  // 7. Public API projections: candidates are never public, live promotion makes M visible
  it("verifies /v1/models, /api/models, and info endpoint never expose candidates and project promoted models", async () => {
    let observedInLive = false;
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        const models = observedInLive
          ? [syntheticModel("gpt-6-sol"), syntheticModel("gpt-discovery-next")]
          : [syntheticModel("gpt-6-sol")];
        return makeResponse({ models });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [syntheticModel("gpt-6-sol"), syntheticModel("gpt-discovery-next")],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    mocks.connections = [
      { id: "codex-1", provider: "codex", name: "Codex 1", accessToken: "token-1", isActive: true },
    ];

    // BEFORE promotion: M should not be in /v1/models
    const v1Before = await buildModelsList(["llm"]);
    expect(v1Before.map((m) => m.id)).not.toContain("cx/gpt-discovery-next");
    expect(v1Before.map((m) => m.id)).not.toContain("cx/gpt-discovery-next(ultra)");

    // Info endpoint returns 404 for unobserved M
    const infoReqBefore = new Request("http://localhost/v1/models/info?id=cx/gpt-discovery-next");
    const infoResBefore = await getModelInfo(infoReqBefore);
    expect(infoResBefore.status).toBe(404);

    // AFTER promotion: clear cache and observe M
    observedInLive = true;
    clearCodexModelCache();

    const v1After = await buildModelsList(["llm"]);
    const promotedBase = v1After.find((m) => m.id === "cx/gpt-discovery-next");
    const promotedUltra = v1After.find((m) => m.id === "cx/gpt-discovery-next(ultra)");
    expect(promotedBase).toBeDefined();
    expect(promotedUltra).toBeDefined();
    expect(promotedBase.supported_reasoning_levels).toEqual(["low", "ultra"]);
    expect(promotedBase.capabilities).toEqual({ tools: true });
    // Single model GET endpoint
    const singleReq = new Request("http://localhost/v1/models/cx/gpt-discovery-next");
    const singleRes = await getModelById(singleReq, { params: Promise.resolve({ model: ["cx", "gpt-discovery-next"] }) });
    expect(singleRes.status).toBe(200);
    const singleJson = await singleRes.json();
    expect(singleJson.id).toBe("cx/gpt-discovery-next");

    // Info endpoint
    const infoReqAfter = new Request("http://localhost/v1/models/info?id=cx/gpt-discovery-next");
    const infoResAfter = await getModelInfo(infoReqAfter);
    expect(infoResAfter.status).toBe(200);
    const infoJson = await infoResAfter.json();
    expect(infoJson.id).toBe("cx/gpt-discovery-next");
  });

  // 8. Chat dispatch routing: skips candidate-only account without cooldown, routes to observed account
  it("routes chat request to account observing M and skips candidate-only account without cooldown", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const auth = opts?.headers?.Authorization || "";
      if (url.startsWith(CODEX_MODELS_URL)) {
        if (auth.includes("token-b")) {
          return makeResponse({ models: [syntheticModel("gpt-discovery-next")] });
        }
        return makeResponse({ models: [syntheticModel("other-model")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [syntheticModel("other-model"), syntheticModel("gpt-discovery-next")],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    mocks.connections = [
      { id: "cx-a", provider: "codex", name: "A", accessToken: "token-a", isActive: true },
      { id: "cx-b", provider: "codex", name: "B", accessToken: "token-b", isActive: true },
    ];

    const chatRequest = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-discovery-next(ultra)",
        messages: [{ role: "user", content: "test" }],
      }),
    });

    const chatRes = await handleChat(chatRequest);
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("x-9router-connection-id")).toBe("cx-b");
    // markAccountUnavailable should NOT have been called for cx-a
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();

    // When NO account observes M: returns 404 Model Not Found without upstream execution
    mocks.connections = [
      { id: "cx-a", provider: "codex", name: "A", accessToken: "token-a", isActive: true },
    ];
    const failChatReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "cx/gpt-discovery-next(ultra)",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    const failChatRes = await handleChat(failChatReq);
    expect(failChatRes.status).toBe(404);
  });
  // 9. Multi-proxy isolation: two connections with distinct proxy configurations
  it("routes discovery through each connection's specific proxy and validates ChatGPT-Account-ID", async () => {
    clearCodexModelCache();
    mocks.proxyAwareFetch.mockImplementation(async (url, opts, proxyOptions) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        const auth = opts?.headers?.Authorization || "";
        const acct = opts?.headers?.["ChatGPT-Account-ID"];
        const proxyUrl = proxyOptions?.connectionProxyUrl;

        if (auth.includes("token-a") && acct === "acct-a" && proxyUrl === "http://proxy-a.test:8080") {
          return makeResponse({ models: [syntheticModel("gpt-6.1-sol")] });
        }
        if (auth.includes("token-b") && acct === "acct-b" && proxyUrl === "http://proxy-b.test:8080") {
          return makeResponse({ models: [syntheticModel("gpt-6-luna")] });
        }
        // Missing or cross-wired proxy/account -> reject with 403
        return makeResponse({ error: "forbidden" }, 403);
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({ models: [syntheticModel("gpt-6.1-sol"), syntheticModel("gpt-6-luna")] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    mocks.connections = [
      {
        id: "cx-proxy-a",
        provider: "codex",
        name: "Conn A",
        accessToken: "token-a",
        isActive: true,
        providerSpecificData: {
          chatgptAccountId: "acct-a",
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://proxy-a.test:8080",
        },
      },
      {
        id: "cx-proxy-b",
        provider: "codex",
        name: "Conn B",
        accessToken: "token-b",
        isActive: true,
        providerSpecificData: {
          chatgptAccountId: "acct-b",
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://proxy-b.test:8080",
        },
      },
    ];

    // Verify /api/models with cold cache
    clearCodexModelCache();
    const apiModelsRes = await getModelsApi();
    const apiModelsJson = await apiModelsRes.json();
    const apiCodexIds = apiModelsJson.models.filter((m) => m.provider === "cx").map((m) => m.model);
    expect(apiCodexIds).toContain("gpt-6.1-sol");
    expect(apiCodexIds).toContain("gpt-6-luna");

    // Verify /v1/models with cold cache
    clearCodexModelCache();
    const v1Models = await buildModelsList(["llm"]);
    const v1Ids = v1Models.map((m) => m.id);
    expect(v1Ids).toContain("cx/gpt-6.1-sol");
    expect(v1Ids).toContain("cx/gpt-6-luna");

    // Verify /v1/models/info with cold cache
    clearCodexModelCache();
    const infoReqA = new Request("http://localhost/v1/models/info?id=cx/gpt-6.1-sol");
    const infoResA = await getModelInfo(infoReqA);
    expect(infoResA.status).toBe(200);
    const infoJsonA = await infoResA.json();
    expect(infoJsonA.id).toBe("cx/gpt-6.1-sol");

    clearCodexModelCache();
    const infoReqB = new Request("http://localhost/v1/models/info?id=cx/gpt-6-luna");
    const infoResB = await getModelInfo(infoReqB);
    expect(infoResB.status).toBe(200);
    const infoJsonB = await infoResB.json();
    expect(infoJsonB.id).toBe("cx/gpt-6-luna");
  });
});
