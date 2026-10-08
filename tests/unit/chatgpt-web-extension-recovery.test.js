import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Execute the shipped popup state machine, not a second implementation. These
// deterministic Chrome/DOM boundaries complement the actual Chromium smoke.
const popupSource = readFileSync(new URL("../../tools/chatgpt-web-session-export/popup.js", import.meta.url), "utf8").split("\n").slice(2).join("\n");
const backgroundSource = readFileSync(new URL("../../tools/chatgpt-web-session-export/background.js", import.meta.url), "utf8").split("\n").slice(2).join("\n").replaceAll("export ", "");
function events() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) || [])]) fn(...args); },
  };
}
function chromeEvent() {
  const event = events();
  return { addListener: fn => event.addEventListener("event", fn), removeListener: fn => event.removeEventListener("event", fn), emit: (...args) => event.emit("event", ...args) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function target(overrides = {}) {
  return { version: 1, attemptId: "00000000-0000-4000-8000-000000000001", profileId: "fixture", revision: 1, connectionName: "Offline connection", expiresAt: new Date(Date.now() + 300000).toISOString(), ...overrides };
}
function snapshot(value = target(), documentId = "document-one") {
  return [{ frameId: 0, documentId, result: { ok: true, origin: "https://router.example", target: value } }];
}
function popupHarness(initial = [{ frameId: 0, documentId: "document-one", result: { ok: false, code: "session_target_unprepared" } }]) {
  const elements = new Map(["connect", "check", "copy", "export", "status", "target-help", "origin", "connection-name", "profile-id"].map(id => [id, { ...events(), disabled: id === "connect", textContent: "" }]));
  const document = { ...events(), visibilityState: "visible", getElementById: id => elements.get(id) };
  const window = events();
  const state = { tabId: 10, result: initial };
  const chrome = {
    tabs: { query: vi.fn(async () => [{ id: state.tabId }]), onActivated: chromeEvent(), onUpdated: chromeEvent() },
    scripting: { executeScript: vi.fn(async () => state.result) },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  };
  const collectChatGptSession = vi.fn();
  const context = createContext({ document, window, chrome, collectChatGptSession, inspectDashboard: vi.fn(), Date, setInterval, clearInterval, setTimeout, clearTimeout });
  runInContext(popupSource, context);
  return { elements, document, window, state, chrome, collectChatGptSession, close: () => window.emit("pagehide") };
}
let harnesses;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z")); harnesses = []; });
afterEach(() => { for (const harness of harnesses) harness.close(); vi.useRealTimers(); });
function popup(initial) { const harness = popupHarness(initial); harnesses.push(harness); return harness; }

describe("ChatGPT session helper read-only recovery", () => {
  it("rejects a target replacement between pointer or keyboard activation and click", async () => {
    for (const gesture of ["pointerdown", "keydown"]) {
      const h = popup(snapshot()); await flush();
      h.elements.get("connect").emit(gesture, { key: "Enter" });
      h.state.result = snapshot(target({ profileId: "different", connectionName: "Different connection", attemptId: "00000000-0000-4000-8000-000000000002" }));
      await vi.advanceTimersByTimeAsync(1000); await flush();
      h.elements.get("connect").emit("click"); await flush();
      expect(h.chrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(h.collectChatGptSession).not.toHaveBeenCalled();
      expect(h.elements.get("connect").disabled).toBe(true);
    }
  });
  it("recovers from opening before preparation without cookies or POST until a single explicit click", async () => {
    const h = popup();
    await flush();
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.elements.get("target-help").textContent).toContain("Prepare connection");
    expect(h.elements.get("check").disabled).toBe(false);
    h.state.result = snapshot();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(h.elements.get("connect").disabled).toBe(false);
    expect(h.elements.get("origin").textContent).toBe("https://router.example");
    expect(h.collectChatGptSession).not.toHaveBeenCalled();
    expect(h.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    const pending = deferred();
    h.chrome.runtime.sendMessage.mockReturnValueOnce(pending.promise);
    h.elements.get("connect").emit("click");
    h.elements.get("connect").emit("click");
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.chrome.runtime.sendMessage.mock.calls[0][0]).toMatchObject({ type: "connect-chatgpt-session", tabId: 10, documentId: "document-one", target: { profileId: "fixture" } });
    const reads = h.chrome.scripting.executeScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(reads);
    pending.resolve({ ok: false, code: "import_result_unknown" });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.elements.get("status").textContent).toContain("Nothing was replayed");
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    h.state.result = snapshot(target({ attemptId: "00000000-0000-4000-8000-000000000002" }));
    h.elements.get("check").emit("click");
    await flush();
    expect(h.elements.get("connect").disabled).toBe(false);
  });

  it("bounds probes to one in-flight and rejects a stale read after focus/tab change", async () => {
    const h = popup();
    const pending = deferred();
    h.chrome.scripting.executeScript.mockReturnValueOnce(pending.promise);
    await flush();
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    h.state.tabId = 11;
    h.state.result = snapshot(target({ connectionName: "New connection", profileId: "new-profile" }), "document-two");
    h.window.emit("focus");
    h.chrome.tabs.onActivated.emit({ tabId: 11 });
    h.elements.get("check").emit("click");
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(h.elements.get("connect").disabled).toBe(true);
    pending.resolve(snapshot());
    await flush();
    expect(h.elements.get("connection-name").textContent).toBe("New connection");
    expect(h.elements.get("connect").disabled).toBe(false);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
    expect(h.collectChatGptSession).not.toHaveBeenCalled();
  });

  it("drops a result when the document changes during the exact-document confirmation", async () => {
    const h = popup(snapshot());
    h.chrome.scripting.executeScript.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(target(), "document-two"));
    await flush();
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.elements.get("origin").textContent).toBe("Unavailable");
    expect(h.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("clears published consent before reading a changed profile or blocked target", async () => {
    const h = popup(snapshot());
    await flush();
    expect(h.elements.get("connect").disabled).toBe(false);
    h.state.result = [{ frameId: 0, documentId: "document-one", result: { ok: false, code: "session_target_blocked", reason: "unsaved_changes" } }];
    h.elements.get("check").emit("click");
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.elements.get("origin").textContent).toBe("Unavailable");
    await flush();
    expect(h.elements.get("target-help").textContent).toContain("Save or discard");
    expect(h.collectChatGptSession).not.toHaveBeenCalled();
  });

  it("expires a visible target even while a slow read is pending", async () => {
    const h = popup(snapshot(target({ expiresAt: new Date(Date.now() + 500).toISOString() })));
    await flush();
    expect(h.elements.get("connect").disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.elements.get("target-help").textContent).toContain("expired");
    h.elements.get("connect").emit("click");
    expect(h.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts an explicit Connect after focus while a read-only refresh is in flight", async () => {
    const h = popup(snapshot());
    await flush();
    const pending = deferred();
    h.chrome.scripting.executeScript.mockReturnValueOnce(pending.promise);
    h.window.emit("focus");
    h.elements.get("connect").emit("click");
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot());
    await flush();
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps a confirmed snapshot clickable during periodic metadata reads but expires it while pending", async () => {
    const h = popup(snapshot(target({ expiresAt: new Date(Date.now() + 1500).toISOString() })));
    await flush();
    const pending = deferred();
    h.chrome.scripting.executeScript.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.elements.get("connect").disabled).toBe(false);
    expect(h.elements.get("origin").textContent).toBe("https://router.example");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.elements.get("connect").disabled).toBe(true);
    h.elements.get("connect").emit("click");
    expect(h.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    pending.resolve(snapshot());await flush();
  });

  it("stops reads while hidden, resumes when visible, and drops late results after pagehide", async () => {
    const h = popup(snapshot());
    await flush();
    h.document.visibilityState = "hidden";
    h.document.emit("visibilitychange");
    const reads = h.chrome.scripting.executeScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(reads);
    expect(h.elements.get("connect").disabled).toBe(true);
    h.document.visibilityState = "visible";
    h.document.emit("visibilitychange");
    await flush();
    expect(h.elements.get("connect").disabled).toBe(false);
    const pending = deferred();
    h.chrome.scripting.executeScript.mockReturnValueOnce(pending.promise);
    h.window.emit("focus");
    await flush();
    h.close();
    pending.resolve(snapshot());
    await flush();
    const stopped = h.chrome.scripting.executeScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    h.chrome.tabs.onActivated.emit({ tabId: 12 });
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(stopped);
    expect(h.elements.get("connect").disabled).toBe(true);
    expect(h.collectChatGptSession).not.toHaveBeenCalled();
  });
});

