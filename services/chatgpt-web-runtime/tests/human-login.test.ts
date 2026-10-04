import { describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { BrowserManager, closeBrowserManagers } from "../src/browser/manager";
import { NativeBrowserProcess } from "../src/browser/native-process";
import { RuntimeStateError } from "../src/runtime-state";
import { startRuntime } from "../src/server";
import type { RuntimeConfig } from "../src/config";

const loginId = "aabbccdd-1234-4567-89ab-0123456789ab";
interface PhysicalBrowser { context?: BrowserContext; manualBrowser?: NativeBrowserProcess; }

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    // Real subprocess/filesystem readiness needs a platform-clock failure deadline;
    // successful tests remain event-driven and never wait for a fixed duration.
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    const timer = setTimeout(() => finish(new Error(`Native fixture readiness was not observed: ${path}`)), 3000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    };
    watcher.once("error", finish);
    if (existsSync(path)) finish();
  });
}
function nativeFixture(descendant = false, detached = false) {
  const root = mkdtempSync(join(tmpdir(), "cgw-human-login-"));
  const ready = join(root, "native-starts"), descendantReady = join(root, "descendant-ready");
  const script = join(root, "browser-fixture.js"), executable = join(root, "browser-fixture");
  // A real owned process substitutes only for Chrome in lifecycle tests. Actual
  // native browser flags/cookies are exercised by the separate Docker smoke.
  writeFileSync(script, `import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
process.on("SIGTERM", () => process.exit(0));
${descendant ? `spawn(process.execPath, ["-e", ${JSON.stringify(`import { writeFileSync } from "node:fs"; import { createServer } from "node:net"; process.on("SIGTERM", () => {}); createServer().listen(0, "127.0.0.1", () => writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid)));`)}], { stdio: "ignore", detached: ${detached} });` : ""}
createServer().listen(0, "127.0.0.1", () => appendFileSync(${JSON.stringify(ready)}, String(process.pid) + "\\n"));
`);
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}'\n`, { mode: 0o700 });
  const config: RuntimeConfig = { dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: executable,
    runtimeToken: Buffer.from("fixture-runtime-token-not-a-secret"), adminToken: Buffer.from("fixture-admin-token-not-a-secret") };
  return { root, ready, descendantReady, executable, config };
}
async function runtimeFixture() {
  const native = nativeFixture();
  const runtime = startRuntime(native.config); await runtime.initialized;
  const profile = runtime.state.createProfile("personal"), manager = runtime.profiles.manager("personal");
  await manager.startManualLogin("https://chatgpt.com");
  await waitForFile(native.ready);
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); process.stdin.resume()'], { stdio: ["pipe", "pipe", "ignore"] });
  await once(child, "spawn"); await once(child.stdout!, "data");
  const passwordFile = join(native.root, "vnc-password"); writeFileSync(passwordFile, "fixtureVncPassword\n");
  const lease = { loginId, profileId: "personal", expiresAt: Date.now() + 600000, manualLogin: true, manager, child,
    timer: undefined as unknown as Timer, passwordFile, password: "fixtureVncPassword", transports: new Set<() => void>() };
  // Named test-only seams seed/observe private lifecycle state without changing production APIs.
  const internals = runtime.profiles as unknown as { viewer: typeof lease };
  const physical = manager as unknown as PhysicalBrowser;
  internals.viewer = lease;
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const admin = (path: string, body?: unknown, bearer = native.config.adminToken.toString()) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...native, runtime, profile, manager, physical, lease, admin, async close() { await runtime.close(); rmSync(native.root, { recursive: true, force: true }); } };
}

