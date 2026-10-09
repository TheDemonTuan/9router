import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), admin: vi.fn(), local: vi.fn(), connections: vi.fn(), update: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/dashboardGuard", () => ({ authorizeChatGptWebRuntimeAdmin: mocks.authorize, isLocalRequest: mocks.local }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", async importOriginal => ({ ...await importOriginal(), requestChatGptWebRuntimeAdmin: mocks.admin, invalidateChatGptWebCatalog: mocks.invalidate }));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnections: mocks.connections, updateProviderConnection: mocks.update }));
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
  mocks.connections.mockResolvedValue([]);
  mocks.update.mockResolvedValue(null);
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
  it("preserves optional lifecycle evidence without inferring sleep for older runtimes", async () => {
    mocks.admin.mockResolvedValueOnce(Response.json({ profiles: [{ ...fixture(), state: "session_unverified", models: [], browser_state: "sleeping", catalog_verified: false }] }));
    expect((await (await GET(request("profiles"), context("profiles"))).json()).profiles[0]).toMatchObject({ state: "session_unverified", browser_state: "sleeping", catalog_verified: false });
    for (const fields of [{ catalog_verified: "false" }, { browser_state: "unknown" }]) {
      mocks.admin.mockResolvedValueOnce(Response.json({ profiles: [{ ...fixture(), ...fields }] }));
      expect((await GET(request("profiles"), context("profiles"))).status).toBe(502);
    }
  });
  it("exposes authenticated read-only scalar resource counts, never owner or request details", async () => {
    const limits = { maxGlobalBrowsers: 2, maxGlobalTurns: 2, maxGlobalTabs: 10, maxRetainedTabsPerProfile: 5, maxQueueSize: 16, queueTimeoutMs: 30000, browserIdleTtlMs: 300000, browserMode: "headed", adaptiveDomPolling: false, secret: "fixture-secret" };
    const counts = { browsers: 1, executingTurns: 0, waitingToolTurns: 1, queueDepth: 0 };
    const tabs = { active: 1, retainedNative: 1, retainedGeneric: 0, inspection: 0, owner: "fixture-secret" };
    const snapshot = { limits, ...counts, tabs, totals: { admitted: 2, rejected: 0, queueWaitMs: 10, polls: 2, domCacheHits: 1, domCacheMisses: 1 },
      profiles: [{ profileId: "personal", browserState: "awake", ...counts, tabs, retainedSlots: 1, requestId: "fixture-secret", handle: "fixture-secret" }], token: "fixture-secret" };
    mocks.admin.mockResolvedValueOnce(Response.json(snapshot));
    const response = await GET(request("resources"), context("resources"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(value.profiles[0].tabs).toEqual({ active: 1, retainedNative: 1, retainedGeneric: 0, inspection: 0 });
    expect(JSON.stringify(value)).not.toMatch(/fixture-secret|handle|owner|requestId|token/);
    expect(mocks.admin).toHaveBeenCalledTimes(1); expect(mocks.admin.mock.calls[0][0]).toBe("/admin/resources");
    expect(mocks.invalidate).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    expect((await POST(request("resources", "POST", {}), context("resources"))).status).toBe(405);
    mocks.authorize.mockResolvedValue(false);
    expect((await GET(request("resources"), context("resources"))).status).toBe(401);
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

describe("runtime mutation connection reconciliation", () => {
  const saved = (profileId = "personal", id = "one") => ({ id, provider: "chatgpt-web", authType: "bridge", providerSpecificData: { profileId }, updatedAt: "2026-01-01T00:00:00.000Z", testStatus: "login_required", lastError: "old error", lastErrorAt: "2025-01-01T00:00:00.000Z", priority: 1, isActive: false, modelLock_any: "2099-01-01T00:00:00.000Z" });
  function backend(result, profiles = [fixture()]) {
    mocks.admin.mockImplementation(async path => Response.json(path === "/admin/profiles" ? { protocolVersion: 1, profiles } : result));
  }
  it.each(["session/verify", "session/import", "login/complete"])("saves fresh readiness after %s without resetting quota or trusting the completed lease", async action => {
    const one = saved(); const other = saved("other", "two");
    mocks.connections.mockResolvedValue([one, other]);
    const patches = [];
    mocks.update.mockImplementation(async (id, updater, options) => {
      const current = id === one.id ? one : other;
      const patch = updater(current); patches.push({ id, patch, options });
      return { ...current, ...patch };
    });
    backend(action === "login/complete" ? { ...lease(), state: "completed", manualLogin: false } : fixture());
    const body = action === "session/import" ? transfer() : action === "login/complete" ? { loginId } : { profileId: "personal", revision: 3 };
    const response = await POST(request(action, "POST", body), context(action));
    expect(response.status).toBe(200);
    expect((await response.json()).connectionStatusWarning).toBeUndefined();
    expect(patches).toEqual([{ id: "one", patch: { testStatus: "active", lastError: null, lastErrorAt: null }, options: { resetHealth: false } }]);
    expect(one).toMatchObject({ providerSpecificData: { profileId: "personal" }, priority: 1, isActive: false, modelLock_any: "2099-01-01T00:00:00.000Z" });
    expect(mocks.admin.mock.calls.map(([path]) => path)).toEqual([`/admin/${action}`, "/admin/profiles"]);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("personal");
  });
  it("does not claim active when a completed lease's fresh profile has no models", async () => {
    const one = saved(); mocks.connections.mockResolvedValue([one]);
    backend({ ...lease(), state: "completed", manualLogin: false }, [{ ...fixture(), models: [] }]);
    const response = await POST(request("login/complete", "POST", { loginId }), context("login/complete"));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][1](one)).toMatchObject({ testStatus: "error", lastError: expect.stringContaining("no supported model") });
  });
  it("guards selector, provider, updatedAt, deletion and unchanged values in the transactional callback", async () => {
    const one = saved(); mocks.connections.mockResolvedValue([one]); backend(fixture());
    await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"));
    const updater = mocks.update.mock.calls[0][1];
    for (const current of [null, { ...one, provider: "other" }, { ...one, providerSpecificData: { profileId: "other" } }, { ...one, updatedAt: "newer" }, { ...one, testStatus: "active", lastError: null, lastErrorAt: null }]) expect(updater(current)).toBeNull();
  });
  it.each(["resume", "drain", "quiesce"])("invalidates and reconciles every connection after runtime-wide %s", async action => {
    const a = saved(); const b = saved("other", "two"); mocks.connections.mockResolvedValue([a, b]);
    backend(action === "resume" ? { resumed: true } : { operationId: "operation-one", state: action === "drain" ? "draining" : "quiesced" }, [fixture(), { ...fixture(), profileId: "other", state: "draining" }]);
    const response = await POST(request(action, "POST", { operationId: "operation-one" }), context(action));
    expect(response.status).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(mocks.update.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    expect(mocks.update.mock.calls[1][1](b)).toMatchObject({ testStatus: "draining" });
    expect(mocks.update.mock.calls.every(([, , options]) => options.resetHealth === false)).toBe(true);
  });
  it("returns successful mutation plus warning when status persistence fails without replaying it", async () => {
    mocks.connections.mockResolvedValue([saved()]); backend(fixture());
    mocks.update.mockRejectedValue(new Error("private sqlite path"));
    const response = await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "ready", connectionStatusWarning: "Runtime state changed; connection status could not be saved. Refresh connections." });
    expect(mocks.admin.mock.calls.filter(([path]) => path === "/admin/session/verify")).toHaveLength(1);
  });
  it("returns successful mutation plus warning if the fresh readiness snapshot is unavailable", async () => {
    mocks.connections.mockResolvedValue([saved()]);
    mocks.admin.mockImplementation(async path => path === "/admin/profiles" ? new Response("private trace", { status: 503 }) : Response.json(fixture()));
    const response = await POST(request("session/verify", "POST", { profileId: "personal", revision: 3 }), context("session/verify"));
    expect(response.status).toBe(200);
    expect((await response.json()).connectionStatusWarning).toContain("Refresh connections.");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["login/complete", "login/close"])("invalidates all catalog entries for failed %s without guessing a profile from the lease", async action => {
    mocks.admin.mockImplementation(async () => Response.json({ error: { code: "login_not_found" } }, { status: 404 }));
    expect((await POST(request(action, "POST", { loginId }), context(action))).status).toBe(404);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("GET profiles and viewer polling never invalidate, persist, probe or send", async () => {
    backend(lease());
    await GET(request("profiles"), context("profiles"));
    await GET(request(`login/status?loginId=${loginId}`), context("login/status"));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.admin.mock.calls.map(([path]) => path)).toEqual(["/admin/profiles", `/admin/login/status?loginId=${loginId}`]);
  });
});

describe("managed harness admin boundaries", () => {
  const tunnelId = `tunnel_ab12_${"a".repeat(32)}`;
  const key = "fixture-runtime-key-not-a-real-secret";
  const target = () => ({ profileId: "personal", revision: 3, configRevision: 0 });
  const configure = () => ({ ...target(), tunnelId, runtimeApiKey: key });
  const status = (overrides = {}) => ({ ...target(), source: "managed", tunnelId, keyConfigured: true, buildCompatible: true, tunnelState: "ready", connectorState: "verified", canEnableFull: true, lastError: null, ...overrides });
  const mutations = ["configure", "start", "verify", "activate", "disconnect"];
  const bodyFor = name => name === "configure" ? configure() : target();

  it.each(["status", ...mutations])("requires dashboard authentication before harness/%s", async name => {
    mocks.authorize.mockResolvedValue(false);
    const action = `harness/${name}`;
    const response = name === "status" ? await GET(request(`${action}?profileId=personal`), context(action)) : await POST(request(action, "POST", bodyFor(name)), context(action));
    expect(response.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(mutations)("requires an explicit same-origin POST for harness/%s", async name => {
    const action = `harness/${name}`;
    expect((await GET(request(action), context(action))).status).toBe(405);
    for (const headers of [{ origin: "https://foreign.test" }, { "sec-fetch-site": "cross-site" }]) {
      expect((await POST(request(action, "POST", bodyFor(name), headers), context(action))).status).toBe(403);
    }
    const missingOrigin = request(action, "POST", bodyFor(name)); missingOrigin.headers.delete("origin");
    expect((await POST(missingOrigin, context(action))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("status reads one exact profile snapshot without invalidating, probing, or synchronizing connections", async () => {
    mocks.admin.mockResolvedValue(Response.json({ ...status(), runtimeApiKey: key, keyFile: "/private/key", stderr: key }));
    const response = await GET(request("harness/status?profileId=personal"), context("harness/status"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status());
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith("/admin/harness/status?profileId=personal", expect.objectContaining({ method: "GET" }), expect.any(Object));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["", "?profileId=personal&profileId=other", "?profileId=../escape", "?profileId=personal&probe=true", "?revision=3"])("rejects status query %s before contacting runtime", async suffix => {
    expect((await GET(request(`harness/status${suffix}`), context("harness/status"))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects status POST and mutation query options", async () => {
    expect((await POST(request("harness/status", "POST", target()), context("harness/status"))).status).toBe(405);
    expect((await POST(request("harness/start?probe=true", "POST", target()), context("harness/start"))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(mutations)("requires exact profile and both integer CAS revisions for harness/%s", async name => {
    const action = `harness/${name}`, good = bodyFor(name);
    for (const bad of [{ ...good, revision: undefined }, { ...good, configRevision: undefined }, { ...good, revision: -1 }, { ...good, configRevision: -1 }, { ...good, revision: 1.5 }, { ...good, configRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...good, profileId: "../escape" }, { ...good, runtimeUrl: "https://foreign.test" }, ...(name === "configure" ? [] : [{ ...good, runtimeApiKey: key }])]) {
      expect((await POST(request(action, "POST", bad), context(action))).status).toBe(400);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("trims key and complete namespaced Tunnel ID, never echoes secrets, and does not start or probe on save", async () => {
    mocks.admin.mockResolvedValue(Response.json({ ...status({ configRevision: 1, tunnelState: "stopped", connectorState: "unverified", canEnableFull: false }), runtimeApiKey: key, secretPath: "/private/key", stdout: key }));
    const response = await POST(request("harness/configure", "POST", { ...configure(), tunnelId: `  ${tunnelId}  `, runtimeApiKey: `  ${key}  ` }), context("harness/configure"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status({ configRevision: 1, tunnelState: "stopped", connectorState: "unverified", canEnableFull: false }));
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.admin.mock.calls[0][1].body)).toEqual(configure());
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("personal");
  });
  it("forwards an omitted key so the runtime can retain it, but maps first-save rejection safely without retry", async () => {
    const body = { ...target(), tunnelId };
    mocks.admin.mockResolvedValueOnce(Response.json(status()));
    expect((await POST(request("harness/configure", "POST", body), context("harness/configure"))).status).toBe(200);
    expect(JSON.parse(mocks.admin.mock.calls[0][1].body)).toEqual(body);
    mocks.admin.mockResolvedValueOnce(Response.json({ error: { code: "harness_key_required", message: key } }, { status: 400 }));
    const response = await POST(request("harness/configure", "POST", body), context("harness/configure"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "harness_key_required", message: expect.not.stringContaining(key) });
    expect(mocks.admin).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([null, "", " ", "x".repeat(31), "x".repeat(4097), "é".repeat(2049), `sk-admin-${"a".repeat(32)}`, ` ${key}\n`, `${key}\r`, `${key}\0`, `${key}\u2028`, 42])("rejects invalid runtime key without forwarding it", async runtimeApiKey => {
    const response = await POST(request("harness/configure", "POST", { ...configure(), runtimeApiKey }), context("harness/configure"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_admin_request");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([`tunnel_${"a".repeat(31)}`, `tunnel_AB12_${"a".repeat(32)}`, `tunnel_ab12_${"A".repeat(32)}`, "../tunnel", "tunnel_ab12_../../key", null])("rejects noncanonical Tunnel IDs", async value => {
    expect((await POST(request("harness/configure", "POST", { ...configure(), tunnelId: value }), context("harness/configure"))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("counts key bytes, not characters, and supports the contract bounds", async () => {
    mocks.admin.mockImplementation(async () => Response.json(status()));
    for (const runtimeApiKey of ["x".repeat(32), "x".repeat(4096), "é".repeat(2048)]) {
      expect((await POST(request("harness/configure", "POST", { ...configure(), runtimeApiKey }), context("harness/configure"))).status).toBe(200);
    }
  });
  it("requires secure credential input even for updates omitting the key and distrusts forwarding headers", async () => {
    const http = host => new Request(`http://${host}/api/providers/chatgpt-web/runtime/harness/configure`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" }, body: JSON.stringify({ ...target(), tunnelId }) });
    for (const host of ["admin.example.test", "localhost", "127.0.0.1", "[::1]"]) {
      const response = await POST(http(host), context("harness/configure"));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("secure_origin_required");
    }
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.local.mockReturnValue(true); mocks.admin.mockImplementation(async () => Response.json(status()));
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect((await POST(http(host), context("harness/configure"))).status).toBe(200);
    expect((await POST(http("admin.example.test"), context("harness/configure"))).status).toBe(403);
  });
  it("rejects encoded or oversized harness configuration before forwarding", async () => {
    expect((await POST(request("harness/configure", "POST", configure(), { "content-encoding": "gzip" }), context("harness/configure"))).status).toBe(415);
    expect((await POST(request("harness/configure", "POST", { ...configure(), runtimeApiKey: "x".repeat(32768) }), context("harness/configure"))).status).toBe(413);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["start", "verify"])("harness/%s keeps browser-only session evidence separate from harness diagnostics", async name => {
    const action = `harness/${name}`;
    mocks.admin.mockResolvedValue(Response.json(status({ connectorState: "unavailable", canEnableFull: false, lastError: { code: "connector_unavailable", message: key } })));
    const response = await POST(request(action, "POST", target()), context(action));
    expect(response.status).toBe(200);
    expect((await response.json()).lastError.message).not.toContain(key);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["activate", "disconnect"])("harness/%s returns observed profile and status and reconciles only its connection", async name => {
    const action = `harness/${name}`, updated = { ...fixture(), revision: 4, settings: { ...settings, mode: name === "activate" ? "full" : "browser-only" } };
    mocks.admin.mockImplementation(async path => Response.json(path === "/admin/profiles" ? { protocolVersion: 1, profiles: [updated] } : { profile: updated, status: status({ revision: 4 }), runtimeApiKey: key }));
    const response = await POST(request(action, "POST", target()), context(action));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: { revision: 4, settings: updated.settings }, status: status({ revision: 4 }) });
    expect(mocks.connections).toHaveBeenCalledExactlyOnceWith({ provider: "chatgpt-web" });
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("personal");
  });
  it.each(["harness_config_conflict", "harness_config_revision_conflict", "harness_config_required", "harness_operator_managed", "harness_tunnel_id_unsupported", "profile_active", "viewer_busy", "runtime_draining", "harness_compatibility_unverified", "connector_unavailable"])("maps %s without replay, DB change, or secret leakage", async code => {
    mocks.admin.mockResolvedValue(Response.json({ error: { code, message: `${key} /private/key stderr` } }, { status: 409 }));
    const response = await POST(request("harness/activate", "POST", target()), context("harness/activate"));
    expect(response.status).toBe(409);
    const data = await response.json(); expect(data.error.code).toBe(code);
    expect(JSON.stringify(data)).not.toMatch(/fixture-runtime-key|\/private\/key|stderr/);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("personal");
  });
  it.each([{ profileId: "other" }, { revision: -1 }, { configRevision: 0.5 }, { tunnelState: "healthy" }, { connectorState: "ready" }, { source: "external" }, { keyConfigured: "true" }, { buildCompatible: null }, { canEnableFull: 1 }, { tunnelId: "../private/key" }])("rejects malformed or foreign status safely", async bad => {
    mocks.admin.mockResolvedValue(Response.json(status(bad)));
    expect((await GET(request("harness/status?profileId=personal"), context("harness/status"))).status).toBe(502);
  });
  it("rejects a mismatched activate profile/status pair and never claims rollback after failed activation", async () => {
    mocks.admin.mockResolvedValueOnce(Response.json({ profile: fixture(), status: status({ revision: 4 }) }));
    expect((await POST(request("harness/activate", "POST", target()), context("harness/activate"))).status).toBe(502);
    mocks.admin.mockResolvedValueOnce(Response.json({ error: { code: "profile_probe_failed", message: key } }, { status: 502 }));
    const response = await POST(request("harness/activate", "POST", target()), context("harness/activate"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "profile_probe_failed" } });
    expect(mocks.admin).toHaveBeenCalledTimes(2);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("preserves generic capability booleans in profile rows without exposing unknown capability metadata", async () => {
    const value = fixture(); value.models[0].capabilities = { generic_tools: true, generic_responses: false, native_authority: key };
    mocks.admin.mockResolvedValue(Response.json({ profiles: [value] }));
    const response = await GET(request("profiles"), context("profiles"));
    expect((await response.json()).profiles[0].models[0].capabilities).toEqual({ generic_tools: true, generic_responses: false });
  });
});
