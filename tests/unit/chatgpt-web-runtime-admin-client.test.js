import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), fetch: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
const { requestChatGptWebRuntimeAdmin, requestChatGptWebRuntime, parseChatGptWebCatalog, prepareChatGptWebProfile, getChatGptWebCatalog, invalidateChatGptWebCatalog } = await import("../../open-sse/services/chatgptWebRuntimeClient.js");
const original = Object.fromEntries(["CHATGPT_WEB_RUNTIME_URL", "CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE", "CHATGPT_WEB_RUNTIME_TOKEN_FILE"].map(name => [name, process.env[name]]));
const adminToken = "fixture-admin-bearer-not-a-real-token";
beforeEach(() => {
  vi.clearAllMocks();
  invalidateChatGptWebCatalog();
  process.env.CHATGPT_WEB_RUNTIME_URL = "http://runtime.example.test/";
  process.env.CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE = "/fixture/admin-token";
  process.env.CHATGPT_WEB_RUNTIME_TOKEN_FILE = "/fixture/data-token";
  mocks.readFile.mockResolvedValue(adminToken);
  mocks.fetch.mockImplementation(async () => Response.json({ ok: true }));
});
afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("managed harness internal transport", () => {
  it.each(["configure", "start", "verify", "activate", "disconnect"])("permits only admin POST /admin/harness/%s with runtime-owned authentication", async name => {
    const path = `/admin/harness/${name}`;
    const body = JSON.stringify({ profileId: "personal", revision: 3, configRevision: 1 });
    await requestChatGptWebRuntimeAdmin(path, { method: "POST", body, headers: { authorization: "Bearer client-secret", "x-cgw-profile-id": "other", "x-9router-cgw-attestation": "fake-native-authority", "x-codex-turn-metadata": "fake-native-metadata", "content-type": "application/json" } });
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/fixture/admin-token", "utf8");
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`http://runtime.example.test${path}`, expect.objectContaining({ method: "POST", body, redirect: "error" }));
    const forwarded = mocks.fetch.mock.calls[0][1].headers;
    expect(forwarded.get("authorization")).toBe(`Bearer ${adminToken}`);
    for (const name of ["x-cgw-profile-id", "x-9router-cgw-attestation", "x-codex-turn-metadata"]) expect(forwarded.has(name)).toBe(false);
    expect(forwarded.get("content-type")).toBe("application/json");
  });
  it("permits exact read-only status query and does not add client authority", async () => {
    await requestChatGptWebRuntimeAdmin("/admin/harness/status?profileId=personal");
    expect(mocks.fetch.mock.calls[0][0]).toBe("http://runtime.example.test/admin/harness/status?profileId=personal");
    expect(mocks.fetch.mock.calls[0][1].headers.has("x-cgw-profile-id")).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["/admin/harness/status?profileId=personal", "POST"],
    ["/admin/harness/status", "GET"],
    ["/admin/harness/status?profileId=personal&profileId=other", "GET"],
    ["/admin/harness/status?profileId=../escape", "GET"],
    ["/admin/harness/status?profileId=personal&probe=true", "GET"],
    ["/admin/harness/configure", "GET"],
    ["/admin/harness/start", "PATCH"],
    ["/admin/harness/verify?profileId=personal", "POST"],
    ["/admin/harness/activate#fragment", "POST"],
    ["/admin/harness/disconnect?key=secret", "POST"],
    ["/admin/harness/delete", "POST"],
    ["https://foreign.example.test/admin/harness/start", "POST"],
  ])("rejects unsupported internal endpoint %s %s before reading credentials", async (path, method) => {
    await expect(requestChatGptWebRuntimeAdmin(path, { method })).rejects.toThrow();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each(["status", "configure", "start", "verify", "activate", "disconnect"])("never permits harness/%s using data-plane credentials", async name => {
    const path = `/admin/harness/${name}${name === "status" ? "?profileId=personal" : ""}`;
    await expect(requestChatGptWebRuntime({ providerSpecificData: { profileId: "personal" } }, path, { method: name === "status" ? "GET" : "POST" })).rejects.toThrow("Unsupported internal runtime endpoint");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("retains generic capability booleans from the verified catalog without unknown capabilities", () => {
    const catalog = { protocolVersion: 1, profile_id: "personal", profile_epoch: "fixture-epoch", catalog_revision: "fixture-revision", checked_at: "2026-10-08T00:00:00.000Z", max_concurrency: 5, models: [{ id: "chatgpt-web/gpt-5.6-sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", legacy: false, context_window: 100000, auto_compact_token_limit: 80000, capabilities: { text: true, generic_responses: true, generic_tools: false, unknownAuthority: true, toolToken: "fixture-secret" } }] };
    expect(parseChatGptWebCatalog(catalog).models[0].capabilities).toEqual({ text: true, generic_responses: true, generic_tools: false });
    catalog.models[0].capabilities.generic_tools = "true";
    expect(parseChatGptWebCatalog(catalog).models[0].capabilities).toEqual({ text: true, generic_responses: true });
  });
});

describe("lazy profile preparation", () => {
  const connection = { providerSpecificData: { profileId: "personal" } };
  const catalog = () => ({ protocolVersion: 1, profile_id: "personal", profile_epoch: "epoch-one", catalog_revision: "revision-one", checked_at: "2026-10-09T00:00:00Z", max_concurrency: 5,
    models: [{ id: "chatgpt-web/gpt-6-sol", legacy: false, supported_reasoning_levels: ["high"], default_reasoning_level: "high", context_window: 90000, auto_compact_token_limit: 80000, capabilities: { text: true, generic_responses: true } }] });
  it("uses a cold epoch snapshot then an exact authenticated DATA preparation", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async url => Response.json(url.endsWith("/admin/profiles")
      ? { protocolVersion: 1, profiles: [{ profileId: "personal", profileEpoch: "epoch-one" }, { profileId: "other", profileEpoch: "epoch-two" }] } : catalog()));
    mocks.readFile.mockImplementation(async path => path === "/fixture/data-token" ? "fixture-data-bearer-not-a-real-token" : adminToken);
    expect(await prepareChatGptWebProfile(connection, { signal: controller.signal })).toMatchObject({ profileId: "personal", profileEpoch: "epoch-one" });
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(["http://runtime.example.test/admin/profiles", "http://runtime.example.test/v1/profiles/prepare"]);
    const init = mocks.fetch.mock.calls[1][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ profileId: "personal", profileEpoch: "epoch-one" });
    expect(init.headers.get("x-cgw-profile-id")).toBe("personal");
    expect(init.headers.get("authorization")).toBe("Bearer fixture-data-bearer-not-a-real-token");
    controller.abort(); expect(init.signal.aborted).toBe(true);
  });
  it("never prepares from a catalog GET and uses a supplied trusted epoch without admin discovery", async () => {
    mocks.fetch.mockResolvedValue(Response.json(catalog()));
    await getChatGptWebCatalog(connection, { force: true });
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(["http://runtime.example.test/v1/web-models"]);
    mocks.fetch.mockClear(); mocks.fetch.mockResolvedValue(Response.json(catalog()));
    await prepareChatGptWebProfile({ ...connection, chatGptWebProfileEpoch: "epoch-one" });
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual(["http://runtime.example.test/v1/profiles/prepare"]);
  });
  it("fails closed on epoch drift and does no work for an aborted caller", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ...catalog(), profile_epoch: "epoch-two" }));
    await expect(prepareChatGptWebProfile({ ...connection, chatGptWebProfileEpoch: "epoch-one" })).rejects.toThrow("identity mismatch");
    mocks.fetch.mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(prepareChatGptWebProfile(connection, { signal: controller.signal })).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("keeps resources GET admin-only and prepare POST data-only", async () => {
    await requestChatGptWebRuntimeAdmin("/admin/resources");
    await expect(requestChatGptWebRuntimeAdmin("/admin/resources", { method: "POST" })).rejects.toThrow();
    await expect(requestChatGptWebRuntime(connection, "/admin/resources")).rejects.toThrow();
    await expect(requestChatGptWebRuntime(connection, "/v1/profiles/prepare")).rejects.toThrow();
    await expect(requestChatGptWebRuntimeAdmin("/v1/profiles/prepare", { method: "POST" })).rejects.toThrow();
  });
});
