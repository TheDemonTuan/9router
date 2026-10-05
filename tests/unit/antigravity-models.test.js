import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeAntigravityCatalog,
  isAntigravityModelAvailable,
  parseAntigravityManifestVersion,
  resolveAntigravityDiscoveryProfile,
  clearAntigravityDiscoveryProfileCache,
  resolveAntigravityModels,
  clearAntigravityModelCache,
} from "../../open-sse/services/antigravityModels.js";
import {
  ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION,
  ANTIGRAVITY_VERSION_CACHE_TTL_MS,
  ANTIGRAVITY_VERSION_RETRY_MS,
  ANTIGRAVITY_MODEL_CACHE_TTL_MS,
} from "../../open-sse/config/antigravityModels.js";

const mockFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

describe("parseAntigravityManifestVersion", () => {
  it("parses valid semver versions in various YAML shapes", () => {
    expect(parseAntigravityManifestVersion("version: 2.19.1")).toBe("2.19.1");
    expect(parseAntigravityManifestVersion("  version: \"2.20.0\" # comment")).toBe("2.20.0");
    expect(parseAntigravityManifestVersion("version: '2.18.5'")).toBe("2.18.5");
    expect(parseAntigravityManifestVersion("name: test\nversion: 2.19.2\nurl: http://example.com")).toBe("2.19.2");
  });

  it("returns null for non-semver, comments, missing or malformed inputs", () => {
    expect(parseAntigravityManifestVersion("version: beta")).toBeNull();
    expect(parseAntigravityManifestVersion("version: 2.19.1-alpha")).toBeNull();
    expect(parseAntigravityManifestVersion("# version: 2.19.1")).toBeNull();
    expect(parseAntigravityManifestVersion("name: test\n")).toBeNull();
    expect(parseAntigravityManifestVersion("")).toBeNull();
    expect(parseAntigravityManifestVersion(null)).toBeNull();
    expect(parseAntigravityManifestVersion(undefined)).toBeNull();
  });
});

describe("resolveAntigravityDiscoveryProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAntigravityDiscoveryProfileCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns parsed version from manifest when fetch succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "version: 2.22.0\n",
    });

    const profile = await resolveAntigravityDiscoveryProfile();
    expect(profile.version).toBe("2.22.0");
    expect(profile.userAgent).toBe("antigravity/hub/2.22.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)");
  });

  it("returns fallback version when manifest fetch fails or is non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const profile = await resolveAntigravityDiscoveryProfile();
    expect(profile.version).toBe(ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
    expect(profile.userAgent).toContain(ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION);
  });

  it("manifest failure retains last known valid version and enters 10-minute cooldown", async () => {
    // 1. Success at t0
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "version: 2.25.0\n",
    });
    const profile1 = await resolveAntigravityDiscoveryProfile();
    expect(profile1.version).toBe("2.25.0");

    // Advance clock past 1-hour TTL
    vi.advanceTimersByTime(ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1000);

    // 2. Fetch fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });
    const profile2 = await resolveAntigravityDiscoveryProfile();
    // Must NOT downgrade last-known valid version
    expect(profile2.version).toBe("2.25.0");

    // 3. Within 10-minute retry cooldown, does not fetch again
    mockFetch.mockClear();
    vi.advanceTimersByTime(ANTIGRAVITY_VERSION_RETRY_MS / 2);
    const profile3 = await resolveAntigravityDiscoveryProfile();
    expect(profile3.version).toBe("2.25.0");
    expect(mockFetch).not.toHaveBeenCalled();

    // 4. forceRefresh: true bypasses cooldown
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "version: 2.26.0\n",
    });
    const profile4 = await resolveAntigravityDiscoveryProfile({ forceRefresh: true });
    expect(profile4.version).toBe("2.26.0");
  });

  it("coalesces concurrent calls into a single in-flight manifest fetch", async () => {
    let resolveHttp;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHttp = resolve;
    }));

    const p1 = resolveAntigravityDiscoveryProfile();
    const p2 = resolveAntigravityDiscoveryProfile();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveHttp({
      ok: true,
      status: 200,
      text: async () => "version: 2.30.0\n",
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.version).toBe("2.30.0");
    expect(res2.version).toBe("2.30.0");
  });

  it("cancellation of one caller does not abort underlying shared fetch for others", async () => {
    let resolveHttp;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHttp = resolve;
    }));

    const controller1 = new AbortController();
    const p1 = resolveAntigravityDiscoveryProfile({ signal: controller1.signal });
    const p2 = resolveAntigravityDiscoveryProfile(); // no abort

    controller1.abort(new Error("caller 1 aborted"));

    await expect(p1).rejects.toThrow("caller 1 aborted");

    // Caller 2 still succeeds when HTTP completes
    resolveHttp({
      ok: true,
      status: 200,
      text: async () => "version: 2.31.0\n",
    });

    const res2 = await p2;
    expect(res2.version).toBe("2.31.0");
  });
});

