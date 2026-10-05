import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChatGptWebProfileNotice, isChatGptWebProfileReady, getChatGptWebRuntimeStatus, getStatusVariant } from "../../src/shared/utils/connectionStatus.js";
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => ({ requestChatGptWebRuntimeAdmin: mocks.admin }));
const { getChatGptWebProfileStates, applyChatGptWebProfileState, chatGptWebUnavailableProfileState, chatGptWebConnectionStatusUpdate, chatGptWebDiagnostic } = await import("../../src/lib/chatgptWebConnectionState.js");
const model = { id: "chatgpt-web/gpt-5.6-sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high" };
const profile = (overrides = {}) => ({ profileId: "personal", state: "ready", settings: { mode: "browser-only" }, models: [model], lastError: null, ...overrides });
const connection = () => ({ id: "one", provider: "chatgpt-web", authType: "bridge", providerSpecificData: { profileId: "personal" }, testStatus: "login_required", lastError: "old error", lastErrorAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", isActive: false, priority: 1, modelLock_any: "2099-01-01T00:00:00.000Z" });
beforeEach(() => { vi.resetAllMocks(); mocks.admin.mockImplementation(async () => Response.json({ protocolVersion: 1, profiles: [profile()] })); });

describe("ChatGPT Web readiness snapshots", () => {
  it("reads one bounded admin snapshot without probing or sending and retains only safe evidence", async () => {
    mocks.admin.mockImplementation(async () => Response.json({ protocolVersion: 1, profiles: [profile({ cookies: "fixture-cookie", accountFingerprint: "fixture-fingerprint", profileEpoch: "fixture-epoch", lastError: { code: "unknown", message: "Bearer fixture-secret" } })] }));
    const signal = new AbortController().signal;
    const states = await getChatGptWebProfileStates({ signal });
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith("/admin/profiles", { signal }, { timeoutMs: 3000 });
    expect(states.get("personal")).toMatchObject({ state: "ready", mode: "browser-only", models: [model], lastError: { code: "runtime_error" } });
    expect(JSON.stringify([...states.values()])).not.toMatch(/fixture-cookie|fixture-fingerprint|fixture-epoch|fixture-secret|Bearer/);
  });
  it.each([
    { profiles: [profile()] },
    { protocolVersion: 2, profiles: [profile()] },
    { protocolVersion: 1, profiles: [profile({ state: "invented" })] },
    { protocolVersion: 1, profiles: [profile({ profileId: "../escape" })] },
    { protocolVersion: 1, profiles: [profile({ settings: { mode: "invented" } })] },
    { protocolVersion: 1, profiles: [profile({ models: [{ ...model, id: "not-a-verified-route" }] })] },
    { protocolVersion: 1, profiles: [profile({ models: [{ ...model, supported_reasoning_levels: [] }] })] },
    { protocolVersion: 1, profiles: [profile(), profile()] },
  ])("rejects malformed readiness evidence safely: %j", async body => {
    mocks.admin.mockImplementation(async () => Response.json(body));
    await expect(getChatGptWebProfileStates()).rejects.toMatchObject({ code: "runtime_unavailable", message: "Runtime unavailable. Refresh connections after the runtime recovers." });
  });
  it("maps offline, invalid JSON and oversized streams to the same safe unavailable error", async () => {
    for (const response of [new Response("private runtime trace", { status: 503 }), new Response("{"), new Response("x".repeat(262145))]) {
      mocks.admin.mockResolvedValueOnce(response);
      await expect(getChatGptWebProfileStates()).rejects.toMatchObject({ code: "runtime_unavailable" });
    }
    mocks.admin.mockRejectedValueOnce(new Error("operator secret path"));
    await expect(getChatGptWebProfileStates()).rejects.toThrow("Runtime unavailable. Refresh connections after the runtime recovers.");
  });
});

describe("connection readiness mapping", () => {
  it("repairs stale login_required display without touching disablement, selectors, priorities or quota locks", () => {
    const saved = connection();
    const mapped = applyChatGptWebProfileState(saved, profile());
    expect(mapped).toMatchObject({ testStatus: "active", lastError: null, lastErrorAt: null, isActive: false, priority: 1, modelLock_any: saved.modelLock_any, providerSpecificData: saved.providerSpecificData, chatGptWebRuntime: { state: "ready", mode: "browser-only", lastError: null } });
    expect(saved.testStatus).toBe("login_required");
    expect(Object.keys(mapped.chatGptWebRuntime)).toEqual(["state", "mode", "lastError"]);
  });
  it.each([
    ["waiting_for_chatgpt_tool_approval", "active", "waiting_for_chatgpt_tool_approval"],
    ["login_required", "login_required", "login_required"],
    ["unconfigured", "login_required", "profile_not_found"],
    ["probing", "probing", null],
    ["draining", "draining", "runtime_draining"],
    ["error", "error", "runtime_error"],
  ])("maps %s to %s without claiming readiness", (state, status, code) => {
    const mapped = applyChatGptWebProfileState(connection(), profile({ state }));
    expect(mapped.testStatus).toBe(status);
    expect(mapped.chatGptWebRuntime.lastError?.code || null).toBe(code);
  });
  it.each(["ready", "waiting_for_chatgpt_tool_approval"])("requires model evidence even when runtime reports %s", state => {
    expect(applyChatGptWebProfileState(connection(), profile({ state, models: [] }))).toMatchObject({ testStatus: "error", chatGptWebRuntime: { state: "error", lastError: { code: "model_version_unavailable" } } });
  });
  it("distinguishes a missing profile from an unavailable runtime", () => {
    expect(applyChatGptWebProfileState(connection(), undefined)).toMatchObject({ testStatus: "login_required", chatGptWebRuntime: { state: "unconfigured", mode: null, lastError: { code: "profile_not_found" } } });
    expect(applyChatGptWebProfileState(connection(), chatGptWebUnavailableProfileState())).toMatchObject({ testStatus: "error", chatGptWebRuntime: { state: "error", mode: null, lastError: { code: "runtime_unavailable" } } });
  });
  it("does not manufacture a new timestamp on each read-only poll", () => {
    const saved = connection();
    const first = applyChatGptWebProfileState(saved, profile({ state: "login_required" }));
    expect(applyChatGptWebProfileState(saved, profile({ state: "login_required" })).lastErrorAt).toBe(first.lastErrorAt);
    expect(applyChatGptWebProfileState(first, profile({ state: "login_required" })).lastErrorAt).toBe(first.lastErrorAt);
    expect(applyChatGptWebProfileState(first, profile()).lastErrorAt).toBeNull();
  });
  it("writes only status fields for the same optimistic snapshot and skips unchanged values", () => {
    const saved = connection();
    expect(chatGptWebConnectionStatusUpdate(saved, saved, profile())).toEqual({ testStatus: "active", lastError: null, lastErrorAt: null });
    const active = { ...saved, testStatus: "active", lastError: null, lastErrorAt: null };
    expect(chatGptWebConnectionStatusUpdate(active, active, profile())).toBeNull();
    for (const changed of [null, { ...saved, provider: "other" }, { ...saved, updatedAt: "newer" }, { ...saved, providerSpecificData: { profileId: "other" } }]) {
      expect(chatGptWebConnectionStatusUpdate(changed, saved, profile())).toBeNull();
    }
  });
  it("preserves an existing error timestamp and records time only on a persisted error transition", () => {
    const saved = connection();
    const same = { ...saved, lastError: chatGptWebDiagnostic("login_required").message };
    expect(chatGptWebConnectionStatusUpdate(same, same, profile({ state: "login_required" }))).toBeNull();
    const before = Date.now();
    const patch = chatGptWebConnectionStatusUpdate(saved, saved, profile({ state: "login_required" }));
    expect(Date.parse(patch.lastErrorAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("dashboard readiness presentation", () => {
  it("never treats a completed browser lease as verified profile readiness", () => {
    const completedLease = { state: "completed", loginId: "fixture-lease" };
    expect(isChatGptWebProfileReady(completedLease)).toBe(false);
    expect(getChatGptWebProfileNotice(completedLease)).not.toBe("Connected and ready.");
    expect(getChatGptWebProfileNotice(profile({ models: [] }))).toContain("No verified models");
    expect(getChatGptWebProfileNotice(profile())).toBe("Connected and ready.");
  });
  it("changes a ready notice immediately when the fresh profile loses readiness", () => {
    expect(getChatGptWebProfileNotice(profile())).toBe("Connected and ready.");
    const notReady = profile({ state: "login_required", models: [], lastError: { code: "login_required", message: "Sign in using the private browser." } });
    expect(getChatGptWebProfileNotice(notReady)).toBe("Sign in using the private browser.");
    expect(getChatGptWebProfileNotice(profile())).toBe("Connected and ready.");
    expect(getChatGptWebProfileNotice(undefined)).toContain("unavailable");
  });
  it("uses runtime state rather than saved testStatus and preserves disabled presentation", () => {
    expect(getChatGptWebRuntimeStatus("ready")).toBe("active");
    expect(getChatGptWebRuntimeStatus("waiting_for_chatgpt_tool_approval")).toBe("active");
    expect(getChatGptWebRuntimeStatus("login_required")).toBe("login_required");
    expect(getChatGptWebRuntimeStatus("unconfigured")).toBe("login_required");
    expect(getChatGptWebRuntimeStatus("draining")).toBe("draining");
    expect(getChatGptWebRuntimeStatus(undefined)).toBe("error");
    expect(getStatusVariant(false, getChatGptWebRuntimeStatus("ready"))).toBe("default");
  });
});
