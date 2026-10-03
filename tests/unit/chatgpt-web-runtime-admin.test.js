import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), admin: vi.fn() }));
vi.mock("@/dashboardGuard", () => ({ authorizeChatGptWebRuntimeAdmin: mocks.authorize }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ requestChatGptWebRuntimeAdmin: mocks.admin }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
const { GET, POST, PATCH } = await import("../../src/app/api/providers/chatgpt-web/runtime/[...action]/route.js");
const settings = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const fixture = () => ({ profileId: "personal", revision: 3, settings: { ...settings }, state: "ready", activeTurns: 0, maxConcurrency: 5, connectorReady: false, lastError: null, models: [{ id: "chatgpt-web/gpt-5.6-sol", display_name: "GPT-5.6 Sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", context_window: 100000 }] });
const context = action => ({ params: Promise.resolve({ action: action.split("/") }) });
function request(action, method = "GET", body, headers = {}) {
  return new Request(`https://admin.example.test/api/providers/chatgpt-web/runtime/${action}`, { method, headers: { host: "admin.example.test", origin: "https://admin.example.test", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.authorize.mockResolvedValue(true);
  mocks.admin.mockImplementation(async () => Response.json({ profiles: [fixture()] }));
});
describe("ChatGPT Web runtime admin boundaries", () => {
  it("denies before contacting the runtime without dashboard authentication", async () => {
    mocks.authorize.mockResolvedValue(false);
    expect((await GET(request("profiles"), context("profiles"))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example.test", "null", "https://admin.example.test:444"])("rejects a cross-origin mutation from %s", async origin => {
    expect((await POST(request("profiles", "POST", { profileId: "personal" }, { origin }), context("profiles"))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects missing Origin and cross-site Fetch Metadata", async () => {
    const noOrigin = request("profiles", "POST", { profileId: "personal" }); noOrigin.headers.delete("origin");
    expect((await POST(noOrigin, context("profiles"))).status).toBe(403);
    expect((await POST(request("profiles", "POST", { profileId: "personal" }, { "sec-fetch-site": "cross-site" }), context("profiles"))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["browser/view", "browser/restart", "login/start", "smoke", "drain"])("GET %s never mutates runtime state", async action => {
    expect((await GET(request(action), context(action))).status).toBe(405);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["healthz", "https://evil.test", "profiles/personal/extra", "__proto__", "constructor"])("rejects paths outside the exact allowlist: %s", async action => {
    expect((await GET(request(action), context(action))).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([{ profileId: "../escape" }, { profileId: "personal", runtimeUrl: "https://evil.test" }, { profileId: "personal", token: "secret" }, { profileId: 42 }])("rejects unsafe creation parameters: %j", async body => {
    expect((await POST(request("profiles", "POST", body), context("profiles"))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("requires a settings revision and rejects unrecognized settings or connector names", async () => {
    for (const body of [{ settings }, { revision: -1, settings }, { revision: 3, settings: { browserPath: "/tmp" } }, { revision: 3, settings: { connectorName: "Other" } }]) {
      expect((await PATCH(request("profiles/personal", "PATCH", body), context("profiles/personal"))).status).toBe(400);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("reports conflicts and prerequisite rejection without claiming Full succeeded", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ error: { code: "revision_conflict", message: "secret backend trace" } }, { status: 409 }));
    const conflict = await PATCH(request("profiles/personal", "PATCH", { revision: 2, settings: { mode: "full" } }), context("profiles/personal"));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.message).toContain("Refresh");
    mocks.admin.mockImplementation(async () => Response.json({ error: { code: "connector_unavailable", message: "Bearer secret" } }, { status: 409 }));
    const unavailable = await PATCH(request("profiles/personal", "PATCH", { revision: 3, settings: { mode: "full" } }), context("profiles/personal"));
    expect(unavailable.status).toBe(409);
    const output = await unavailable.json();
    expect(output.error.code).toBe("connector_unavailable");
    expect(output.error.message).not.toContain("secret");
  });
  it("preserves verified model efforts but strips private profile fields and error text", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ profiles: [{ ...fixture(), cookies: "cookie-secret", token: "bearer-secret", lastError: "raw-private-diagnostic" }] }));
    const response = await GET(request("profiles"), context("profiles"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.profiles[0].models[0].supported_reasoning_levels).toEqual(["medium", "high"]);
    expect(data.profiles[0].models[0].model_family).toBe("5.6");
    expect(JSON.stringify(data)).not.toMatch(/cookie-secret|bearer-secret|raw-private-diagnostic/);
  });
  it("returns SSH native VNC instructions without passwords, CDP endpoints, or arbitrary runtime instructions", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ loginId: "lease-1", expiresAt: "2030-01-01T00:15:00.000Z", password: "vnc-secret", cdpUrl: "ws://private", instructions: "Bearer runtime-secret" }));
    const response = await POST(request("browser/view", "POST", { profileId: "personal" }), context("browser/view"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.instructions).toContain("ssh -L 17842");
    expect(data.instructions).toContain("native VNC");
    expect(JSON.stringify(data)).not.toMatch(/vnc-secret|runtime-secret|ws:\/\/private/);
  });
  it("requires a single bounded loginId query and rejects foreign query options", async () => {
    for (const suffix of ["?loginId=a&loginId=b", "?loginId=a&url=https://evil.test", "?loginId=../escape", ""]) {
      expect((await GET(request(`login/status${suffix}`), context("login/status"))).status).toBe(400);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed request and runtime response bodies", async () => {
    expect((await POST(request("profiles", "POST", { profileId: "personal", padding: "x".repeat(8192) }), context("profiles"))).status).toBe(413);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockImplementation(async () => new Response("x".repeat(262145)));
    expect((await GET(request("profiles"), context("profiles"))).status).toBe(502);
  });
  it("does not claim outer tool E2E from runtime-only smoke", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ profile: fixture(), outerToolE2eVerified: false, stdout: "private tool data" }));
    const response = await POST(request("smoke", "POST", { profileId: "personal", kind: "harness" }), context("smoke"));
    const data = await response.json();
    expect(data.outerToolE2eVerified).toBe(false);
    expect(data.message).toContain("not proof");
    expect(JSON.stringify(data)).not.toContain("private tool data");
  });
});