function inspectionHarness({ pathname = "/dashboard/providers/chatgpt-web", protocol = "https:", hostname = "router.example", assistants = [], markers = [] } = {}) {
  const document = { querySelectorAll: selector => selector.includes("session-assistant") ? assistants : markers };
  const window = {}; window.top = window;
  const location = { pathname, protocol, hostname, origin: `${protocol}//${hostname}` };
  const fetch = vi.fn();
  const context = createContext({ document, window, location, fetch, Date });
  runInContext(backgroundSource, context);
  return { inspect: options => context.inspectDashboard(options), fetch };
}
const assistant = reason => ({ getAttribute: () => JSON.stringify({ version: 1, reason }) });
function marker(value = target(), { disabled = false, consumed = false, inputCount = 1 } = {}) {
  const input = { type: "file", disabled, isConnected: true };
  return { isConnected: true, getAttribute: name => name.endsWith("consumed") ? String(consumed) : JSON.stringify(value), querySelectorAll: () => Array(inputCount).fill(input) };
}
describe("serialized dashboard target discovery", () => {
  it.each([
    [{ pathname: "/" }, "dashboard_tab_required"],
    [{ protocol: "http:" }, "secure_origin_required"],
    [{}, "session_assistant_required"],
    [{ assistants: [assistant(null)] }, "session_target_unprepared"],
    [{ assistants: [assistant("loading")] }, "session_target_blocked"],
    [{ assistants: [assistant("expired")] }, "session_target_expired"],
    [{ assistants: [assistant("consumed")] }, "session_import_in_progress"],
    [{ markers: [marker(), marker()] }, "session_target_ambiguous"],
    [{ markers: [marker(target(), { disabled: true })] }, "session_target_blocked"],
    [{ markers: [marker(target(), { inputCount: 2 })] }, "session_target_ambiguous"],
  ])("distinguishes unavailable targets without reading cookies or profiles: %j", async (options, code) => {
    const h = inspectionHarness(options);
    expect(await h.inspect()).toMatchObject({ ok: false, code });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("never treats assistant metadata as target authority", async () => {
    const h = inspectionHarness({ assistants: [{ getAttribute: () => JSON.stringify({ version: 1, reason: null, ...target(), endpoint: "https://attacker.example" }) }] });
    expect(await h.inspect()).toMatchObject({ ok: false, code: "session_target_unprepared" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("keeps expiry, consumed, exact revision and authenticated same-origin checks", async () => {
    expect(await inspectionHarness({ markers: [marker(target({ expiresAt: new Date(Date.now() - 1).toISOString() }))] }).inspect()).toMatchObject({ code: "session_target_expired" });
    expect(await inspectionHarness({ markers: [marker(target(), { consumed: true })] }).inspect()).toMatchObject({ code: "session_import_in_progress" });
    const h = inspectionHarness({ markers: [marker()] });
    h.fetch.mockResolvedValue({ status: 200, ok: true, headers: { get: () => "application/json" }, json: async () => ({ profiles: [{ profileId: "fixture", revision: 2, activeTurns: 0, state: "ready" }] }) });
    expect(await h.inspect({ expected: target(), origin: "https://router.example", checkProfiles: true })).toMatchObject({ code: "profile_revision_conflict" });
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith("/api/providers/chatgpt-web/runtime/profiles", { credentials: "same-origin", cache: "no-store", redirect: "error" });
    h.fetch.mockResolvedValueOnce({ status: 401 });
    expect(await h.inspect({ checkProfiles: true })).toMatchObject({ code: "dashboard_auth_required" });
  });
});

function workerHarness() {
  const state = { tabId: 10 };
  const chrome = {
    windows: { getLastFocused: vi.fn(async () => ({ id: 1, type: "normal" })) },
    tabs: { query: vi.fn(async () => [{ id: state.tabId }]) },
    scripting: { executeScript: vi.fn(async ({ func }) => [{ frameId: 0, documentId: "document-one", result: func.name === "handoffSession" ? { ok: true } : { ok: true, origin: "https://router.example", target: target() } }]) },
  };
  const collectChatGptSession = vi.fn(async () => ({ format: "9router-chatgpt-session", version: 1, cookies: [] }));
  const context = createContext({ document: {}, chrome, collectChatGptSession, TextEncoder, MAX_SESSION_TRANSFER_BYTES: 262144, SessionTransferError: class extends Error {} });
  runInContext(backgroundSource, context);
  const connect = () => { context.message = { tabId: 10, documentId: "document-one", origin: "https://router.example", target: target() }; return runInContext("connect(message)", context); };
  return { state, chrome, collectChatGptSession, connect };
}
describe("worker explicit consent boundaries", () => {
  it("checks the authenticated exact document before and after one cookie collection", async () => {
    const h = workerHarness();
    expect(await h.connect()).toMatchObject({ ok: true });
    expect(h.collectChatGptSession).toHaveBeenCalledTimes(1);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
    for (const [call] of h.chrome.scripting.executeScript.mock.calls.slice(0, 2)) {
      expect(call).toMatchObject({ target: { tabId: 10, documentIds: ["document-one"] }, world: "ISOLATED", args: [{ origin: "https://router.example", checkProfiles: true, expected: { profileId: "fixture", revision: 1 } }] });
    }
  });
  it("rejects switched tabs before cookies and switches after cookies before handoff", async () => {
    const first = workerHarness(); first.state.tabId = 11;
    expect(await first.connect()).toMatchObject({ ok: false });
    expect(first.collectChatGptSession).not.toHaveBeenCalled();
    const second = workerHarness();
    second.collectChatGptSession.mockImplementationOnce(async () => { second.state.tabId = 11; return { cookies: [] }; });
    expect(await second.connect()).toMatchObject({ ok: false });
    expect(second.collectChatGptSession).toHaveBeenCalledTimes(1);
    expect(second.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
  it("keeps duplicate clicks single-flight while the original cookie collection settles", async () => {
    const h = workerHarness(), pending = deferred();
    h.collectChatGptSession.mockReturnValueOnce(pending.promise);
    const original = h.connect(); await flush();
    expect(await h.connect()).toMatchObject({ ok: false, code: "session_import_in_progress" });
    pending.resolve({ cookies: [] });
    expect(await original).toMatchObject({ ok: true });
    expect(h.collectChatGptSession).toHaveBeenCalledTimes(1);
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
  });
});