// These tests need POSIX process groups; the runtime's native viewer is Linux-only.
describe.skipIf(process.platform !== "linux")("human-only sign-in physical ownership", () => {
  test("native login fences turns, settings and epoch replacement until physical release", async () => {
    const f = await runtimeFixture();
    try {
      expect(f.manager.isIdle).toBe(false);
      expect(f.runtime.profiles.physicalIdle()).toBe(false);
      expect(f.runtime.profiles.viewerSession(loginId)).toMatchObject({ manualLogin: true, state: "waiting" });
      await expect(f.manager.run("turn", async () => "must not run")).rejects.toThrow("maintenance");
      await expect(f.manager.ensureContext()).rejects.toThrow("Human sign-in");
      await expect(f.runtime.profiles.patch("personal", f.profile.revision, { useSavedChats: true })).rejects.toThrow("human sign-in");
      expect(() => BrowserManager.forProfile({ profileId: "personal", profileEpoch: "replacement", browserProfilePath: join(f.root, "profiles/personal/browser"), chromeExecutablePath: f.executable, headed: true })).toThrow("epoch cannot change");
      expect(f.runtime.state.profile("personal").epoch).toBe(f.profile.epoch);
      expect(await f.runtime.profiles.startViewer("personal", false)).toMatchObject({ loginId, manualLogin: true });
      expect(await f.runtime.profiles.startViewer("personal", true)).toMatchObject({ loginId, manualLogin: true });
      await expect(f.runtime.profiles.startViewer("other", false)).rejects.toThrow("already exists");
      await f.runtime.profiles.closeViewerLease(loginId);
      expect(f.manager.isIdle).toBe(true);
      expect(await f.manager.run("after-close", async () => "released")).toBe("released");
    } finally { await f.close(); }
  });

  test("explicit premature verification restores the exact human lease before rejecting", async () => {
    const f = await runtimeFixture();
    const originalPid = f.physical.manualBrowser!.child.pid;
    const probe = spyOn(f.runtime.profiles, "probe").mockRejectedValue(new RuntimeStateError("login_required", "Still signed out"));
    let revoked = false;
    try {
      f.runtime.profiles.attachViewerTransport(loginId, () => { revoked = true; });
      const response = await f.admin("/admin/login/complete", { loginId });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("login_required");
      expect(revoked).toBe(true);
      const browser = f.physical.manualBrowser!;
      expect(browser.running).toBe(true);
      expect(browser.child.pid).not.toBe(originalPid);
      expect(await (await f.admin(`/admin/login/status?loginId=${loginId}`)).json()).toMatchObject({ loginId, manualLogin: true, state: "waiting" });
      expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(200);
      expect(f.runtime.state.profile("personal").epoch).toBe(f.profile.epoch);
      expect(f.manager.isIdle).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { probe.mockRestore(); await f.close(); }
  });
  test("failed native restoration terminates the lease rather than exposing verification browser", async () => {
    const f = await runtimeFixture();
    const probe = spyOn(f.runtime.profiles, "probe").mockRejectedValue(new RuntimeStateError("login_required", "Still signed out"));
    const restore = spyOn(f.manager, "restoreManualLogin").mockRejectedValue(new Error("Fixture native restart failed"));
    try {
      expect((await f.admin("/admin/login/complete", { loginId })).status).toBe(500);
      expect(f.runtime.profiles.viewerStatus(loginId)).toMatchObject({ loginId, state: "error" });
      expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(404);
      expect(f.lease.password).toBe("");
      expect(f.physical.manualBrowser).toBeUndefined();
      expect(f.manager.isIdle).toBe(true);
    } finally { probe.mockRestore(); restore.mockRestore(); await f.close(); }
  });

  test("verification settles the human process, denies viewer access, and only completes after probe success", async () => {
    const f = await runtimeFixture();
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const probing = new Promise<void>(resolve => { entered = resolve; });
    const probe = spyOn(f.runtime.profiles, "probe").mockImplementation(async (_id, _navigate, _initializing, manager, assertLease) => {
      assertLease?.();
      return manager!.maintenance("controlled authenticated probe", async () => {
        expect(f.physical.manualBrowser).toBeUndefined();
        entered(); await gate; assertLease?.();
        return { revision: f.profile.revision, epoch: f.profile.epoch, capabilities: { solAvailable: false, proAvailable: false }, checkedAt: new Date().toISOString(), models: [], catalogRevision: "fixture-probe" };
      }, true);
    });
    try {
      const completing = f.admin("/admin/login/complete", { loginId });
      await probing;
      expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(404);
      expect(f.manager.isIdle).toBe(false);
      await expect(f.manager.run("during-probe", async () => "must not run")).rejects.toThrow("maintenance");
      finish();
      const response = await completing;
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ loginId, manualLogin: true, state: "completed" });
      expect(f.lease.child.exitCode !== null || f.lease.child.signalCode !== null).toBe(true);
      expect(f.lease.password).toBe("");
      expect(f.manager.isIdle).toBe(true);
    } finally { finish(); probe.mockRestore(); await f.close(); }
  });

  test("expiry or drain during verification cannot restore a revoked physical browser", async () => {
    for (const terminal of ["expired", "closed"] as const) {
      const f = await runtimeFixture();
      let finish!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const probing = new Promise<void>(resolve => { entered = resolve; });
      const restore = spyOn(f.manager, "restoreManualLogin");
      const probe = spyOn(f.runtime.profiles, "probe").mockImplementation(async (_id, _navigate, _initializing, manager, assertLease) => {
        return manager!.maintenance("controlled pending probe", async () => {
          entered(); await gate; assertLease?.();
          throw new RuntimeStateError("login_required", "Still signed out");
        }, true);
      });
      try {
        const completing = f.admin("/admin/login/complete", { loginId });
        await probing;
        if (terminal === "expired") f.lease.expiresAt = Date.now() - 1;
        else f.runtime.state.drain("maintenance");
        const closing = f.runtime.profiles.closeViewer(terminal);
        expect(f.lease.password).toBe("");
        expect(f.runtime.profiles.viewerStatus(loginId).state).toBe(terminal);
        finish(); await closing;
        expect((await completing).status).toBe(404);
        expect(restore).not.toHaveBeenCalled();
        expect(f.physical.manualBrowser).toBeUndefined();
        expect(f.runtime.profiles.physicalIdle()).toBe(true);
      } finally { finish(); restore.mockRestore(); probe.mockRestore(); await f.close(); }
    }
  });

  test("runtime shutdown revokes a live human lease before waiting for physical idle", async () => {
    const f = await runtimeFixture();
    let revoked = false;
    f.runtime.profiles.attachViewerTransport(loginId, () => { revoked = true; });
    try {
      await f.runtime.close();
      expect(revoked).toBe(true);
      expect(f.physical.manualBrowser).toBeUndefined();
      expect(f.lease.password).toBe("");
    } finally { await f.close(); }
  });

  test("closing during automated context settlement prevents a late native spawn", async () => {
    const f = nativeFixture();
    const manager = BrowserManager.forProfile({ profileId: "startup", profileEpoch: "fixture", browserProfilePath: join(f.root, "profile"), chromeExecutablePath: f.executable, headed: true });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const settling = new Promise<void>(resolve => { entered = resolve; });
    // The controlled context-close seam holds the physical handoff at its real await boundary.
    const physical = manager as unknown as PhysicalBrowser;
    physical.context = { close: async () => { entered(); await gate; physical.context = undefined; } } as unknown as BrowserContext;
    try {
      const starting = manager.startManualLogin("https://chatgpt.com");
      const rejected = starting.then(() => { throw new Error("Revoked startup unexpectedly succeeded"); }, error => error);
      await settling;
      const closing = manager.close(); release();
      expect((await rejected).message).toContain("revoked"); await closing;
      expect(existsSync(f.ready)).toBe(false);
      expect(manager.isIdle).toBe(true);
    } finally { release(); await manager.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a second profile cannot take the canonical directory while native login owns it", async () => {
    const f = await runtimeFixture();
    const second = BrowserManager.forProfile({ profileId: "second", profileEpoch: "fixture", browserProfilePath: join(f.root, "profiles/personal/browser"), chromeExecutablePath: f.executable, headed: true });
    // Observe only this fixture's private physical process owner.
    const physicalSecond = second as unknown as PhysicalBrowser;
    try {
      await expect(second.startManualLogin("https://chatgpt.com")).rejects.toThrow("already has an owner");
      expect(f.physical.manualBrowser!.running).toBe(true);
      await f.runtime.profiles.closeViewer();
      await second.startManualLogin("https://chatgpt.com");
      expect(physicalSecond.manualBrowser!.running).toBe(true);
    } finally { await second.close(); await f.close(); await closeBrowserManagers(); }
  });

  test.each([false, true])("native release settles resistant descendants even when detached=%s", async detached => {
    const f = nativeFixture(true, detached);
    const browser = await NativeBrowserProcess.launch(f.executable, f.root, undefined, "https://chatgpt.com");
    try {
      await waitForFile(f.descendantReady);
      const descendant = Number(readFileSync(f.descendantReady, "utf8"));
      // Exercise actual POSIX termination/escalation, not virtual clocks, across real processes.
      await browser.close();
      expect(browser.running).toBe(false);
      let state = "X";
      try { const stat = readFileSync(`/proc/${descendant}/stat`, "utf8"); state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0]!; } catch {}
      expect(["Z", "X"]).toContain(state);
    } finally { await browser.close(); rmSync(f.root, { recursive: true, force: true }); }
  });
});
