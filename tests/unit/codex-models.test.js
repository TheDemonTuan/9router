import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CLIENT_VERSION,
} from "../../open-sse/config/codexClient.js";
import {
  CODEX_OFFICIAL_MODELS_URL,
  CODEX_MODELS_URL,
  clearCodexModelCache,
  getCodexCacheKey,
  normalizeCodexCatalog,
  normalizeCodexModel,
  mergeCodexModelLists,
  projectCodexModel,
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

describe("normalizeCodexCatalog", () => {
  it("accepts reasoning objects and preserves supported_in_api=false and future minimal versions", () => {
    const models = normalizeCodexCatalog({
      models: [
        liveModel("gpt-6-sol", [{ effort: "low" }, { effort: "ultra" }]),
        { ...liveModel("gpt-6-luna"), visibility: "hide" },
        { ...liveModel("gpt-none"), visibility: "none" },
        { ...liveModel("disabled"), supported_in_api: false },
        { ...liveModel("future"), minimal_client_version: "9.0.0" },
        { ...liveModel("missing-visibility"), visibility: undefined },
      ],
    });

    const ids = models.map((m) => m.id);
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("disabled");
    expect(ids).toContain("future");
    expect(ids).toContain("missing-visibility");
    expect(ids).not.toContain("gpt-6-luna");
    expect(ids).not.toContain("gpt-none");

    const sol = models.find((m) => m.id === "gpt-6-sol");
    expect(sol).toMatchObject({
      id: "gpt-6-sol",
      name: "GPT-6-SOL",
      contextLength: 272000,
      maxContextLength: 872000,
      supportedReasoningLevels: ["low", "ultra"],
      capabilities: { reasoning: true, vision: true },
    });
    const future = models.find((m) => m.id === "future");
    expect(future.minimalClientVersion).toBe("9.0.0");
  });

  it("throws on invalid catalog shapes and returns empty array on empty models", () => {
    expect(() => normalizeCodexCatalog(null)).toThrow("Codex model catalog has an invalid shape");
    expect(() => normalizeCodexCatalog("not-an-object")).toThrow("Codex model catalog has an invalid shape");
    expect(normalizeCodexCatalog({ models: [] })).toEqual([]);
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
  it("starts live and official fetches before either body finishes", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const fetchImpl = vi.fn(async url => {
      calls.push(url);
      if (url.startsWith(CODEX_MODELS_URL)) return { ...response(null), json: () => gate };
      return response({ models: [] });
    });
    const pending = resolveCodexModels({ id: "parallel", accessToken: "fake" }, { fetchImpl });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toContain(CODEX_OFFICIAL_MODELS_URL);
    release({ models: [liveModel("gpt-6-sol")] });
    expect((await pending).source).toBe("live");
  });

  it("bounds a stalled JSON body after headers", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const fetchImpl = vi.fn(async url => url === CODEX_OFFICIAL_MODELS_URL
        ? { ...response(null), json: () => new Promise(() => {}), body: { cancel } }
        : response({ models: [liveModel("gpt-6-sol")] }));
      const pending = resolveCodexModels({ id: "stalled-body", accessToken: "fake" }, { fetchImpl });
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).models.map(model => model.id)).toContain("gpt-6-sol");
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start either catalog request after pre-abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const fetchImpl = vi.fn();
    const result = await resolveCodexModels({ id: "pre-aborted", accessToken: "fake" }, { fetchImpl, signal: controller.signal });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("static");
  });

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
    expect(calls[0].url).toContain(`client_version=${CODEX_CLIENT_VERSION}`);
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
      if (url.startsWith(CODEX_MODELS_URL) && options.headers.Authorization === "Bearer old-token") return response({}, 401);
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
    expect(calls.find(call => call.options.headers.Authorization === "Bearer new-token")?.url).toContain(CODEX_MODELS_URL);
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
    expect(ids).not.toContain("gpt-6-sol-review");
    expect(ids).not.toContain("gpt-6-luna-review");
    expect(ids).not.toContain("gpt-6-astra-review");
    expect(ids).not.toContain("gpt-5.6-sol-review");
    expect(ids).not.toContain("gpt-5.6-terra-review");
    expect(ids).not.toContain("gpt-5.6-luna-review");
    expect(ids).not.toContain("gpt-5.5-review");
    expect(ids).not.toContain("gpt-5.4-review");
    expect(ids).not.toContain("gpt-5.4-mini-review");
    expect(ids).not.toContain("gpt-5.3-codex-spark-review");
    expect(result.models.find((model) => model.id === "gpt-6-sol").supportedReasoningLevels).toContain("ultra");
  });

  it("keeps official-only models as candidates when live catalog does not observe them", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return response({ models: [liveModel("existing-model")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return response({
          models: [
            liveModel("existing-model"),
            liveModel("gpt-discovery-next"),
          ],
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const result = await resolveCodexModels({ id: "acc-1", accessToken: "fake-token" }, { fetchImpl });
    expect(result.models.map((m) => m.id)).not.toContain("gpt-discovery-next");
    const candidateIds = (result.candidateModels || []).map((m) => m.id);
    expect(candidateIds).toContain("gpt-discovery-next");
  });
  it("promotes live gpt-6.1-sol, supported_in_api=false, and minimal=9.0.0 without demoting from official metadata", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        return response({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1-Sol",
              context_window: 256000,
              max_context_window: 512000,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
              default_reasoning_level: "low",
              input_modalities: ["text", "image"],
              visibility: "list",
              supported_in_api: true,
              minimal_client_version: "0.153.0",
            },
            {
              slug: "synthetic-disabled-future",
              display_name: "Synthetic Disabled Future",
              visibility: "list",
              supported_in_api: false,
              minimal_client_version: "9.0.0",
            },
            {
              slug: "live-without-min",
              display_name: "Live Without Min",
              visibility: "list",
            },
          ],
        });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return response({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1-Sol Official",
              minimal_client_version: "0.153.0",
            },
            {
              slug: "live-without-min",
              minimal_client_version: "9.0.0",
            },
          ],
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const result = await resolveCodexModels({ id: "acc-sol", accessToken: "token-sol" }, { fetchImpl });
    expect(result.access).toBe("observed");
    expect(result.clientVersion).toBe(CODEX_CLIENT_VERSION);

    const modelIds = result.models.map((m) => m.id);
    expect(modelIds).toContain("gpt-6.1-sol");
    expect(modelIds).toContain("synthetic-disabled-future");
    expect(modelIds).toContain("live-without-min");

    const candidateIds = (result.candidateModels || []).map((m) => m.id);
    expect(candidateIds).not.toContain("gpt-6.1-sol");
    expect(candidateIds).not.toContain("synthetic-disabled-future");
    expect(candidateIds).not.toContain("live-without-min");
  });

  it("handles cold/warm HTTP 403 with exact warning format and resets warning on recovery", async () => {
    let httpStatus = 403;
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        if (httpStatus >= 400) return response({ error: "forbidden" }, httpStatus);
        return response({ models: [liveModel("recovered-model")] });
      }
      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return response({ models: [liveModel("official-only-model")] });
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    // Cold 403
    const cold = await resolveCodexModels({ id: "acc-cold", accessToken: "token" }, { fetchImpl });
    expect(cold.source).toBe("static");
    expect(cold.access).toBe("unverified");
    expect(cold.warning).toContain("Live Codex catalog unavailable (HTTP 403); using the static fallback.");
    expect(cold.clientVersion).toBe(CODEX_CLIENT_VERSION);
    expect(cold.candidateModels.map((m) => m.id)).toContain("official-only-model");

    // Recover to populate cache / LKG
    httpStatus = 200;
    const recovered = await resolveCodexModels({ id: "acc-cold", accessToken: "token" }, { fetchImpl, forceRefresh: true });
    expect(recovered.access).toBe("observed");
    expect(recovered.warning).toBeNull();
    expect(recovered.models.map((m) => m.id)).toContain("recovered-model");

    // Warm 403 -> uses LKG stale with HTTP 403 warning
    httpStatus = 403;
    const warm = await resolveCodexModels({ id: "acc-cold", accessToken: "token" }, { fetchImpl, forceRefresh: true });
    expect(warm.access).toBe("stale");
    expect(warm.models.map((m) => m.id)).toContain("recovered-model");
    expect(warm.warning).toContain("Live Codex catalog unavailable (HTTP 403); using the last known catalog.");
  });

  it("sanitizes network or malformed errors without leaking sentinels", async () => {
    const SECRET_SENTINEL = "SUPER_SECRET_TOKEN_VALUE_XYZ";
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        throw new Error(`Network failure with ${SECRET_SENTINEL}`);
      }
      return response({ models: [] });
    });

    const result = await resolveCodexModels({ id: "acc-sec", accessToken: "token" }, { fetchImpl });
    expect(result.warning).toContain("Live Codex catalog unavailable (network or invalid response);");
    expect(result.warning).not.toContain(SECRET_SENTINEL);
  });
});

