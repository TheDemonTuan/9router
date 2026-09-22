import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getChatGptWebCatalog: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));
vi.mock("open-sse/services/chatgptWebBridge.js", () => ({
  getChatGptWebCatalog: mocks.getChatGptWebCatalog,
  chatGptWebModelSupportsNativeResponses: (model) => model?.capabilities?.native_responses === true,
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

describe("GET /api/providers/[id]/models ChatGPT Web catalog", () => {
  it("hides retained stale rows while preserving stale status", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "bridge-1",
      provider: "chatgpt-web",
      providerSpecificData: { bridgeId: "personal" },
    });
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: true,
      models: [{ id: "chatgpt-web/high" }],
    });

    const response = await GET(new Request("http://localhost/api/providers/bridge-1/models"), {
      params: Promise.resolve({ id: "bridge-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ models: [], stale: true });
  });
});
