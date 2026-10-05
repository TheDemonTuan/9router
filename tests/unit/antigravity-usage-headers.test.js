import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url, options = {}) => {
  if (url.includes("manifest")) {
    return {
      ok: true,
      status: 200,
      text: async () => "version: 2.19.1\n",
    };
  }

  if (url.includes(":loadCodeAssist")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        cloudaicompanionProject: "project-1",
        currentTier: { name: "Pro" },
        paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
      }),
      text: async () => "{}",
    };
  }

  if (url.includes(":retrieveUserQuotaSummary")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ groups: [] }),
      text: async () => "{}",
    };
  }

  if (url.includes(":fetchAvailableModels")) {
    const isHub = options?.headers?.["User-Agent"]?.includes("antigravity/hub/2.19.1");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: {
          "gemini-2.5-pro": {
            displayName: "Gemini 2.5 Pro",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-05-01T00:00:00Z" },
          },
          ...(isHub ? {
            "claude-sonnet-5-5": {
              displayName: "Claude Sonnet 5.5",
              quotaInfo: { remainingFraction: 0.5, resetTime: "2026-05-01T00:00:00Z" },
            },
          } : {}),
          "imagen-3.0-generate": {
            displayName: "Imagen 3.0",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-05-01T00:00:00Z" },
          },
        },
        imageGenerationModelIds: ["opaque-image-slot"],
      }),
      text: async () => "{}",
    };
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
  };
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers and version-gated discovery", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
  });

  it("surfaces Claude 5.5 quota via discovery profile and manifest never receives credentials", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("test-secret-token", {});

    expect(usage).toBeDefined();
    expect(usage.quotas).toBeDefined();

    // Manifest call check: must NOT have Authorization / Bearer token
    const manifestCall = proxyAwareFetch.mock.calls.find(([url]) => url.includes("manifest"));
    if (manifestCall) {
      const [, manifestOptions] = manifestCall;
      expect(manifestOptions?.headers?.Authorization).toBeUndefined();
      expect(manifestOptions?.headers?.["authorization"]).toBeUndefined();
    }

    // fetchAvailableModels call check: uses discovery profile UA and X-Client-Version
    const fetchModelsCall = proxyAwareFetch.mock.calls.find(([url]) => url.includes(":fetchAvailableModels"));
    expect(fetchModelsCall).toBeDefined();
    const [, fetchOptions] = fetchModelsCall;
    expect(fetchOptions.headers["User-Agent"]).toContain("antigravity/hub/");
    expect(fetchOptions.headers["X-Client-Version"]).toMatch(/^\d+\.\d+\.\d+$/);

    // Quota for 5.5 is populated because profile unlocked it
    expect(usage.quotas["claude-sonnet-5-5"]).toBeDefined();
    expect(usage.quotas["claude-sonnet-5-5"].remainingPercentage).toBe(50);

    // Image quota is preserved
    expect(usage.quotas["imagen-3.0-generate"]).toBeDefined();
  });
});
