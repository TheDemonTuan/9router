import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeState, RuntimeStateError } from "../src/runtime-state";
import { RuntimeProfiles } from "../src/profiles";
import { startRuntime } from "../src/server";
import { closeBrowserManagers } from "../src/browser/manager";
import type { RuntimeConfig } from "../src/config";
import type { AuthorityClaims } from "../src/authority";
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

  test("native preflight rejects replay, model drift and interrupted ownership without consuming a fresh claim", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-preflight-"));
    const state = new RuntimeState(root);
    try {
      const profile = state.createProfile("one");
      state.resolveBinding({ clientId: "client", threadId: "thread", candidateProfileIds: ["one"], ready: () => true });
      const first = claim("preflight-first");
      state.assertCanAdmit(first, "one", profile.epoch, "model", false);
      state.assertCanAdmit(first, "one", profile.epoch, "model", false);
      expect(state.acceptedRequestCount()).toBe(0);
      state.admit(first, "one", profile.epoch, "model", false);
      expect(state.acceptedRequestCount()).toBe(1);
      expect(() => state.assertCanAdmit(first, "one", profile.epoch, "model", true)).toThrow(expect.objectContaining({ code: "authority_replayed" }));
      expect(state.binding("client", "thread")).toEqual({ profileId: "one", profileEpoch: profile.epoch, status: "active" });
      expect(state.acceptedRequestCount()).toBe(1);

      const next = claim("preflight-next");
      expect(() => state.assertCanAdmit(next, "one", profile.epoch, "changed-model", true)).toThrow(expect.objectContaining({ code: "model_scope_mismatch" }));
      state.assertCanAdmit(next, "one", profile.epoch, "model", true);
      state.admit(next, "one", profile.epoch, "model", true);
      expect(state.acceptedRequestCount()).toBe(2);

      state.drain("preflight-drain");
      const acceptedContinuation = claim("preflight-continuation");
      state.assertCanAdmit(acceptedContinuation, "one", profile.epoch, "model", true);
      expect(() => state.assertCanAdmit({ ...claim("preflight-new"), turnId: "new-turn" }, "one", profile.epoch, "model", false))
        .toThrow(expect.objectContaining({ code: "runtime_draining" }));
      expect(state.acceptedRequestCount()).toBe(2);
      state.settleTurn("one", profile.epoch, "client", "thread", "turn", true);
      expect(() => state.assertCanAdmit(acceptedContinuation, "one", profile.epoch, "model", true)).toThrow(expect.objectContaining({ code: "turn_interrupted" }));
      expect(state.acceptedRequestCount()).toBe(2);
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("resume leaves profiles unchecked and defers browser probe failures to selected preparation", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-signed-out-"));
    const state = new RuntimeState(root);
    const original = state.createProfile("one");
    const profiles = new RuntimeProfiles(fixtureConfig(root), state);
    const manager = profiles.manager("one");
    const browser = spyOn(profiles, "ensureProfileBrowser").mockResolvedValue(manager);
    const probe = spyOn(profiles, "probe").mockRejectedValue(new ChatGptWebAdapterError("Signed out", {
      status: 409, errorType: "runtime_error", code: "login_required", retryable: false,
    }));
    try {
      state.drain("signed-out-upgrade"); state.quiesce("signed-out-upgrade");
      await state.resume("signed-out-upgrade", () => profiles.initialize());
      expect(state.fence()).toBeNull();
      expect(profiles.status("one")).toMatchObject({ state: "session_unverified", browser_state: "sleeping", catalog_verified: false, lastError: null, models: [] });
      expect(browser).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      await expect(profiles.prepareForRequest("one")).rejects.toMatchObject({ code: "login_required", retryable: false });
      expect(browser).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(profiles.ready("one")).toBe(false);
      expect(state.profile("one").revision).toBe(original.revision);
      probe.mockRejectedValue(new Error("Unexpected browser probe failure"));
      state.drain("broken-upgrade"); state.quiesce("broken-upgrade");
      await state.resume("broken-upgrade", () => profiles.initialize());
      expect(state.fence()).toBeNull();
      await expect(profiles.prepareForRequest("one")).rejects.toThrow("Unexpected browser probe failure");
      expect(profiles.ready("one")).toBe(false);
    } finally {
      probe.mockRestore(); browser.mockRestore();
      await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  test("selected preparation rejects browser ownership and filesystem failures without eager startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-startup-owner-"));
    const state = new RuntimeState(root); state.createProfile("one");
    const profiles = new RuntimeProfiles(fixtureConfig(root), state);
    const browser = spyOn(profiles, "ensureProfileBrowser").mockRejectedValue(new RuntimeStateError("browser_profile_owned", "Fixture directory ownership failure", 503));
    try {
      await profiles.initialize();
      expect(browser).not.toHaveBeenCalled();
      await expect(profiles.prepareForRequest("one")).rejects.toMatchObject({ code: "browser_profile_owned", status: 503 });
      browser.mockRejectedValue(Object.assign(new Error("Fixture filesystem failure"), { code: "EACCES" }));
      await expect(profiles.prepareForRequest("one")).rejects.toMatchObject({ code: "EACCES" });
      expect(profiles.ready("one")).toBe(false);
    } finally { browser.mockRestore(); await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
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
    const initialize = spyOn(runtime.profiles, "initialize").mockRejectedValue(new Error("Fixture initialization failure"));
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
    } finally { initialize.mockRestore(); await runtime.close(); await closeBrowserManagers(); rmSync(root, { recursive: true, force: true }); }
  });

  test("cold configured profiles stay unverified and resource-free through repeated authenticated GETs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-cold-get-"));
    const config = fixtureConfig(root);
    const seed = new RuntimeState(root);
    for (const profileId of ["one", "two", "three"]) seed.createProfile(profileId);
    seed.close();
    const browser = spyOn(RuntimeProfiles.prototype, "ensureProfileBrowser").mockRejectedValue(new Error("GET must not wake a browser"));
    const probe = spyOn(RuntimeProfiles.prototype, "probe").mockRejectedValue(new Error("GET must not probe a session"));
    const harness = spyOn(RuntimeProfiles.prototype, "harnessSmoke").mockRejectedValue(new Error("GET must not restore a tunnel"));
    const runtime = startRuntime(config);
    try {
      await runtime.initialized;
      const base = `http://127.0.0.1:${runtime.server.port}`;
      const adminHeaders = { authorization: `Bearer ${config.adminToken}` };
      const dataHeaders = { authorization: `Bearer ${config.runtimeToken}`, "x-cgw-profile-id": "one" };
      for (let round = 0; round < 10; round++) {
        expect((await fetch(`${base}/healthz`, { headers: dataHeaders })).status).toBe(200);
        const statuses = await (await fetch(`${base}/admin/profiles`, { headers: adminHeaders })).json();
        expect(statuses.profiles).toHaveLength(3);
        for (const profile of statuses.profiles) expect(profile).toMatchObject({
          state: "session_unverified", browser_state: "sleeping", catalog_verified: false, models: [], lastError: null,
        });
        const ready = await fetch(`${base}/readyz`, { headers: dataHeaders });
        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({ ready: false, state: "session_unverified" });
        const catalog = await fetch(`${base}/v1/web-models`, { headers: dataHeaders });
        expect(catalog.status).toBe(503);
        expect(await catalog.json()).toMatchObject({ error: { code: "profile_not_prepared", retryable: false, submission_state: "not_sent" } });
        const resources = await (await fetch(`${base}/admin/resources`, { headers: adminHeaders })).json();
        expect(resources).toMatchObject({ browsers: 0, executingTurns: 0, waitingToolTurns: 0, queueDepth: 0,
          tabs: { active: 0, retainedNative: 0, retainedGeneric: 0, inspection: 0 } });
        expect(resources.profiles).toHaveLength(3);
        expect(runtime.state.acceptedRequestCount()).toBe(0);
      }
      expect(browser).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(harness).not.toHaveBeenCalled();
    } finally {
      browser.mockRestore(); probe.mockRestore(); harness.mockRestore();
      await runtime.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  test("new native bindings await only the selected preparation and existing bindings never wake another profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-maint-native-bind-"));
    const config = fixtureConfig(root);
    const seed = new RuntimeState(root);
    const one = seed.createProfile("one"); seed.createProfile("two");
    // Durable ownership predates this cold runtime, independently of its empty probe cache.
    seed.resolveBinding({ clientId: "client", threadId: "existing", candidateProfileIds: ["one"], ready: () => true });
    seed.close();
    const runtime = startRuntime(config);
    await runtime.initialized;
    const entered = Promise.withResolvers<void>();
    const preparation = Promise.withResolvers<void>();
    const prepare = spyOn(runtime.profiles, "prepareForRequest").mockImplementation(async (profileId, signal) => {
      expect(profileId).toBe("one");
      expect(signal).toBeInstanceOf(AbortSignal);
      entered.resolve();
      await preparation.promise;
    });
    const base = `http://127.0.0.1:${runtime.server.port}`;
    const resolve = (threadId: string, candidateProfileIds: string[], requestedProfileId?: string) => fetch(`${base}/v1/thread-bindings/resolve`, {
      method: "POST", headers: { authorization: `Bearer ${config.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "client", threadId, candidateProfileIds, ...(requestedProfileId ? { requestedProfileId } : {}) }),
    });
    try {
      const pending = resolve("new", ["not-configured", "one", "two"]);
      await entered.promise;
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(runtime.state.binding("client", "new")).toBeNull();
      expect(runtime.profiles.ready("one")).toBe(false);
      expect(runtime.profiles.ready("two")).toBe(false);
      preparation.reject(new RuntimeStateError("login_required", "Selected fixture session is signed out", 503));
      const failed = await pending;
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ error: { code: "login_required", retryable: false, submission_state: "not_sent" } });
      expect(prepare.mock.calls.map(([profileId]) => profileId)).toEqual(["one"]);
      expect(runtime.state.binding("client", "new")).toBeNull();

      prepare.mockRejectedValue(new RuntimeStateError("login_required", "Requested fixture session is signed out", 503));
      const requested = await resolve("requested", ["one", "two"], "two");
      expect(requested.status).toBe(503);
      expect(prepare.mock.calls.map(([profileId]) => profileId)).toEqual(["one", "two"]);
      expect(runtime.state.binding("client", "requested")).toBeNull();

      // Finishing preparation without actual probe evidence must never manufacture readiness.
      prepare.mockResolvedValue(undefined);
      const unverified = await resolve("unverified", ["one", "two"]);
      expect((await unverified.json()).error.code).toBe("profile_unavailable");
      expect(runtime.state.binding("client", "unverified")).toBeNull();

      prepare.mockClear();
      const existing = await resolve("existing", ["two", "one"]);
      expect(existing.status).toBe(200);
      expect(await existing.json()).toEqual({ profileId: "one", profileEpoch: one.epoch, status: "active" });
      expect(prepare).not.toHaveBeenCalled();
      const mismatch = await resolve("existing", ["one", "two"], "two");
      expect((await mismatch.json()).error.code).toBe("profile_mismatch");
      expect(prepare).not.toHaveBeenCalled();
      expect(runtime.resourceBudget.snapshot()).toMatchObject({ browsers: 0, executingTurns: 0, queueDepth: 0 });
      expect(runtime.state.acceptedRequestCount()).toBe(0);
    } finally {
      preparation.reject(new Error("Fixture closed"));
      prepare.mockRestore(); await runtime.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
