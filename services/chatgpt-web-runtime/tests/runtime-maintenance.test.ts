import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeState } from "../src/runtime-state";
import { RuntimeProfiles } from "../src/profiles";
import { startRuntime } from "../src/server";
import { closeBrowserManagers } from "../src/browser/manager";
import type { RuntimeConfig } from "../src/config";
import type { AuthorityClaims } from "../src/authority";
import type { BrowserContext } from "playwright-core";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

function fixtureConfig(dataDir: string): RuntimeConfig {
  return { dataDir, host: "127.0.0.1", port: 0, chromiumExecutable: join(dataDir, "absent-chromium"),
    runtimeToken: Buffer.from("fixture-data-token-is-not-a-real-secret"), adminToken: Buffer.from("fixture-admin-token-is-not-a-real-secret") };
}
function claim(jti: string): AuthorityClaims {
  return { v: 1, aud: "9router-cgw", purpose: "responses", clientId: "client", threadId: "thread", turnId: "turn", jti,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, method: "POST", path: "/v1/responses", bodySha256: "a".repeat(64) };
}

describe("durable maintenance lifecycle", () => {
  test("resume holds its fence through asynchronous initialization and keeps it on child failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-fence-"));
    let state = new RuntimeState(root);
    try {
      const profile = state.createProfile("one");
      state.resolveBinding({ clientId: "client", threadId: "thread", candidateProfileIds: ["one"], ready: () => true });
      state.admit(claim("first"), "one", profile.epoch, "model", false);
      state.settleClaim("client", "first"); state.settleTurn("one", profile.epoch, "client", "thread", "turn");
      state.drain("upgrade"); state.quiesce("upgrade");
      let failInitialization!: (error: Error) => void;
      const gate = new Promise<void>((_, reject) => { failInitialization = reject; });
      const resuming = state.resume("upgrade", () => gate);
      expect(state.fence()).toEqual({ operationId: "upgrade", state: "quiesced" });
      expect(() => state.createProfile("two")).toThrow("denied while drained");
      expect(() => state.admit({ ...claim("during-init"), turnId: "new-turn" }, "one", profile.epoch, "model", false)).toThrow("denied while drained");
      failInitialization(new Error("owned Chromium initialization failed"));
      await expect(resuming).rejects.toThrow("initialization failed");
      expect(state.acceptedRequestCount()).toBe(1);
      state.close(); state = new RuntimeState(root);
      expect(state.fence()).toEqual({ operationId: "upgrade", state: "quiesced" });
      await state.resume("upgrade", async () => { expect(state.fence()?.operationId).toBe("upgrade"); });
      state.admit({ ...claim("after-init"), turnId: "new-turn" }, "one", profile.epoch, "model", false);
      expect(state.acceptedRequestCount()).toBe(2);
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("resume accepts signed-out profiles but keeps admission fenced on unexpected probe failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-signed-out-"));
    const state = new RuntimeState(root);
    const original = state.createProfile("one");
    const profiles = new RuntimeProfiles(fixtureConfig(root), state);
    const manager = profiles.manager("one");
    const browser = spyOn(profiles, "ensureProfileBrowser").mockResolvedValue(manager);
    const context = spyOn(manager, "ensureContext").mockResolvedValue({} as BrowserContext);
    const probe = spyOn(profiles, "probe").mockRejectedValue(new ChatGptWebAdapterError("Signed out", {
      status: 409, errorType: "runtime_error", code: "login_required", retryable: false,
    }));
    try {
      state.drain("signed-out-upgrade"); state.quiesce("signed-out-upgrade");
      await state.resume("signed-out-upgrade", () => profiles.initialize());
      expect(state.fence()).toBeNull();
      expect(profiles.status("one")).toMatchObject({ state: "login_required", lastError: "login_required", models: [] });
      expect(profiles.ready("one")).toBe(false);
      expect(state.profile("one").revision).toBe(original.revision);
      probe.mockRejectedValue(new Error("Unexpected browser probe failure"));
      state.drain("broken-upgrade"); state.quiesce("broken-upgrade");
      await expect(state.resume("broken-upgrade", () => profiles.initialize())).rejects.toThrow("Unexpected browser probe failure");
      expect(state.fence()).toEqual({ operationId: "broken-upgrade", state: "quiesced" });
      expect(profiles.ready("one")).toBe(false);
    } finally {
      probe.mockRestore(); context.mockRestore(); browser.mockRestore();
      await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed durable fences and missing schema tables fail closed rather than reset", () => {
    for (const corruption of ["null-fence", "invalid-fence", "missing-table", "invalid-settings", "invalid-count"]) {
      const root = mkdtempSync(join(tmpdir(), "cgw-maint-corrupt-"));
      const state = new RuntimeState(root); state.createProfile("one"); state.close();
      const database = new Database(join(root, "runtime.sqlite"));
      try {
        if (corruption === "missing-table") database.exec("DROP TABLE turn_ledger");
        else if (corruption === "invalid-settings") database.query("UPDATE profiles SET settings_json=?").run(JSON.stringify({ mode: "full", autoApproveToolCalls: "yes" }));
        else if (corruption === "invalid-count") database.query("INSERT INTO runtime_meta VALUES('accepted_request_count',?)").run("-1");
        else database.query("INSERT INTO runtime_meta VALUES('deployment_fence',?)").run(corruption === "null-fence" ? "null" : JSON.stringify({ operationId: "upgrade", state: "ready" }));
        database.close();
        let failure: unknown;
        try { new RuntimeState(root); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: "state_schema_invalid", status: 503 });
        const preserved = new Database(join(root, "runtime.sqlite"));
        if (corruption === "missing-table") expect(preserved.query("SELECT name FROM sqlite_master WHERE name='turn_ledger'").get()).toBeNull();
        else if (corruption === "null-fence") expect(preserved.query("SELECT value FROM runtime_meta WHERE key='deployment_fence'").get()).toEqual({ value: "null" });
        preserved.close();
      } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
    }
  });

  test("late account probes cannot overwrite a newer revision or restore interrupted owners", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-account-")); const state = new RuntimeState(root);
    try {
      const original = state.createProfile("one");
      const observed = state.observeAccount("one", "salted-first", original.revision);
      state.resolveBinding({ clientId: "client", threadId: "thread", candidateProfileIds: ["one"], ready: () => true });
      state.admit(claim("first"), "one", observed.epoch, "model", false);
      const next = state.observeAccount("one", "salted-next", observed.revision);
      expect(() => state.observeAccount("one", "salted-old", observed.revision)).toThrow("Stale account probe");
      expect(state.profile("one").epoch).toBe(next.epoch);
      expect(state.binding("client", "thread")?.status).toBe("interrupted");
      state.settleTurn("one", observed.epoch, "client", "thread", "turn");
      expect(state.activeTurnScopes("one", "turn")).toEqual([]);
      expect(() => state.admit(claim("late"), "one", observed.epoch, "model", true)).toThrow("durable profile binding");
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("settings maintenance rejects an active turn and prevents a concurrent turn from entering", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-settings-")); const state = new RuntimeState(root);
    const profiles = new RuntimeProfiles(fixtureConfig(root), state);
    try {
      const profile = state.createProfile("one"); const manager = profiles.manager("one");
      let finish!: () => void;
      const active = manager.run("active-turn", () => new Promise<void>(resolve => { finish = resolve; }));
      await Promise.resolve();
      await expect(profiles.patch("one", profile.revision, { useSavedChats: true })).rejects.toThrow("settle");
      expect(state.profile("one").settings.useSavedChats).toBe(false);
      finish(); await active; await Promise.resolve();
      const patching = profiles.patch("one", profile.revision, { useSavedChats: true });
      await expect(manager.run("racing-turn", async () => "must-not-run")).rejects.toThrow("maintenance");
      await patching;
      expect(state.profile("one").settings.useSavedChats).toBe(true);
      await expect(profiles.patch("one", profile.revision, { autoApproveToolCalls: true })).rejects.toThrow("revision changed");
      await expect(profiles.patch("one", state.profile("one").revision, { toString: true })).rejects.toThrow("Invalid profile settings");
    } finally { await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("HTTP quiesced diagnostics stay available and failed resume cannot open admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-http-")); const config = fixtureConfig(root);
    const runtime = startRuntime(config); await runtime.initialized;
    const url = `http://127.0.0.1:${runtime.server.port}`;
    const admin = (path: string, body?: unknown) => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      expect((await admin("/admin/profiles", { profileId: "one" })).status).toBe(200);
      expect((await admin("/admin/drain", { operationId: "upgrade" })).status).toBe(200);
      expect((await admin("/admin/quiesce", { operationId: "upgrade" })).status).toBe(200);
      const diagnostics = await (await admin("/admin/profiles")).json();
      expect(diagnostics.operationFence).toEqual({ operationId: "upgrade", state: "quiesced" });
      expect(diagnostics.physicalIdle).toBe(true);
      expect((await admin("/admin/resume", { operationId: "wrong" })).status).toBe(409);
      expect((await admin("/admin/resume", { operationId: "upgrade" })).status).toBe(500);
      expect((await (await admin("/admin/profiles")).json()).operationFence?.operationId).toBe("upgrade");
      const dataHeaders = { authorization: `Bearer ${config.runtimeToken}`, "content-type": "application/json" };
      expect((await fetch(`${url}/readyz`, { headers: dataHeaders })).status).toBe(503);
      const binding = await fetch(`${url}/v1/thread-bindings/resolve`, { method: "POST", headers: dataHeaders, body: JSON.stringify({ clientId: "client", threadId: "thread", candidateProfileIds: ["one"] }) });
      expect(binding.status).toBe(503);
      expect((await admin("/healthz")).status).toBe(200);
    } finally { await runtime.close(); await closeBrowserManagers(); rmSync(root, { recursive: true, force: true }); }
  });
});
