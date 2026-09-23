import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLIENT_VERSION,
} from "../../open-sse/config/codexClient.js";
import {
  CODEX_OFFICIAL_MODELS_URL,
  CODEX_MODELS_URL,
  clearCodexModelCache,
  compareCodexVersions,
  getCodexCacheKey,
  normalizeCodexCatalog,
  normalizeCodexModel,
  mergeCodexModelLists,
  projectCodexModels,
  resolveCodexModels,
  resolveEffectiveCodexCatalog,
} from "../../open-sse/services/codexModels.js";

const response = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name] || headers[name.toLowerCase()] || null },
  json: async () => body,
});

const liveModel = (id, levels = [{ effort: "low" }, { effort: "medium" }]) => ({
  slug: id,
  display_name: id.toUpperCase(),
  description: `Description for ${id}`,
  context_window: 272000,
  max_context_window: 872000,
  supported_reasoning_levels: levels,
  default_reasoning_level: "low",
  input_modalities: ["text", "image"],
  visibility: "list",
  supported_in_api: true,
  minimal_client_version: "0.155.0",
});

beforeEach(() => {
  clearCodexModelCache();
});

describe("Codex client version", () => {
  it("uses one current version for model discovery", () => {
    expect(CODEX_CLIENT_VERSION).toBe("0.155.0");
    expect(compareCodexVersions("0.154.0", CODEX_CLIENT_VERSION)).toBeLessThan(0);
    expect(compareCodexVersions("0.155.0", CODEX_CLIENT_VERSION)).toBe(0);
    expect(compareCodexVersions("0.99.0", "0.155.0")).toBeLessThan(0);
  });
});

describe("normalizeCodexCatalog", () => {
  it("accepts reasoning objects and filters hidden, disabled, and incompatible entries", () => {
    const { models, candidateModels } = normalizeCodexCatalog({
      models: [
        liveModel("gpt-6-sol", [{ effort: "low" }, { effort: "ultra" }]),
        { ...liveModel("gpt-6-luna"), visibility: "hide" },
        { ...liveModel("disabled"), supported_in_api: false },
        { ...liveModel("future"), minimal_client_version: "9.0.0" },
      ],
    }, { includeCandidates: true });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gpt-6-sol",
      name: "GPT-6-SOL",
      contextLength: 272000,
      maxContextLength: 872000,
      supportedReasoningLevels: ["low", "ultra"],
      capabilities: { reasoning: true, vision: true },
    });
    expect(candidateModels.map((model) => model.id)).toEqual(["future"]);
  });
});

describe("Codex metadata boundaries", () => {
  it("keeps the advertised context window below the maximum window", () => {
    expect(normalizeCodexModel({
      slug: "bounded",
      context_window: 1000,
      max_context_window: 800,
    })).toMatchObject({
      contextLength: 800,
      maxContextLength: 800,
      capabilities: { contextWindow: 800 },
    });
  });

  it("uses the token hash when an account identity is unavailable", () => {
    expect(getCodexCacheKey({ id: "same", accessToken: "token-a" }))
      .not.toBe(getCodexCacheKey({ id: "same", accessToken: "token-b" }));
  });

  it("preserves explicit negative capability evidence", () => {
    expect(normalizeCodexModel({
      slug: "text-only",
      input_modalities: ["text"],
      supported_reasoning_levels: [],
      web_search_tool_type: null,
      supports_tools: false,
    })).toMatchObject({
      capabilities: { vision: false, reasoning: false, search: false, tools: false },
    });
  });
});

