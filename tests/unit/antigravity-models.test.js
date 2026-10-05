import { describe, it, expect } from "vitest";
import { normalizeAntigravityCatalog, isAntigravityModelAvailable } from "../../open-sse/services/antigravityModels.js";

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
