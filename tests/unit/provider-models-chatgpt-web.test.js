import { beforeEach, describe, expect, it, vi } from "vitest";
import { webModel, webCatalog } from "./chatgpt-web-fixtures.js";
const mocks = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), getChatGptWebCatalog: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ getChatGptWebCatalog: mocks.getChatGptWebCatalog }));
const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
const query = () => GET(new Request("http://localhost/api/providers/one/models"), { params: Promise.resolve({ id: "one" }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ id: "one", provider: "chatgpt-web", providerSpecificData: { profileId: "personal" } });
});
describe("profile catalog", () => {
  it("preserves exact profile metadata and all native model evidence", async () => {
    const catalog = webCatalog();
    mocks.getChatGptWebCatalog.mockResolvedValue(catalog);
    const response = await query();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profileId: "personal", profileEpoch: "epoch-one", revision: "rev-one", models: [webModel()] });
  });
  it("hides stale and unsupported rows", async () => {
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog(undefined, { stale: true }));
    expect(await (await query()).json()).toMatchObject({ models: [], stale: true });
    mocks.getChatGptWebCatalog.mockResolvedValue(webCatalog([webModel({ legacy: true }), webModel({ capabilities: { reasoning: true } })]));
    expect(await (await query()).json()).toMatchObject({ models: [], stale: false });
  });
  it("reports an unavailable profile rather than empty successful discovery", async () => {
    mocks.getChatGptWebCatalog.mockRejectedValue(new Error("Profile login_required"));
    const response = await query();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "Profile login_required", models: [] });
  });
});