describe("normalizeAntigravityCatalog", () => {
  it("parses object-key catalog, excludes internal and non-chat models", () => {
    const payload = {
      models: {
        "claude-sonnet-5-5": {
          displayName: "Claude Sonnet 5.5",
          maxTokens: 200000,
          maxOutputTokens: 64000,
          supportsImages: true,
          supportsThinking: true,
        },
        "claude-opus-5-5-thinking": {
          displayName: "Claude Opus 5.5 (Thinking)",
          maxTokens: 200000,
          maxOutputTokens: 80000,
          supportsImages: false,
          supportsThinking: true,
        },
        "chat_20706": { displayName: "internal chat", isInternal: false },
        "tab_flash_lite_preview": { displayName: "internal tab" },
        "imagen-3.0-generate": { displayName: "Image Model" },
        "gemini-audio-preview": { displayName: "Audio Model" },
        "gemini-hidden": { displayName: "Internal Hidden", isInternal: true },
      },
    };

    const models = normalizeAntigravityCatalog(payload);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5-thinking"]);

    const sonnet = models.find((m) => m.id === "claude-sonnet-5-5");
    expect(sonnet.contextLength).toBe(200000);
    expect(sonnet.maxOutputTokens).toBe(64000);
    expect(sonnet.capabilities.vision).toBe(true);
    expect(sonnet.capabilities.reasoning).toBe(true);

    const opus = models.find((m) => m.id === "claude-opus-5-5-thinking");
    expect(opus.maxOutputTokens).toBe(64000); // capped at router limit
    expect(opus.capabilities.vision).toBe(false);
  });

  it("excludes imageGenerationModelIds even if ID lacks 'image' in name", () => {
    const payload = {
      models: {
        "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5" },
        "opaque-graphic-slot": { displayName: "Graphic Slot" },
      },
      imageGenerationModelIds: ["opaque-graphic-slot"],
    };

    const models = normalizeAntigravityCatalog(payload);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("claude-sonnet-5-5");
  });

  it("skips non-object or array model metadata and falls back name to model ID", () => {
    const payload = {
      models: {
        "valid-model": { displayName: "" },
        "array-meta": ["invalid", "shape"],
        "null-meta": null,
      },
    };

    const models = normalizeAntigravityCatalog(payload);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("valid-model");
    expect(models[0].name).toBe("valid-model");
  });

  it("handles successful empty models object", () => {
    const models = normalizeAntigravityCatalog({ models: {} });
    expect(models).toEqual([]);
  });

  it("throws on malformed shape (arrays, missing models map)", () => {
    expect(() => normalizeAntigravityCatalog({ models: [] })).toThrow();
    expect(() => normalizeAntigravityCatalog({})).toThrow();
    expect(() => normalizeAntigravityCatalog(null)).toThrow();
  });
});

describe("isAntigravityModelAvailable", () => {
  const models = [
    { id: "claude-sonnet-5-5" },
    { id: "claude-opus-5-5-thinking" },
    { id: "gemini-3.8-flash-high" },
    { id: "gemini-3.8-flash" },
  ];

  it("matches exact live ID and stripped level suffixes", () => {
    expect(isAntigravityModelAvailable(models, "claude-sonnet-5-5")).toBe(true);
    expect(isAntigravityModelAvailable(models, "claude-sonnet-5-5(high)")).toBe(true);
    expect(isAntigravityModelAvailable(models, "claude-opus-5-5-thinking(medium)")).toBe(true);
    expect(isAntigravityModelAvailable(models, "claude-sonnet-4-6")).toBe(false);
  });

  it("matches existing registered Gemini alias upstream mapping", () => {
    expect(isAntigravityModelAvailable(models, "gemini-3.8-flash-high")).toBe(true);
  });
});

