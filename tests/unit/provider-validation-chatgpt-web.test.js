import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderNodeById: vi.fn(),
  getChatGptWebHealth: vi.fn(),
  getChatGptWebCatalog: vi.fn(),
}));

vi.mock("@/models", () => ({ getProviderNodeById: mocks.getProviderNodeById }));
vi.mock("open-sse/services/chatgptWebBridge.js", () => ({
  getChatGptWebHealth: mocks.getChatGptWebHealth,
  getChatGptWebCatalog: mocks.getChatGptWebCatalog,
  chatGptWebModelSupportsNativeResponses: (model) => model?.capabilities?.native_responses === true,
  validateChatGptWebBridgeId: (value) => {
    if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
      throw new Error("bridgeId must be a lowercase slug");
    }
    return value;
  },
}));

const { POST } = await import("../../src/app/api/providers/validate/route.js");

describe("POST /api/providers/validate ChatGPT Web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not mark a stale bridge catalog valid or return stale rows", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({ stale: true, models: [{ id: "chatgpt-web/high" }] });

    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", providerSpecificData: { bridgeId: "personal" } }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ valid: false, models: [], stale: true });
  });

  it("rejects a fresh catalog with no usable capability evidence", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({ stale: false, models: [{ id: "chatgpt-web/high", capabilities: { reasoning: true } }] });

    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", providerSpecificData: { bridgeId: "personal" } }),
    }));

    await expect(response.json()).resolves.toMatchObject({ valid: false, models: [] });
  });

  it("accepts generic-only model evidence", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ status: "ok", accepting_turns: true });
    mocks.getChatGptWebCatalog.mockResolvedValue({
      stale: false,
      models: [{ id: "chatgpt-web/generic", capabilities: { generic_responses: true } }],
    });

    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", providerSpecificData: { bridgeId: "personal" } }),
    }));

    await expect(response.json()).resolves.toMatchObject({ valid: true, models: [{ id: "chatgpt-web/generic" }] });
  });

  it("rejects a non-string bridge ID at the HTTP boundary", async () => {
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "chatgpt-web", providerSpecificData: { bridgeId: 7 } }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ valid: false });
    expect(mocks.getChatGptWebHealth).not.toHaveBeenCalled();
  });
});
