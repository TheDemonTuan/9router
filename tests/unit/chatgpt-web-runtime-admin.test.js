import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), admin: vi.fn(), local: vi.fn() }));
vi.mock("@/dashboardGuard", () => ({ authorizeChatGptWebRuntimeAdmin: mocks.authorize, isLocalRequest: mocks.local }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ requestChatGptWebRuntimeAdmin: mocks.admin }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
const { GET, POST, PATCH } = await import("../../src/app/api/providers/chatgpt-web/runtime/[...action]/route.js");
const settings = { mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false, connectorName: "Codex Native2" };
const fixture = () => ({ profileId: "personal", revision: 3, settings: { ...settings }, state: "ready", activeTurns: 0, maxConcurrency: 5, connectorReady: false, lastError: null, models: [{ id: "chatgpt-web/gpt-5.6-sol", display_name: "GPT-5.6 Sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", context_window: 100000 }] });
const loginId = "aabbccdd-1234-4567-89ab-0123456789ab";
const lease = () => ({ loginId, profileId: "personal", expiresAt: new Date(Date.now() + 600000).toISOString(), state: "waiting", manualLogin: true });
const context = action => ({ params: Promise.resolve({ action: action.split("/") }) });
const transfer = () => ({ profileId: "personal", revision: 3, session: { format: "9router-chatgpt-session", version: 1, cookies: [{ name: "fixture_session", value: "fixture-cookie-secret", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }] } });
function request(action, method = "GET", body, headers = {}) {
  return new Request(`https://admin.example.test/api/providers/chatgpt-web/runtime/${action}`, { method, headers: { host: "admin.example.test", origin: "https://admin.example.test", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.authorize.mockResolvedValue(true);
  mocks.local.mockReturnValue(false);
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
  it.each(["session/verify", "browser/view", "browser/restart", "login/start", "login/complete", "login/close", "smoke", "drain"])("GET %s never mutates runtime state", async action => {
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
    mocks.admin.mockImplementation(async () => Response.json({ error: { code: "connector_unavailable", message: "Bearer secret" } }, { status: 409 }));
    const unavailable = await PATCH(request("profiles/personal", "PATCH", { revision: 3, settings: { mode: "full" } }), context("profiles/personal"));
    expect(unavailable.status).toBe(409);
    const output = await unavailable.json();
    expect(output.error.code).toBe("connector_unavailable");
    expect(output.error.message).not.toContain("secret");
  });
  it.each([["profile_probe_failed", 502], ["model_version_unavailable", 409], ["unknown_probe_error", 500]])("preserves safe %s completion diagnostics and status without retry or secret leakage", async (backendCode, status) => {
    mocks.admin.mockResolvedValue(Response.json({ error: { code: backendCode, message: "Bearer fixture-secret <html>private trace</html>" } }, { status }));
    const response = await POST(request("login/complete", "POST", { loginId }), context("login/complete"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.error.code).toBe(backendCode === "unknown_probe_error" ? "runtime_error" : backendCode);
    expect(JSON.stringify(data)).not.toMatch(/fixture-secret|Bearer|<html>|private trace/);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });
  it.each(["profile_probe_failed", "model_version_unavailable", "unknown_probe_error"])("redacts profile.lastError while preserving safe %s code", async backendCode => {
    mocks.admin.mockResolvedValue(Response.json({ profiles: [{ ...fixture(), state: "error", lastError: { code: backendCode, message: "Bearer fixture-secret <html>private trace</html>" } }] }));
    const response = await GET(request("profiles"), context("profiles"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.profiles[0].lastError.code).toBe(backendCode === "unknown_probe_error" ? "runtime_error" : backendCode);
    expect(JSON.stringify(data)).not.toMatch(/fixture-secret|Bearer|<html>|private trace/);
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
  it("returns viewer identity/state without passwords, CDP endpoints, or arbitrary instructions", async () => {
    const value = lease();
    mocks.admin.mockImplementation(async () => Response.json({ ...value, password: "vnc-secret", cdpUrl: "ws://private", instructions: "Bearer runtime-secret" }));
    const response = await POST(request("browser/view", "POST", { profileId: "personal" }), context("browser/view"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(value);
  });
  it("returns the ephemeral VNC password only from the authenticated no-store session boundary", async () => {
    const value = { ...lease(), password: "fixtureVncPassword" };
    mocks.admin.mockResolvedValue(Response.json({ ...value, runtimeToken: "private-token" }));
    const response = await GET(request(`login/session?loginId=${loginId}`), context("login/session"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(value);
    mocks.authorize.mockResolvedValue(false);
    expect((await GET(request(`login/session?loginId=${loginId}`), context("login/session"))).status).toBe(401);
  });
  it.each(["completed", "expired", "closed", "error"])("preserves terminal %s status without exposing password", async state => {
    const value = { ...lease(), state };
    mocks.admin.mockResolvedValue(Response.json({ ...value, password: "fixtureVncPassword" }));
    expect(await (await GET(request(`login/status?loginId=${loginId}`), context("login/status"))).json()).toEqual(value);
    expect((await GET(request(`login/session?loginId=${loginId}`), context("login/session"))).status).toBe(502);
  });
  it("rejects mismatched and expired sessions and closes only an exact lease", async () => {
    for (const value of [{ ...lease(), loginId: "00000000-0000-4000-8000-000000000000" }, { ...lease(), expiresAt: "2000-01-01T00:00:00.000Z" }]) {
      mocks.admin.mockResolvedValue(Response.json({ ...value, password: "fixtureVncPassword" }));
      expect((await GET(request(`login/session?loginId=${loginId}`), context("login/session"))).status).toBe(502);
    }
    const value = { ...lease(), state: "closed" };
    mocks.admin.mockResolvedValue(Response.json(value));
    expect(await (await POST(request("login/close", "POST", { loginId }), context("login/close"))).json()).toEqual(value);
    expect((await POST(request("login/close", "POST", { loginId, profileId: "other" }), context("login/close"))).status).toBe(400);
  });
  it("rejects unverifiable sign-in modes and completion responses for a different lease", async () => {
    for (const manualLogin of [undefined, null, "true", 1]) {
      mocks.admin.mockResolvedValue(Response.json({ ...lease(), manualLogin }));
      expect((await POST(request("login/start", "POST", { profileId: "personal" }), context("login/start"))).status).toBe(502);
    }
    mocks.admin.mockResolvedValue(Response.json({ ...lease(), loginId: "00000000-0000-4000-8000-000000000000", state: "completed", manualLogin: false }));
    expect((await POST(request("login/complete", "POST", { loginId }), context("login/complete"))).status).toBe(502);
    expect((await POST(request("login/complete", "POST", { loginId, profileId: "other" }), context("login/complete"))).status).toBe(400);
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
    expect(JSON.stringify(data)).not.toContain("private tool data");
  });
  it.each([{ profileId: "personal" }, { profileId: "personal", revision: 0 }, { profileId: "personal", revision: 1.5 }, { profileId: "personal", revision: 3, session: {} }, { profileId: "../escape", revision: 3 }])("rejects invalid saved-session targets without browser mutations", async body => {
    const response = await POST(request("session/verify", "POST", body), context("session/verify"));
    expect(response.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("keeps saved-session readiness and rejects a different response target", async () => {
    mocks.admin.mockResolvedValue(Response.json({ ...fixture(), cookies: "fixture-cookie-secret", accountFingerprint: "fixture-fingerprint-secret" }));
    const response = await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.state).toBe("ready");
    expect(data.profileId).toBe("personal");
    expect(JSON.stringify(data)).not.toMatch(/fixture-cookie-secret|fixture-fingerprint-secret/);
    mocks.admin.mockResolvedValue(Response.json({ ...fixture(), profileId: "another" }));
    expect((await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"))).status).toBe(502);
  });
  it("preserves failed saved-session probes without retrying or claiming expiration", async () => {
    mocks.admin.mockResolvedValue(Response.json({ error: { code: "profile_probe_failed", message: "fixture-private-session" } }, { status: 502 }));
    const response = await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("profile_probe_failed");
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });
  it.each(["session/import", "session/verify"])("requires POST and authenticated same-origin access for %s", async action => {
    expect((await GET(request(action), context(action))).status).toBe(405);
    mocks.authorize.mockResolvedValue(false);
    expect((await POST(request(action, "POST", transfer()), context(action))).status).toBe(401);
    mocks.authorize.mockResolvedValue(true);
    expect((await POST(request(action, "POST", transfer(), { origin: "https://evil.test" }), context(action))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("requires HTTPS for remote imports and a trusted local boundary for HTTP loopback", async () => {
    const http = host => new Request(`http://${host}/api/providers/chatgpt-web/runtime/session/import`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify(transfer()) });
    for (const host of ["admin.example.test", "localhost", "127.0.0.1", "[::1]"]) {
      const response = await POST(http(host), context("session/import"));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("secure_origin_required");
    }
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.local.mockReturnValue(true);
    mocks.admin.mockResolvedValue(Response.json(fixture()));
    expect((await POST(http("localhost"), context("session/import"))).status).toBe(200);
    expect((await POST(http("admin.example.test"), context("session/import"))).status).toBe(403);
  });
  it.each([["text/plain", "identity"], ["application/json", "gzip"], ["application/json", "zstd"]])("rejects import media/encoding %s %s before touching the runtime", async (media, encoding) => {
    const response = await POST(request("session/import", "POST", transfer(), { "content-type": media, "content-encoding": encoding }), context("session/import"));
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("invalid_session_transfer");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("limits streamed credential bytes without Content-Length and cancels overflow", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel() { cancelled = true; } });
    const input = new Request("https://admin.example.test/api/providers/chatgpt-web/runtime/session/import", { method: "POST", headers: { host: "admin.example.test", origin: "https://admin.example.test", "content-type": "application/json" }, body: stream, duplex: "half" });
    const response = await POST(input, context("session/import"));
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("session_transfer_too_large");
    expect(cancelled).toBe(true);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["{", new Uint8Array([0xff, 0xfe])])("rejects malformed import JSON or UTF-8 without leaking contents", async bytes => {
    const input = request("session/import", "POST", transfer());
    const response = await POST(new Request(input, { body: bytes }), context("session/import"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_session_transfer");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["session/import", "session/verify"])("distinguishes old runtime empty 404 from typed missing profile for %s", async action => {
    const body = action === "session/import" ? transfer() : { profileId: "personal", revision: 3 };
    mocks.admin.mockResolvedValue(new Response(null, { status: 404 }));
    const old = await POST(request(action, "POST", body), context(action));
    expect(old.status).toBe(503);
    expect((await old.json()).error.code).toBe("runtime_upgrade_required");
    mocks.admin.mockResolvedValue(Response.json({ error: { code: "profile_not_found", message: "fixture-cookie-secret" } }, { status: 404 }));
    const missing = await POST(request(action, "POST", body), context(action));
    expect(missing.status).toBe(404);
    const value = await missing.json();
    expect(value.error.code).toBe("profile_not_found");
    expect(JSON.stringify(value)).not.toContain("fixture-cookie-secret");
  });
  it("strips import secrets and rejects mismatched response profile without retry", async () => {
    mocks.admin.mockResolvedValue(Response.json({ ...fixture(), cookies: transfer().session.cookies, accountFingerprint: "fixture-fingerprint-secret", token: "fixture-token-secret" }));
    const response = await POST(request("session/import", "POST", transfer()), context("session/import"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(value.state).toBe("ready");
    expect(value.profileId).toBe("personal");
    expect(JSON.stringify(value)).not.toMatch(/fixture-cookie-secret|fixture-fingerprint-secret|fixture-token-secret/);
    mocks.admin.mockResolvedValue(Response.json({ ...fixture(), profileId: "another" }));
    expect((await POST(request("session/import", "POST", transfer()), context("session/import"))).status).toBe(502);
  });
  it.each([["session_account_mismatch", 409], ["session_restore_failed", 503], ["login_required", 409], ["profile_probe_failed", 502]])("preserves safe import failure %s and never replays credentials", async (code, status) => {
    mocks.admin.mockResolvedValue(Response.json({ error: { code, message: "fixture-cookie-secret fixture-token-secret fixture-fingerprint-secret" } }, { status }));
    const response = await POST(request("session/import", "POST", transfer()), context("session/import"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(value.error.code).toBe(code);
    expect(JSON.stringify(value)).not.toMatch(/fixture-cookie-secret|fixture-token-secret|fixture-fingerprint-secret/);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });
});