describe("resolveAntigravityModels live & cache behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAntigravityModelCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards discovery profile User-Agent and X-Client-Version to Cloud Code endpoint", async () => {
    mockFetch.mockImplementation(async (url) => {
      if (url.includes("manifest")) {
        return {
          ok: true,
          status: 200,
          text: async () => "version: 2.19.1\n",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5" },
          },
        }),
      };
    });

    const connection = { id: "c1", accessToken: "token-abc" };
    const res = await resolveAntigravityModels(connection);

    expect(res.resolved).toBe(true);
    expect(res.clientVersion).toBe("2.19.1");
    expect(res.source).toBe("live");
    expect(res.models).toHaveLength(1);
    expect(res.models[0].id).toBe("claude-sonnet-5-5");

    const catalogCall = mockFetch.mock.calls.find(([url]) => url.includes(":fetchAvailableModels"));
    expect(catalogCall).toBeDefined();
    const [, catalogOptions] = catalogCall;
    expect(catalogOptions.headers["User-Agent"]).toContain("antigravity/hub/2.19.1");
    expect(catalogOptions.headers["X-Client-Version"]).toBe("2.19.1");
    expect(catalogOptions.headers["Authorization"]).toBe("Bearer token-abc");
    expect(catalogOptions.headers["X-Client-Name"]).toBe("antigravity");
  });

  it("version transition invalidates model cache and refetches", async () => {
    mockFetch.mockImplementation(async (url) => {
      if (url.includes("manifest")) {
        return {
          ok: true,
          status: 200,
          text: async () => "version: 2.19.1\n",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: { "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" } },
        }),
      };
    });

    const connection = { id: "c1", accessToken: "token-abc" };
    const res1 = await resolveAntigravityModels(connection);
    expect(res1.models[0].id).toBe("gemini-2.5-pro");

    // Cache hit within TTL
    const resCache = await resolveAntigravityModels(connection);
    expect(resCache.source).toBe("cache");
    expect(resCache.cached).toBe(true);

    // Version changes in manifest
    mockFetch.mockImplementation(async (url) => {
      if (url.includes("manifest")) {
        return {
          ok: true,
          status: 200,
          text: async () => "version: 2.20.0\n",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
            "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5" },
          },
        }),
      };
    });

    // Advance clock past version cache TTL
    vi.advanceTimersByTime(ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1000);

    const res2 = await resolveAntigravityModels(connection);
    expect(res2.source).toBe("live");
    expect(res2.clientVersion).toBe("2.20.0");
    expect(res2.models.map((m) => m.id)).toContain("claude-sonnet-5-5");
  });

  it("promotes future unknown model without static registry entry after cache TTL", async () => {
    let returnFuture = false;
    mockFetch.mockImplementation(async (url) => {
      if (url.includes("manifest")) {
        return {
          ok: true,
          status: 200,
          text: async () => "version: 2.19.1\n",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
            ...(returnFuture ? {
              "claude-sonnet-99-1": {
                displayName: "Claude Sonnet 99.1",
                maxTokens: 500000,
                maxOutputTokens: 64000,
              },
            } : {}),
          },
        }),
      };
    });

    const connection = { id: "c1", accessToken: "token-abc" };
    const t0 = await resolveAntigravityModels(connection);
    expect(t0.models.map((m) => m.id)).toEqual(["gemini-2.5-pro"]);

    returnFuture = true;

    // Before model cache TTL, still cached
    const tBefore = await resolveAntigravityModels(connection);
    expect(tBefore.models.map((m) => m.id)).toEqual(["gemini-2.5-pro"]);

    // After model cache TTL, re-fetches and discovers claude-sonnet-99-1
    vi.advanceTimersByTime(ANTIGRAVITY_MODEL_CACHE_TTL_MS + 1000);
    const tAfter = await resolveAntigravityModels(connection);
    expect(tAfter.models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "claude-sonnet-99-1"]);
    const futureModel = tAfter.models.find((m) => m.id === "claude-sonnet-99-1");
    expect(futureModel.name).toBe("Claude Sonnet 99.1");
    expect(futureModel.contextLength).toBe(500000);
  });
});
