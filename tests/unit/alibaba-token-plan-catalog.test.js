// Catalog + discovery contract tests (offline; live /models fetch is mocked).
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

import { proxyAwareFetch as proxyAwareFetchMock } from "../../open-sse/utils/proxyFetch.js";

import {
  ALITP_MODELS,
  ALITP_CATALOG_VERSION,
  ALITP_CATALOG_SOURCE,
  ALITP_DEFAULT_EDITION,
  getAlitpFallbackCatalog,
  getAlitpCatalogEntry,
  resolveAlitpCatalogEntry,
  getAlitpUpstreamModelId,
  isAlitpModelDeprecated,
  isAlitpModelAvailableForEdition,
  sanitizeAlitpBaseOrigin,
  applyAlitpBaseOrigin,
} from "../../open-sse/providers/alibabaTokenPlanCatalog.js";
import {
  resolveEffectiveProviderModels,
  resolveAlitpLiveModels,
  clearAlitpCatalogCache,
  buildAlitpModelsUrl,
  getAlitpConnectionEdition,
  normalizeAlitpLiveModel,
} from "../../open-sse/services/alibabaTokenPlanModels.js";

const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => data,
});

beforeEach(() => {
  clearAlitpCatalogCache();
  proxyAwareFetchMock.mockReset();
});

describe("curated fallback catalog", () => {
  it("has a version and official source marker", () => {
    expect(ALITP_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ALITP_CATALOG_SOURCE).toBe("alibaba-official");
    expect(ALITP_DEFAULT_EDITION).toBe("personal");
  });

  it("personal edition lists exactly the 11 documented personal models, no deprecated", () => {
    const ids = getAlitpFallbackCatalog("personal").map((m) => m.id);
    expect(ids).toEqual([
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-flash",
      "deepseek-v4-pro",
      "deepseek-v4-pro-0813",
      "deepseek-v4-flash-0731",
      "deepseek-v4.1-flash",
      "glm-5.3",
      "glm-5.2",
    ]);
    expect(ids).not.toContain("qwen3.8-max-preview");
  });

  it("team edition adds exactly the 9 documented team-only models", () => {
    const personal = new Set(getAlitpFallbackCatalog("personal").map((m) => m.id));
    const team = getAlitpFallbackCatalog("team").map((m) => m.id);
    const extras = team.filter((id) => !personal.has(id));
    expect(extras.sort()).toEqual([
      "MiniMax-M2.5",
      "deepseek-v3.2",
      "deepseek-v4-flash",
      "glm-5",
      "glm-5.1",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "qwen3.6-plus",
    ]);
  });

  it("unknown edition falls back to personal (legacy connection compatibility)", () => {
    expect(getAlitpFallbackCatalog(undefined).map((m) => m.id))
      .toEqual(getAlitpFallbackCatalog("personal").map((m) => m.id));
    expect(getAlitpConnectionEdition({})).toBe("personal");
    expect(getAlitpConnectionEdition({ providerSpecificData: { tokenPlanEdition: "team" } })).toBe("team");
  });

  it("declares supportedFormats per documented protocol availability", () => {
    expect(getAlitpCatalogEntry("deepseek-v3.2").formats).toEqual(["openai"]);
    expect(getAlitpCatalogEntry("kimi-k2.6").formats).toEqual(["openai"]);
    expect(getAlitpCatalogEntry("kimi-k2.7-code").formats).toEqual(["openai", "claude"]);
    expect(getAlitpCatalogEntry("MiniMax-M2.5").formats).toEqual(["openai", "claude"]);
    expect(getAlitpCatalogEntry("glm-5.1").formats).toEqual(["openai", "claude"]);
    expect(getAlitpCatalogEntry("qwen3.8-max").formats).toEqual(["openai", "openai-responses", "claude"]);
    expect(getAlitpCatalogEntry("glm-5.3").formats).toEqual(["openai", "openai-responses", "claude"]);
  });

  it("resolves the deprecated preview alias for routing but marks it deprecated", () => {
    expect(isAlitpModelDeprecated("qwen3.8-max-preview")).toBe(true);
    expect(getAlitpUpstreamModelId("qwen3.8-max-preview")).toBe("qwen3.8-max");
    expect(resolveAlitpCatalogEntry("qwen3.8-max-preview").id).toBe("qwen3.8-max");
    expect(getAlitpUpstreamModelId("qwen3.8-max")).toBe("qwen3.8-max");
  });

  it("gates team-only models by edition, never gates unknown/live models", () => {
    expect(isAlitpModelAvailableForEdition("kimi-k2.6", "personal")).toBe(false);
    expect(isAlitpModelAvailableForEdition("kimi-k2.6", "team")).toBe(true);
    expect(isAlitpModelAvailableForEdition("kimi-k2.6(high)", "personal")).toBe(false);
    expect(isAlitpModelAvailableForEdition("qwen3.8-max", "personal")).toBe(true);
    expect(isAlitpModelAvailableForEdition("qwen3.8-max", undefined)).toBe(true);
    expect(isAlitpModelAvailableForEdition("brand-new-model", "personal")).toBe(true);
    expect(isAlitpModelAvailableForEdition("alitp-intl/kimi-k2.5", "personal")).toBe(false);
  });

  it("every catalog model carries limits and vision metadata", () => {
    for (const m of ALITP_MODELS) {
      if (m.deprecated) continue;
      expect(m.contextWindow, `${m.id} contextWindow`).toBeGreaterThan(0);
      expect(m.maxOutput, `${m.id} maxOutput`).toBeGreaterThan(0);
      expect(typeof m.vision, `${m.id} vision`).toBe("boolean");
      expect(Array.isArray(m.formats), `${m.id} formats`).toBe(true);
    }
  });
});

