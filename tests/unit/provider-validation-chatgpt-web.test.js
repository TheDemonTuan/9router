import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog, runtimeHealth } from "./chatgpt-web-fixtures.js";
const mocks = vi.hoisted(() => ({ getProviderNodeById: vi.fn(), getChatGptWebHealth: vi.fn(), getChatGptWebCatalog: vi.fn(), requestChatGptWebRuntime: vi.fn() }));
vi.mock("@/models", () => ({ getProviderNodeById: mocks.getProviderNodeById }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({
  getChatGptWebHealth: mocks.getChatGptWebHealth, getChatGptWebCatalog: mocks.getChatGptWebCatalog, requestChatGptWebRuntime: mocks.requestChatGptWebRuntime,
  validateChatGptWebProfileId: value => {
    if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) throw new Error("profileId must be a lowercase slug");
    return value;
  },
}));
const { POST } = await import("../../src/app/api/providers/validate/route.js");
const validate = (extra = {}) => POST(new Request("http://localhost/api/providers/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt-web", providerSpecificData: { profileId: "personal" }, ...extra }) }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getChatGptWebHealth.mockResolvedValue(runtimeHealth);
  mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog());
  mocks.requestChatGptWebRuntime.mockResolvedValue(new Response("{}"));
});
describe("profile validation", () => {
  it("accepts a ready profile and preserves native model reasoning evidence", async () => {
    expect(await (await validate()).json()).toMatchObject({ valid: true, models: [webModel()] });
  });
  it("rejects liveness without profile readiness", async () => {
    mocks.requestChatGptWebRuntime.mockResolvedValue(new Response("{}", { status: 503 }));
    expect(await (await validate()).json()).toMatchObject({ valid: false, error: expect.any(String) });
  });
  it("rejects draining, stale and unsupported catalogs", async () => {
    mocks.getChatGptWebHealth.mockResolvedValue({ ...runtimeHealth, draining: true });
    expect(await (await validate()).json()).toMatchObject({ valid: false });
    mocks.getChatGptWebHealth.mockResolvedValue(runtimeHealth);
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await (await validate()).json()).toMatchObject({ valid: false, stale: true, models: [] });
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ capabilities: { reasoning: true } })]));
    expect(await (await validate()).json()).toMatchObject({ valid: false, models: [] });
  });
  it.each([7, "../escape", "UPPER", ""]) ("rejects invalid profile selector %s before probing", async profileId => {
    const response = await validate({ providerSpecificData: { profileId } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ valid: false });
    expect(mocks.getChatGptWebHealth).not.toHaveBeenCalled();
  });
  it.each([{ runtimeUrl: "http://other" }, { cookie: "private" }, { token: "private" }])("rejects transport and credential input %j", async extra => {
    expect((await validate(extra)).status).toBe(400);
    expect(mocks.getChatGptWebHealth).not.toHaveBeenCalled();
  });
});