describe("effective Codex catalogs", () => {
  it("unions account reasoning levels while keeping conservative limits and variants", () => {
    const models = mergeCodexModelLists([
      [{ id: "gpt-6-sol", contextLength: 872000, maxOutputTokens: 128000, supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] }],
      [{ id: "gpt-6-sol", contextLength: 272000, maxOutputTokens: 64000, supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"] }],
      [{ id: "gpt-6-luna", supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"] }],
    ]);
    const sol = models.find((model) => model.id === "gpt-6-sol");
    expect(sol.supportedReasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(sol.contextLength).toBe(272000);
    expect(sol.maxOutputTokens).toBe(64000);
    expect(projectCodexModels(models).map((model) => model.id)).toEqual(expect.arrayContaining([
      "cx/gpt-6-sol", "cx/gpt-6-sol(ultra)", "cx/gpt-6-luna(max)",
    ]));
  });

  it("does not treat an official-only model as account access", async () => {
    const result = await resolveEffectiveCodexCatalog([], { fetchImpl: vi.fn() });
    expect(result.access).toBe("unavailable");
    expect(result.models).toEqual([]);
  });
});

describe("resolveCodexModels", () => {
  it("uses live data, enriches from the official catalog, and caches by connection", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith(CODEX_MODELS_URL)) return response({ models: [liveModel("gpt-6-sol", [{ effort: "low" }, { effort: "ultra" }])] }, 200, { etag: "live-v1" });
      return response({ models: [liveModel("gpt-6-sol", [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }])] }, 200, { etag: "official-v1" });
    });
    const connection = { id: "codex-a", accessToken: "token-a", providerSpecificData: { chatgptAccountId: "acct-a" } };

    const first = await resolveCodexModels(connection, { fetchImpl });
    const second = await resolveCodexModels(connection, { fetchImpl });

    expect(first.source).toBe("live");
    expect(first.access).toBe("observed");
    expect(first.models.find((model) => model.id === "gpt-6-sol")).toMatchObject({
      supportedReasoningLevels: ["low", "ultra"],
      contextLength: 272000,
    });
    expect(second.source).toBe("cache");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("client_version=0.155.0");
    expect(calls[0].options.headers.Authorization).toBe("Bearer token-a");
    expect(calls[0].options.headers["ChatGPT-Account-ID"]).toBe("acct-a");
  });

  it("revalidates live and official caches with independent ETags", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith(CODEX_MODELS_URL)) {
        return calls.filter((call) => call.url.startsWith(CODEX_MODELS_URL)).length === 1
          ? response({ models: [liveModel("gpt-6-sol")] }, 200, { etag: "live-v1" })
          : response({}, 304);
      }
      return calls.filter((call) => call.url === CODEX_OFFICIAL_MODELS_URL).length === 1
        ? response({ models: [liveModel("gpt-6-sol")] }, 200, { etag: "official-v1" })
        : response({}, 304);
    });
    const connection = { id: "codex-etag", accessToken: "token" };

    await resolveCodexModels(connection, { fetchImpl });
    const result = await resolveCodexModels(connection, { fetchImpl, forceRefresh: true });
    await resolveCodexModels(connection, { fetchImpl, forceRefresh: true });

    expect(result.models.map((model) => model.id)).toContain("gpt-6-sol");
    expect(calls[2].options.headers["If-None-Match"]).toBe("live-v1");
    expect(calls[3].options.headers["If-None-Match"]).toBe("official-v1");
    expect(calls[4].options.headers["If-None-Match"]).toBe("live-v1");
    expect(calls[5].options.headers["If-None-Match"]).toBe("official-v1");
  });

  it("keeps catalogs isolated between account identities", async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return response({ models: [liveModel(options.headers.Authorization.endsWith("a") ? "gpt-6-sol" : "gpt-6-luna")] });
      }
      return response({ models: [] });
    });
    const first = await resolveCodexModels({ id: "codex-a", accessToken: "a", providerSpecificData: { chatgptAccountId: "a" } }, { fetchImpl });
    const second = await resolveCodexModels({ id: "codex-b", accessToken: "b", providerSpecificData: { chatgptAccountId: "b" } }, { fetchImpl });

    expect(first.models.map((model) => model.id)).toContain("gpt-6-sol");
    expect(second.models.map((model) => model.id)).toContain("gpt-6-luna");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refreshes once after 401 and retries with the new token", async () => {
    const calls = [];
    const refreshed = [];
    const fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response({}, 401);
      if (url.startsWith(CODEX_MODELS_URL)) return response({ models: [liveModel("gpt-6-luna", [{ effort: "low" }, { effort: "max" }])] });
      return response({ models: [] });
    });
    const result = await resolveCodexModels({
      id: "codex-refresh",
      accessToken: "old-token",
      refreshToken: "refresh-token",
    }, {
      fetchImpl,
      refreshFn: async () => ({ accessToken: "new-token", refreshToken: "rotated-refresh" }),
      onCredentialsRefreshed: async (credentials) => refreshed.push(credentials),
    });

    expect(result.models.map((model) => model.id)).toContain("gpt-6-luna");
    expect(refreshed).toEqual([{ accessToken: "new-token", refreshToken: "rotated-refresh" }]);
    expect(calls[1].options.headers.Authorization).toBe("Bearer new-token");
    expect(calls).toHaveLength(3);
  });

  it("falls back to static metadata when live and official sources fail", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === CODEX_OFFICIAL_MODELS_URL || url.startsWith(CODEX_MODELS_URL)) throw new Error("offline");
      return response({}, 500);
    });
    const result = await resolveCodexModels({ id: "codex-offline", accessToken: "token" }, { fetchImpl });

    expect(result.source).toBe("static");
    const ids = result.models.map((model) => model.id);
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("codex-auto-review");
    expect(ids).not.toContain("gpt-5.6-sol-review");
    expect(ids).not.toContain("gpt-5.6-terra-review");
    expect(ids).not.toContain("gpt-5.6-luna-review");
    expect(ids).not.toContain("gpt-5.5-review");
    expect(ids).not.toContain("gpt-5.4-review");
    expect(ids).not.toContain("gpt-5.4-mini-review");
    expect(ids).not.toContain("gpt-5.3-codex-spark-review");
    expect(result.models.find((model) => model.id === "gpt-6-sol").supportedReasoningLevels).toContain("ultra");
  });
});
