import { afterEach, describe, expect, it } from "vitest";
import { getCapabilitiesForModel, setCatalogSource } from "../../open-sse/providers/capabilities.js";
import { getAdvertisedThinkingLevels, getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

afterEach(() => setCatalogSource(null));

describe("upstream capability union preserves provider authority", () => {
  const installCatalog = () => setCatalogSource({
    getModalities: () => ({ vision: true, videoInput: true }),
    getLimits: () => ({ contextWindow: 64000, maxOutput: 32000 }),
  });

  it("overlays exact Claude catalog limits without dropping Sonnet wire restrictions", () => {
    installCatalog();
    expect(getCapabilitiesForModel("github", "anthropic/claude-sonnet-5-5")).toMatchObject({
      contextWindow: 64000,
      maxOutput: 32000,
      thinkingFormat: "claude-adaptive",
      thinkingOffType: "between_tools",
      forcedToolChoice: false,
      videoInput: true,
    });
  });

  it("does not overwrite Alibaba's authoritative text-only capabilities with catalog hints", () => {
    installCatalog();
    expect(getCapabilitiesForModel("alitp-intl", "deepseek-v4-pro")).toMatchObject({
      vision: false,
      videoInput: false,
      contextWindow: 1000000,
    });
    expect(getCapabilitiesForModel("alitp-intl", "deepseek-v4.1-flash").maxOutput).toBe(393216);
  });

  it.each(["codex", "cx"])("keeps %s base windows separate from extended variants", (provider) => {
    installCatalog();
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
      expect(getCapabilitiesForModel(provider, model).contextWindow).toBe(272000);
      expect(getCapabilitiesForModel(provider, `${model}[1m]`).contextWindow).toBe(872000);
    }
    expect(getCapabilitiesForModel(provider, "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel(provider, "gpt-5.6-sol[1m]").contextWindow).toBe(872000);
  });

  it.each(["devin-cli", "dv", "devin"])("keeps %s limits ahead of generic GPT and catalog limits", (provider) => {
    installCatalog();
    expect(getCapabilitiesForModel(provider, "gpt-5.5-xhigh")).toMatchObject({
      contextWindow: 200000,
      maxOutput: 128000,
      thinkingFormat: "openai",
      vision: true,
    });
  });

  it("recognizes the hyphenated DeepSeek vision alias without overriding Alibaba text-only models", () => {
    expect(getCapabilitiesForModel("kenari", "deepseek-v4-1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      contextWindow: 1000000,
      maxOutput: 384000,
    });
    expect(getCapabilitiesForModel("alitp-intl", "deepseek-v4-pro").vision).toBe(false);
  });

  it("keeps account reasoning metadata authoritative over Codex name patterns", () => {
    const metadata = { supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "high" }] };
    expect(getAdvertisedThinkingLevels("codex", "gpt-6.1-sol[1m]", metadata)).toEqual(["medium", "high"]);
    expect(() => applyThinking("openai-responses", "gpt-6.1-sol[1m](xhigh)", {}, "codex", undefined, metadata))
      .toThrow(/Unsupported Codex reasoning effort/);
    expect(getThinkingLevels("codex", "gpt-6.1-sol", { supportedReasoningLevels: [] })).toEqual([]);
    const body = { reasoning_effort: "high", thinking: { type: "enabled" } };
    applyThinking("openai-responses", "gpt-6.1-sol", body, "codex", undefined, { supportedReasoningLevels: [] });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});