describe("Team Base URL override validation", () => {
  it("accepts only https *.maas.aliyuncs.com origins", () => {
    expect(sanitizeAlitpBaseOrigin("https://token-plan.ap-southeast-1.maas.aliyuncs.com")).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    );
    expect(sanitizeAlitpBaseOrigin("https://custom.maas.aliyuncs.com/some/path")).toBe("https://custom.maas.aliyuncs.com");
    expect(sanitizeAlitpBaseOrigin("http://token-plan.ap-southeast-1.maas.aliyuncs.com")).toBeNull();
    expect(sanitizeAlitpBaseOrigin("https://evil.com")).toBeNull();
    expect(sanitizeAlitpBaseOrigin("https://maas.aliyuncs.com.evil.com")).toBeNull();
    expect(sanitizeAlitpBaseOrigin("not a url")).toBeNull();
    expect(sanitizeAlitpBaseOrigin("")).toBeNull();
    expect(sanitizeAlitpBaseOrigin(undefined)).toBeNull();
  });

  it("swaps origin but keeps transport paths", () => {
    const url = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages";
    expect(applyAlitpBaseOrigin(url, "https://team-x.maas.aliyuncs.com")).toBe(
      "https://team-x.maas.aliyuncs.com/apps/anthropic/v1/messages",
    );
    // Invalid override → URL unchanged (credentials never leave the official host).
    expect(applyAlitpBaseOrigin(url, "https://evil.com")).toBe(url);
  });

  it("builds the discovery URL from the effective origin", () => {
    expect(buildAlitpModelsUrl("https://token-plan.ap-southeast-1.maas.aliyuncs.com")).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    );
  });
});

describe("live discovery → cache → fallback flow", () => {
  const teamConn = {
    id: "conn-team",
    apiKey: "sk-test-team",
    providerSpecificData: { tokenPlanEdition: "team" },
  };
  const personalConn = { id: "conn-p", apiKey: "sk-test-p", providerSpecificData: {} };

  it("live success wins and merges curated metadata onto known ids", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({
      data: [
        { id: "qwen3.8-max" },
        { id: "brand-new-alibaba-model" },
      ],
    }));
    const result = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    expect(result.source).toBe("live");
    expect(result.warning).toBeNull();
    const known = result.models.find((m) => m.id === "qwen3.8-max");
    expect(known.capabilities.vision).toBe(true);
    expect(known.capabilities.contextWindow).toBe(1000000);
    const fresh = result.models.find((m) => m.id === "brand-new-alibaba-model");
    expect(fresh).toBeDefined();
    // Unknown live additions get no fabricated capabilities.
    expect(fresh.capabilities).toBeUndefined();
    expect(fresh.source).toBe("live");
    // Authorization header carries the key; it must never appear in the result.
    const authHeader = proxyAwareFetchMock.mock.calls[0][1].headers.Authorization;
    expect(authHeader).toBe("Bearer sk-test-p");
    expect(JSON.stringify(result)).not.toContain("sk-test-p");
  });

  it("caches live results for the TTL (second call does not refetch)", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "qwen3.8-max" }] }));
    const first = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    const second = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    expect(first.source).toBe("live");
    expect(second.source).toBe("cache");
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
  });

  it("403/404/405 negatively cache and fall back without breaking the connection", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    const result = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    expect(result.source).toBe("fallback");
    expect(result.models.length).toBe(11); // personal fallback catalog
    expect(result.warning).toContain("official");
    expect(result.warning).not.toContain("404");
    // Negative cached: no second network call.
    const again = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    expect(again.source).toBe("fallback");
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
  });

  it("expired cache + failing fetch degrades to last-known-good, not to static", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "qwen3.8-max" }, { id: "glm-5.2" }] }));
    await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 16 * 60 * 1000);
    try {
      proxyAwareFetchMock.mockRejectedValueOnce(new Error("socket hang up"));
      const result = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
      expect(result.source).toBe("cache");
      expect(result.models.map((m) => m.id)).toEqual(["qwen3.8-max", "glm-5.2"]);
      // The raw upstream failure detail never reaches the client payload.
      expect(JSON.stringify(result)).not.toContain("socket hang up");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("negative cache never overwrites last-known-good catalog", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "qwen3.8-max" }] }));
    await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 16 * 60 * 1000);
    try {
      proxyAwareFetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
      const result = await resolveEffectiveProviderModels("alitp-intl", personalConn, {});
      expect(result.source).toBe("cache");
      expect(result.models.map((m) => m.id)).toEqual(["qwen3.8-max"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("no credentials → curated edition fallback, no network at all", async () => {
    const result = await resolveEffectiveProviderModels("alitp-intl", { id: "x", providerSpecificData: { tokenPlanEdition: "team" } }, {});
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    expect(result.source).toBe("fallback");
    expect(result.models.map((m) => m.id)).toContain("kimi-k2.7-code");
  });

  it("forceRefresh bypasses the cache", async () => {
    proxyAwareFetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "qwen3.8-max" }] }));
    await resolveAlitpLiveModels(personalConn, {});
    await resolveAlitpLiveModels(personalConn, { forceRefresh: true });
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(2);
  });

  it("live deprecated entries are marked so discovery can hide them", () => {
    const normalized = normalizeAlitpLiveModel({ id: "qwen3.8-max-preview" });
    expect(normalized.deprecated).toBe(true);
    expect(normalized.upstreamModelId).toBe("qwen3.8-max");
  });

  it("non-alitp providers are untouched by the shared resolver", async () => {
    const result = await resolveEffectiveProviderModels("cursor", { id: "c" }, {});
    expect(result.models).toBeNull();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});