describe("projectCodexModel public contract", () => {
  it("projects an allowlisted base model and a metadata-free reasoning variant", () => {
    const levels = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const model = {
      id: "generic-model",
      name: "Generic Model",
      contextLength: 272000,
      maxContextLength: 872000,
      maxOutputTokens: 128000,
      inputModalities: ["text", "image"],
      kind: "llm",
      outputModalities: ["text"],
      supportedReasoningLevels: levels,
      defaultReasoningLevel: "medium",
      publicCapabilityEvidence: { tools: true, search: true, structured_output: false },
      minimalClientVersion: "0.155.0",
      priority: 10,
      description: "Internal description",
      capabilities: {
        tools: true,
        search: true,
        reasoning: true,
        vision: true,
        contextWindow: 272000,
        maxOutput: 128000,
        thinkingFormat: "openai",
        structured_output: false,
        upstream_extra: true,
      },
    };
    const base = projectCodexModel(model, "cx");
    const variant = projectCodexModel(model, "cx", "ultra");

    expect(Object.keys(base)).toEqual([
      "id", "object", "owned_by", "name", "context_length", "max_completion_tokens",
      "input_modalities", "default_reasoning_level", "supported_reasoning_levels", "capabilities",
    ]);
    expect(base).toMatchObject({
      id: "cx/generic-model",
      input_modalities: ["text", "image"],
      capabilities: { search: true },
    });
    expect(Object.keys(variant)).toEqual([
      "id", "object", "owned_by", "base_model", "reasoning_effort", "virtual",
    ]);
    expect(variant).toEqual({
      id: "cx/generic-model(ultra)",
      object: "model",
      owned_by: "cx",
      base_model: "cx/generic-model",
      reasoning_effort: "ultra",
      virtual: true,
    });
  });
});
