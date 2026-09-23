import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    id: "codex-route-account",
    provider: "codex",
    accessToken: "token",
    providerSpecificData: { chatgptAccountId: "acct-route" },
  },
  resolveCodexModels: vi.fn(async () => ({
    resolved: true,
    source: "live",
    access: "observed",
    stale: false,
    fetchedAt: 123,
    models: [{ id: "gpt-6-sol", name: "GPT-6-Sol", supportedReasoningLevels: ["low", "ultra"] }],
    candidateModels: [{ id: "future", compatibilityReason: "minimal_client_version" }],
  })),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async () => mocks.connection),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/codexModels.js", () => ({ resolveCodexModels: mocks.resolveCodexModels }));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

describe("Codex provider models route", () => {
  it("uses the shared resolver and forwards provenance/metadata", async () => {
    const request = new Request("http://localhost/api/providers/codex-route-account/models?refresh=true");
    const response = await GET(request, { params: Promise.resolve({ id: mocks.connection.id }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      provider: "codex",
      connectionId: mocks.connection.id,
      source: "live",
      access: "observed",
      resolved: true,
      stale: false,
      fetchedAt: 123,
      models: [{ id: "gpt-6-sol", supportedReasoningLevels: ["low", "ultra"] }],
    });
    expect(data.candidateModels).toEqual([{ id: "future", compatibilityReason: "minimal_client_version" }]);
    expect(mocks.resolveCodexModels).toHaveBeenCalledWith(
      mocks.connection,
      expect.objectContaining({ forceRefresh: true, signal: expect.any(AbortSignal) }),
    );
  });
});
