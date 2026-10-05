import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_MODELS_URL,
  clearCodexModelCache,
  codexCatalogSupportsRequest,
  getCodexRequestRequirements,
  isCodexFallbackModel,
  projectCodexModels,
  resolveCodexModels,
  resolveEffectiveCodexCatalog,
} from "../../open-sse/services/codexModels.js";
import codex from "../../open-sse/providers/registry/codex.js";

const response = (models, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ models }),
});
const base = (maximum) => ({
  slug: "gpt-6-sol", display_name: "Fixture Sol", context_window: 272000,
  ...(maximum !== undefined ? { max_context_window: maximum } : {}),
  max_output_tokens: 64000, supported_reasoning_levels: ["low", "high"],
  default_reasoning_level: "low", input_modalities: ["text"], web_search_tool_type: null,
});
const connection = (id) => ({ id, accessToken: `fixture-token-${id}` });
const fetchAccounts = (accounts, official = [base(1000000)]) => vi.fn(async (url, options) =>
  url.startsWith(CODEX_MODELS_URL)
    ? response(accounts[options.headers.Authorization.replace("Bearer fixture-token-", "")])
    : response(official));

beforeEach(() => clearCodexModelCache());

describe("account-authoritative Codex extended context", () => {
  it("keeps new static candidates but admits removed ghost IDs only when observed", async () => {
    expect(codex.models.map(model => model.id)).toEqual(expect.arrayContaining([
      "gpt-6.1-sol", "gpt-daybreak-blue-latest", "gpt-reserve",
    ]));
    for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.4-image"]) {
      expect(codex.models.some(model => model.id === id)).toBe(false);
      expect(isCodexFallbackModel(id)).toBe(false);
    }
    const result = await resolveCodexModels(connection("a"), {
      fetchImpl: fetchAccounts({ a: [{ ...base(272000), slug: "gpt-5.4" }] }),
    });
    expect(result.access).toBe("observed");
    expect(codexCatalogSupportsRequest(result.models, "gpt-5.4").supported).toBe(true);
  });

  it("advertises extended context only for the account whose live maximum permits it", async () => {
    const fetchImpl = fetchAccounts({ a: [base(272000)], b: [base(1000000)] });
    const catalog = await resolveEffectiveCodexCatalog([connection("a"), connection("b")], { fetchImpl });
    const a = catalog.accountCatalogs.find(entry => entry.connectionId === "a");
    const b = catalog.accountCatalogs.find(entry => entry.connectionId === "b");
    expect(a.models.map(model => model.id)).not.toContain("gpt-6-sol[1m]");
    expect(b.models.find(model => model.id === "gpt-6-sol[1m]")).toMatchObject({
      upstreamModelId: "gpt-6-sol", contextLength: 872000, maxContextLength: 1000000,
      supportedReasoningLevels: ["low", "high"], defaultReasoningLevel: "low",
      maxOutputTokens: 64000, capabilities: { contextWindow: 872000, vision: false, search: false },
    });
    expect(catalog.models.find(model => model.id === "gpt-6-sol").contextLength).toBe(272000);
    expect(projectCodexModels(catalog.models).filter(model => model.id === "cx/gpt-6-sol[1m]")).toHaveLength(1);
    expect(projectCodexModels(catalog.models).find(model => model.id === "cx/gpt-6-sol[1m]").context_length).toBe(872000);
    expect(projectCodexModels(catalog.models).find(model => model.id === "cx/gpt-6-sol[1m](high)").reasoning_effort).toBe("high");
    expect(projectCodexModels(catalog.models).find(model => model.id === "cx/gpt-6-sol[1m](high)").base_model).toBe("cx/gpt-6-sol[1m]");
    expect(codexCatalogSupportsRequest(a.models, "gpt-6-sol[1m](high)")).toMatchObject({ supported: false, reason: "context" });
    expect(codexCatalogSupportsRequest(b.models, "gpt-6-sol[1m](high)")).toMatchObject({
      supported: true, contextMarker: "1m", requestedEffort: "high", metadata: { contextLength: 872000 },
    });
    expect(codexCatalogSupportsRequest(b.models, "gpt-6-sol[1m](ultra)")).toMatchObject({ supported: false, reason: "effort" });
  });

  it.each([undefined, 871999, 0])("does not inherit larger maxima from official or static metadata: %s", async maximum => {
    const result = await resolveCodexModels(connection("a"), { fetchImpl: fetchAccounts({ a: [base(maximum)] }) });
    expect(result.access).toBe("observed");
    expect(result.models.map(model => model.id)).not.toContain("gpt-6-sol[1m]");
    expect(codexCatalogSupportsRequest(result.models, "gpt-6-sol[1m]")).toMatchObject({ supported: false, reason: "context" });
    expect(codexCatalogSupportsRequest(result.models, "gpt-6-sol").supported).toBe(true);
  });

  it("accepts the exact threshold and preserves account evidence through the cache", async () => {
    const fetchImpl = fetchAccounts({ a: [base(872000)] });
    await resolveCodexModels(connection("a"), { fetchImpl });
    const result = await resolveCodexModels(connection("a"), { fetchImpl });
    expect(result.source).toBe("cache");
    expect(result.models.find(model => model.id === "gpt-6-sol[1m]").contextLength).toBe(872000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not advertise marker aliases in an unverified fallback or empty account catalog", async () => {
    const fallback = await resolveCodexModels({}, { fetchImpl: async () => response([], 500) });
    expect(fallback.access).toBe("unverified");
    expect(fallback.models.some(model => model.id.includes("[1m]"))).toBe(false);
    expect(codexCatalogSupportsRequest(fallback.models, "gpt-6-sol[1m]")).toMatchObject({ supported: false, reason: "context" });
    expect(isCodexFallbackModel("gpt-6-sol[1m](high)")).toBe(false);
    expect(isCodexFallbackModel("gpt-6-sol")).toBe(true);
    clearCodexModelCache();
    const empty = await resolveCodexModels(connection("empty"), { fetchImpl: fetchAccounts({ empty: [] }) });
    expect(empty.access).toBe("observed");
    expect(empty.models.some(model => model.id.includes("[1m]"))).toBe(false);
    expect(codexCatalogSupportsRequest(empty.models, "gpt-6-sol[1m]").supported).toBe(false);
  });

  it("keeps marker and effort independent in either client suffix order", () => {
    for (const model of ["gpt-6-sol[1m](high)", "gpt-6-sol(high)[1M]"]) {
      expect(getCodexRequestRequirements(model)).toEqual({
        baseModel: "gpt-6-sol", contextMarker: "1m", requestedEffort: "high", conflictingEfforts: false,
      });
    }
    expect(codexCatalogSupportsRequest([{ id: "gpt-6-sol[1m]", maxContextLength: 1000000 }], "gpt-6-sol[1m]")).toMatchObject({
      supported: false, reason: "model",
    });
  });
});
