import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/browser/manager";
import { startRuntime } from "../src/server";
import type { RuntimeService } from "../src/server";
import { RuntimeState } from "../src/runtime-state";
import type { BrowserContext } from "playwright-core";
import { parseChatGptWebSessionTransfer, readChatGptWebSessionImport, MAX_SESSION_TRANSFER_BYTES, SessionTransferError } from "../session-transfer.js";

const executablePath = process.env.CGW_CHROMIUM_EXECUTABLE;
const html = await Bun.file(new URL("./fixtures/chatgpt-runtime.html", import.meta.url)).text();
const fixtureCookies = (identity = "account-a") => [
  { name: "cgw_fixture_session.0", value: identity, domain: "chatgpt.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: "Lax" as const },
  { name: "cgw_fixture_session.1", value: "-session", domain: ".chatgpt.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: "None" as const },
];
const transfer = (cookies: unknown[] = fixtureCookies()) => ({ format: "9router-chatgpt-session", version: 1, cookies });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-session-proof-"));
  const config = { dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: executablePath!,
    runtimeToken: Buffer.from("fixture-data-token"), adminToken: Buffer.from("fixture-admin-token") };
  const runtime = startRuntime(config); await runtime.initialized;
  const display = spyOn(runtime.profiles as unknown as { ensureDisplay(id: string): Promise<void> }, "ensureDisplay").mockResolvedValue();
  // Only headed display ownership is replaced. Persistent Chromium, cookie storage,
  // maintenance fencing, session identity, DOM proof and HTTP handling are real.
  const managers = spyOn(runtime.profiles, "manager").mockImplementation(profileId => {
    const profile = runtime.state.profile(profileId);
    return BrowserManager.forProfile({ profileId, profileEpoch: profile.epoch, browserProfilePath: join(root, "profiles", profileId, "browser"), chromeExecutablePath: executablePath!, headed: false });
  });
  runtime.state.createProfile("synthetic");
  let providerSends = 0;
  const intercept = async (context: BrowserContext) => {
    await context.addInitScript(() => { Object.assign(window, { __cgwLoginFixture: { semanticSlider: true, headerOnlyModel: true, pointerOnly: true } }); });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === "https://chatgpt.com" && url.pathname === "/api/auth/session") {
        const cookies = route.request().headers().cookie ?? "";
        const first = /(?:^|;\s*)cgw_fixture_session\.0=([^;]*)/.exec(cookies)?.[1];
        const second = /(?:^|;\s*)cgw_fixture_session\.1=([^;]*)/.exec(cookies)?.[1];
        const session = first && second ? { user: { id: first + second }, expires: new Date(Date.now() + 3600_000).toISOString() } : {};
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(session) });
      } else if (url.origin === "https://chatgpt.com" && url.pathname === "/" && route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body: html });
      } else {
        if (route.request().method() === "POST") providerSends++;
        await route.abort();
      }
    });
  };
  const manager = runtime.profiles.manager("synthetic");
  const context = await manager.ensureContext(); await intercept(context);
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const admin = (path: string, body?: unknown, token = config.adminToken.toString(), method = body === undefined ? "GET" : "POST") => fetch(`${url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { runtime, root, config, manager, context, admin, intercept, providerSends: () => providerSends,
    async close() { managers.mockRestore(); display.mockRestore(); await runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe.skipIf(!executablePath)("verified saved ChatGPT sessions", () => {
  test("first account commit failure after live model evidence restores cookies and leaves identity untouched", async () => {
    const f = await fixture();
    const identity = f.runtime.state.profile("synthetic");
    const snapshot = await f.context.cookies();
    const marker = "fixture-secret-account-commit-cause";
    const observe = spyOn(f.runtime.state, "observeAccount").mockImplementation(() => { throw new Error(marker); });
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: 1, session: transfer() });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(marker);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(f.runtime.state.profile("synthetic")).toEqual(identity);
      expect(await f.context.cookies()).toEqual(snapshot);
      expect(f.runtime.profiles.ready("synthetic")).toBe(false);
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(marker);
      expect(JSON.parse(String(diagnostics.mock.calls[0]![0]))).toMatchObject({ stage: "account_commit", code: "profile_probe_failed" });
      expect(f.providerSends()).toBe(0);
    } finally { diagnostics.mockRestore(); observe.mockRestore(); await f.close(); }
  }, 90_000);
  test("HTTP import authenticates a new account without native login, then explicit verify reuses it", async () => {
    const f = await fixture();
    try {
      const input = transfer([...fixtureCookies(), { name: "session-only", value: "fixture-session-secret", domain: "chatgpt.com", path: "/", expires: -1, secure: true, httpOnly: true }]);
      const body = { profileId: "synthetic", revision: 1, session: input };
      expect((await f.admin("/admin/session/import", body, f.config.runtimeToken.toString())).status).toBe(401);
      expect((await f.admin("/admin/session/import")).status).toBe(405);
      const extra = await f.context.newPage(); await extra.goto("https://chatgpt.com/?temporary-chat=true");
      const response = await f.admin("/admin/session/import", body);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const serialized = await response.text();
      expect(serialized).not.toContain("fixture-session-secret"); expect(serialized).not.toContain("accountFingerprint"); expect(serialized).not.toContain("cookies");
      expect(JSON.parse(serialized)).toMatchObject({ state: "ready", profileId: "synthetic" });
      expect(f.context.pages()).toHaveLength(1);
      const saved = await f.context.cookies();
      expect(saved.find(cookie => cookie.name === "session-only")).toMatchObject({ expires: -1, httpOnly: true, secure: true });
      expect(saved.filter(cookie => cookie.name.startsWith("cgw_fixture_session.")).length).toBe(2);
      const identity = f.runtime.state.profile("synthetic");
      expect(await f.runtime.profiles.verifySession("synthetic", identity.revision)).toMatchObject({ state: "ready" });
      expect(f.runtime.state.profile("synthetic")).toEqual(identity);
      expect(f.runtime.profiles.physicalIdle()).toBe(true);
      expect(f.providerSends()).toBe(0);
      expect(await (await f.manager.maintenancePage()).evaluate(() => Reflect.get(window, "fixture").sends)).toBe(0);
    } finally { await f.close(); }
  }, 120_000);

  test("account mismatch and invalid authentication rollback cookies without changing identity or bindings", async () => {
    const f = await fixture();
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.context.addCookies(fixtureCookies()); await f.runtime.profiles.verifySession("synthetic", 1);
      const identity = f.runtime.state.profile("synthetic");
      const snapshot = await f.context.cookies();
      const binding = f.runtime.state.resolveBinding({ clientId: "fixture-client", threadId: "fixture-thread", candidateProfileIds: ["synthetic"], ready: id => f.runtime.profiles.ready(id) });
      for (const scenario of ["account", "signed-out"] as const) {
        const input = scenario === "account" ? transfer(fixtureCookies("fixture-secret-other-account")) : transfer([{ ...fixtureCookies()[0]!, name: "not-authenticated", value: "fixture-secret-invalid-session" }]);
        const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: identity.revision, session: input });
        expect(response.status).toBe(409);
        const serialized = await response.text();
        expect(JSON.parse(serialized).error.code).toBe(scenario === "account" ? "session_account_mismatch" : "login_required");
        expect(serialized).not.toContain("fixture-secret");
        expect(await f.context.cookies()).toEqual(snapshot);
        expect(f.runtime.state.profile("synthetic")).toEqual(identity);
        expect(f.runtime.state.binding("fixture-client", "fixture-thread")).toEqual(binding);
        expect(f.runtime.profiles.ready("synthetic")).toBe(false);
        expect(await f.runtime.profiles.verifySession("synthetic", identity.revision)).toMatchObject({ state: "ready" });
      }
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("fixture-secret");
      expect(f.providerSends()).toBe(0);
    } finally { diagnostics.mockRestore(); await f.close(); }
  }, 120_000);

  test("a failed inspection page cannot prevent account-mismatch cookie restoration", async () => {
    const f = await fixture();
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.context.addCookies(fixtureCookies()); await f.runtime.profiles.verifySession("synthetic", 1);
      const identity = f.runtime.state.profile("synthetic"); const snapshot = await f.context.cookies();
      const page = await f.manager.maintenancePage();
      const goto = page.goto.bind(page); let blanks = 0;
      const navigation = spyOn(page, "goto").mockImplementation(async (url, options) => {
        if (url === "about:blank" && ++blanks === 2) { await page.close(); throw new Error("fixture-secret-closed-inspection"); }
        return goto(url, options);
      });
      try {
        const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: identity.revision, session: transfer(fixtureCookies("account-b")) });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe("session_account_mismatch");
        expect(await f.context.cookies()).toEqual(snapshot);
        expect(f.runtime.state.profile("synthetic")).toEqual(identity);
        expect(f.runtime.profiles.ready("synthetic")).toBe(false);
        expect(await f.runtime.profiles.verifySession("synthetic", identity.revision)).toMatchObject({ state: "ready" });
        expect(f.runtime.state.profile("synthetic")).toEqual(identity);
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("fixture-secret");
      } finally { navigation.mockRestore(); }
    } finally { diagnostics.mockRestore(); await f.close(); }
  }, 90_000);

  test("schema and import preflight errors never mutate cookie storage", async () => {
    const f = await fixture();
    try {
      await f.context.addCookies(fixtureCookies());
      const snapshot = await f.context.cookies();
      const clear = spyOn(f.context, "clearCookies");
      const input = transfer();
      try {
        for (const session of [transfer([{ ...fixtureCookies()[0]!, domain: "google.com" }]), transfer([fixtureCookies()[0]!, fixtureCookies()[0]!]), transfer([{ ...fixtureCookies()[0]!, expires: 1 }]), { ...input, unknown: true }]) {
          const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: 1, session });
          expect(response.status).toBe(400);
        }
        await expect(f.runtime.profiles.importSession("missing", 1, input)).rejects.toMatchObject({ code: "profile_not_found", status: 404 });
        await expect(f.runtime.profiles.importSession("synthetic", 2, input)).rejects.toMatchObject({ code: "profile_revision_conflict", status: 409 });
        let settle!: () => void;
        const turn = f.manager.run("active-import", () => new Promise<void>(resolve => { settle = resolve; })); await Promise.resolve();
        try { await expect(f.runtime.profiles.importSession("synthetic", 1, input)).rejects.toMatchObject({ code: "profile_active", status: 409 }); }
        finally { settle(); await turn; }
        const internals = f.runtime.profiles as unknown as { viewer?: { profileId: string }; viewerStarting: boolean; viewerClosing?: Promise<void> };
        internals.viewer = { profileId: "synthetic" };
        try { await expect(f.runtime.profiles.importSession("synthetic", 1, input)).rejects.toMatchObject({ code: "profile_active" }); }
        finally { internals.viewer = undefined; }
        internals.viewerStarting = true;
        try { await expect(f.runtime.profiles.importSession("synthetic", 1, input)).rejects.toMatchObject({ code: "profile_active" }); }
        finally { internals.viewerStarting = false; }
        internals.viewerClosing = Promise.resolve();
        try { await expect(f.runtime.profiles.importSession("synthetic", 1, input)).rejects.toMatchObject({ code: "profile_active" }); }
        finally { internals.viewerClosing = undefined; }
        f.runtime.state.drain("fixture-import-fence");
        await expect(f.runtime.profiles.importSession("synthetic", 1, input)).rejects.toMatchObject({ code: "runtime_draining", status: 503 });
        expect(clear).not.toHaveBeenCalled(); expect(await f.context.cookies()).toEqual(snapshot);
        expect(f.runtime.state.profile("synthetic").revision).toBe(1);
      } finally { clear.mockRestore(); }
    } finally { await f.close(); }
  }, 90_000);

  test("typed UI failure after authentication restores the snapshot and remains not-ready", async () => {
    const f = await fixture();
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.context.addCookies(fixtureCookies()); await f.runtime.profiles.verifySession("synthetic", 1);
      const identity = f.runtime.state.profile("synthetic"); const snapshot = await f.context.cookies();
      await f.context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
        const form = document.querySelector("form"); if (form) form.after(form.cloneNode(true));
      }));
      const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: identity.revision, session: transfer() });
      expect(response.status).toBe(502); expect((await response.json()).error.code).toBe("profile_probe_failed");
      expect(await f.context.cookies()).toEqual(snapshot);
      expect(f.runtime.state.profile("synthetic")).toEqual(identity);
      expect(f.runtime.profiles.ready("synthetic")).toBe(false);
      expect(f.providerSends()).toBe(0);
    } finally { diagnostics.mockRestore(); await f.close(); }
  }, 90_000);

  test("HTTP bounded import rejects streamed oversize, malformed JSON and media without touching cookies", async () => {
    const f = await fixture();
    const clear = spyOn(f.context, "clearCookies");
    const url = `http://127.0.0.1:${f.runtime.server.port}/admin/session/import`;
    try {
      for (const [contentType, encoding, body, status, code] of [
        ["text/plain", "identity", "{}", 415, "invalid_session_transfer"],
        ["application/json", "gzip", "{}", 415, "invalid_session_transfer"],
        ["application/json", "identity", "{", 400, "invalid_session_transfer"],
      ] as const) {
        const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.config.adminToken}`, "content-type": contentType, "content-encoding": encoding }, body });
        expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store"); expect((await response.json()).error.code).toBe(code);
      }
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_SESSION_TRANSFER_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.config.adminToken}`, "content-type": "application/json" }, body: stream });
      expect(response.status).toBe(413); expect((await response.json()).error.code).toBe("session_transfer_too_large");
      expect(clear).not.toHaveBeenCalled();
    } finally { clear.mockRestore(); await f.close(); }
  }, 90_000);

  test("all cookie replacement failures rollback and failed rollback settles outside maintenance", async () => {
    for (const boundary of ["snapshot", "clear", "add", "restore"] as const) {
      const f = await fixture();
      const spies: { mockRestore(): void }[] = [];
      try {
        await f.context.addCookies(fixtureCookies()); await f.runtime.profiles.verifySession("synthetic", 1);
        const identity = f.runtime.state.profile("synthetic"); const snapshot = await f.context.cookies();
        const realAdd = f.context.addCookies.bind(f.context); const realClear = f.context.clearCookies.bind(f.context);
        let adds = 0, clears = 0;
        const marker = "fixture-secret-boundary-cause";
        if (boundary === "snapshot") spies.push(spyOn(f.context, "cookies").mockRejectedValue(new Error(marker)));
        else if (boundary === "clear") spies.push(spyOn(f.context, "clearCookies").mockImplementation(async options => {
          await realClear(options); if (++clears === 1) throw new Error(marker);
        }));
        else spies.push(spyOn(f.context, "addCookies").mockImplementation(async cookies => {
          adds++; if (boundary === "restore" || adds === 1) throw new Error(marker); await realAdd(cookies);
        }));
        const clear = spyOn(f.context, "clearCookies"); spies.push(clear);
        const response = await f.admin("/admin/session/import", { profileId: "synthetic", revision: identity.revision, session: transfer() });
        expect(response.status).toBe(boundary === "restore" ? 503 : boundary === "add" ? 400 : 500);
        const serialized = await response.text(); expect(serialized).not.toContain(marker);
        if (boundary === "restore") {
          expect(JSON.parse(serialized).error.code).toBe("session_restore_failed");
          expect(f.runtime.profiles.status("synthetic")).toMatchObject({ state: "error", lastError: "session_restore_failed" });
          expect(f.context.pages()).toHaveLength(0);
        } else if (boundary === "snapshot") expect(clear).not.toHaveBeenCalled();
        else expect(await f.context.cookies()).toEqual(snapshot);
        expect(f.runtime.state.profile("synthetic")).toEqual(identity);
        if (boundary !== "snapshot") expect(f.runtime.profiles.ready("synthetic")).toBe(false);
      } finally { for (const spy of spies) spy.mockRestore(); await f.close(); }
    }
  }, 120_000);
  test("explicit verify uses persisted HttpOnly multipart cookies and survives full runtime restart", async () => {
    const f = await fixture();
    let second: RuntimeService | undefined;
    let display: { mockRestore(): void } | undefined;
    let managers: { mockRestore(): void } | undefined;
    try {
      const first = await f.admin("/admin/session/import", { profileId: "synthetic", revision: 1, session: transfer() });
      expect(first.status).toBe(200); expect(first.headers.get("cache-control")).toBe("no-store");
      const status = await first.json();
      expect(status).toMatchObject({ profileId: "synthetic", state: "ready" });
      expect(status.models.some((model: { id: string }) => model.id === "chatgpt-web/gpt-5.6-sol")).toBe(true);
      expect(f.runtime.profiles.physicalIdle()).toBe(true);
      expect(f.providerSends()).toBe(0);
      expect(await (await f.manager.maintenancePage()).evaluate(() => Reflect.get(window, "fixture").sends)).toBe(0);
      const identity = f.runtime.state.profile("synthetic");
      await f.runtime.close();
      // Startup stays fenced while the test installs offline routes in its owned context.
      const parked = new RuntimeState(f.root);
      const operationId = parked.fence()!.operationId;
      parked.quiesce(operationId); parked.close();
      second = startRuntime(f.config); await second.initialized;
      display = spyOn(second.profiles as unknown as { ensureDisplay(id: string): Promise<void> }, "ensureDisplay").mockResolvedValue();
      managers = spyOn(second.profiles, "manager").mockImplementation(profileId => {
        const profile = second!.state.profile(profileId);
        return BrowserManager.forProfile({ profileId, profileEpoch: profile.epoch, browserProfilePath: join(f.root, "profiles", profileId, "browser"), chromeExecutablePath: executablePath!, headed: false });
      });
      const reopened = await second.profiles.manager("synthetic").ensureContext(); await f.intercept(reopened);
      await second.state.resume(operationId, async () => {});
      expect(await second.profiles.verifySession("synthetic", identity.revision)).toMatchObject({ state: "ready", profileId: "synthetic", revision: identity.revision });
      expect(second.state.profile("synthetic")).toEqual(identity);
      expect((await reopened.cookies()).filter(cookie => cookie.name.startsWith("cgw_fixture_session.")).length).toBe(2);
      expect(f.providerSends()).toBe(0);
    } finally { managers?.mockRestore(); display?.mockRestore(); await second?.close(); await f.close(); }
  }, 120_000);

  test("strict authenticated verification rejects stale, active, viewer and fenced targets without clearing cookies", async () => {
    const f = await fixture();
    try {
      await f.context.addCookies(fixtureCookies());
      const snapshot = await f.context.cookies();
      expect((await f.admin("/admin/session/verify", { profileId: "synthetic", revision: 1 }, f.config.runtimeToken.toString())).status).toBe(401);
      expect((await f.admin("/admin/session/verify")).status).toBe(405);
      for (const body of [{ profileId: "synthetic", revision: "1" }, { profileId: "synthetic", revision: 1, extra: true }, { profileId: "synthetic" }, { profileId: "../secret", revision: 1 }]) {
        expect((await f.admin("/admin/session/verify", body)).status).toBe(400);
      }
      expect((await f.admin("/admin/session/verify", { profileId: "missing", revision: 1 })).status).toBe(404);
      const stale = await f.admin("/admin/session/verify", { profileId: "synthetic", revision: 2 });
      expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("profile_revision_conflict");
      let settle!: () => void;
      const turn = f.manager.run("fixture-turn", () => new Promise<void>(resolve => { settle = resolve; }));
      await Promise.resolve();
      try { await expect(f.runtime.profiles.verifySession("synthetic", 1)).rejects.toMatchObject({ code: "profile_active", status: 409 }); }
      finally { settle(); await turn; }
      const internals = f.runtime.profiles as unknown as { viewer?: { profileId: string }; viewerStarting: boolean; viewerClosing?: Promise<void> };
      internals.viewer = { profileId: "synthetic" };
      try { await expect(f.runtime.profiles.verifySession("synthetic", 1)).rejects.toMatchObject({ code: "profile_active" }); }
      finally { internals.viewer = undefined; }
      internals.viewerStarting = true;
      try { await expect(f.runtime.profiles.verifySession("synthetic", 1)).rejects.toMatchObject({ code: "profile_active" }); }
      finally { internals.viewerStarting = false; }
      internals.viewerClosing = Promise.resolve();
      try { await expect(f.runtime.profiles.verifySession("synthetic", 1)).rejects.toMatchObject({ code: "profile_active" }); }
      finally { internals.viewerClosing = undefined; }
      f.runtime.state.drain("fixture-fence");
      const drained = await f.admin("/admin/session/verify", { profileId: "synthetic", revision: 1 });
      expect(drained.status).toBe(503); expect((await drained.json()).error.code).toBe("runtime_draining");
      expect(await f.context.cookies()).toEqual(snapshot);
      expect(f.providerSends()).toBe(0);
    } finally { await f.close(); }
  }, 90_000);

  test("signed-out verification remains not-ready and returns typed login_required", async () => {
    const f = await fixture();
    try {
      const response = await f.admin("/admin/session/verify", { profileId: "synthetic", revision: 1 });
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("login_required");
      expect(f.runtime.profiles.ready("synthetic")).toBe(false);
      expect(f.runtime.state.profile("synthetic").revision).toBe(1);
      expect(f.providerSends()).toBe(0);
    } finally { await f.close(); }
  }, 90_000);
});

describe("strict session transfer credentials", () => {
  test("preserves scoped multipart cookie flags and omits unspecified SameSite", () => {
    const cookies = fixtureCookies();
    const session = { ...cookies[0]!, name: "session-only", expires: -1 };
    const { sameSite: _sameSite, ...unspecified } = session;
    const parsed = parseChatGptWebSessionTransfer(transfer([...cookies, unspecified, { ...cookies[0]!, name: "expired", expires: 1 }]), 100);
    expect(parsed).toEqual([...cookies, unspecified]);
    expect(parsed[2]).not.toHaveProperty("sameSite");
    expect(parsed[2]!.expires).toBe(-1);
  });
  test("strict schema rejects foreign, duplicate, prefixed, control, oversized and unknown cookies", () => {
    const valid = fixtureCookies()[0]!;
    const bad = [
      { ...valid, domain: "google.com" }, { ...valid, domain: ".sub.chatgpt.com" }, { ...valid, name: "bad name" },
      { ...valid, value: "bad\nvalue" }, { ...valid, value: "é".repeat(2048) }, { ...valid, path: "relative" }, { ...valid, path: "/\u007f" },
      { ...valid, expires: 0 }, { ...valid, expires: Infinity }, { ...valid, httpOnly: "true" }, { ...valid, secure: 1 },
      { ...valid, sameSite: "unspecified" }, { ...valid, sameSite: "None", secure: false }, { ...valid, name: "__Secure-x", secure: false },
      { ...valid, name: "__Host-x", domain: ".chatgpt.com" }, { ...valid, name: "__Host-x", path: "/other" },
      { ...valid, url: "https://chatgpt.com" }, { ...valid, partitionKey: "https://other.example" }, { ...valid, value: undefined },
    ];
    for (const cookie of bad) expect(() => parseChatGptWebSessionTransfer(transfer([cookie]))).toThrow(SessionTransferError);
    for (const value of [null, [], {}, { ...transfer(), version: 2 }, { ...transfer(), unknown: true }, transfer([]), transfer([valid, valid]), transfer(Array(181).fill(valid))]) {
      expect(() => parseChatGptWebSessionTransfer(value)).toThrow(SessionTransferError);
    }
    expect(() => parseChatGptWebSessionTransfer(transfer([{ ...valid, expires: 1 }]), 2)).toThrow("session_transfer_expired");
    expect(parseChatGptWebSessionTransfer(transfer([{ ...valid, name: "__Host-synthetic", path: "/" }]))).toHaveLength(1);
  });
  test("bounded streaming reader rejects media, encoding, UTF8, envelope and bytes before parse", async () => {
    const cookies = fixtureCookies();
    const body = { profileId: "synthetic", revision: 1, session: { format: "9router-chatgpt-session", version: 1, cookies: [...cookies, { ...cookies[0]!, name: "expired", expires: 1 }] } };
    const request = (value: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Request("https://fixture.invalid/import", { method: "POST", headers, body: JSON.stringify(value) });
    expect((await readChatGptWebSessionImport(request(body))).session.cookies).toEqual(cookies);
    const rejectedHeaders: Record<string, string>[] = [{ "content-type": "text/plain" }, { "content-type": "application/json", "content-encoding": "gzip" }, { "content-type": "application/json", "content-encoding": "" }];
    for (const headers of rejectedHeaders) {
      await expect(readChatGptWebSessionImport(request(body, headers))).rejects.toMatchObject({ code: "invalid_session_transfer", status: 415 });
    }
    for (const value of [{ ...body, unknown: true }, { ...body, profileId: "../bad" }, { ...body, revision: "1" }, { ...body, revision: 0 }, { session: transfer() }]) {
      await expect(readChatGptWebSessionImport(request(value))).rejects.toMatchObject({ code: "invalid_session_transfer", status: 400 });
    }
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode("{")]) {
      await expect(readChatGptWebSessionImport(new Request("https://fixture.invalid/import", { method: "POST", headers: { "content-type": "application/json" }, body: bytes }))).rejects.toMatchObject({ code: "invalid_session_transfer", status: 400 });
    }
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_SESSION_TRANSFER_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    await expect(readChatGptWebSessionImport(new Request("https://fixture.invalid/import", { method: "POST", headers: { "content-type": "application/json" }, body: stream }))).rejects.toMatchObject({ code: "session_transfer_too_large", status: 413 });
    expect(cancelled).toBe(true);
  });
});
