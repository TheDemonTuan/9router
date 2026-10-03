import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/server";
import { validateProfileId } from "../protocol.js";

const root = mkdtempSync(join(tmpdir(), "cgw-profile-ownership-"));
const previous = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "DATA_DIR", "CGW_DATA_DIR"].map(key => [key, process.env[key]]));
for (const key of Object.keys(previous)) process.env[key] = root;
const chrome = process.env.CGW_CHROMIUM_EXECUTABLE || "/usr/bin/chromium";
const runtime = startRuntime({
  dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: chrome,
  runtimeToken: Buffer.from("data-token".repeat(4)), adminToken: Buffer.from("admin-token".repeat(4)),
});
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
  for (const id of ["profile-a", "profile-b"]) {
    runtime.state.createProfile(validateProfileId(id));
    const manager = await runtime.profiles.ensureProfileBrowser(id);
    const context = await manager.ensureContext();
    assert(context && !context.pages().some(page => !page.isClosed() && page.url().startsWith("chrome-error://")), "Browser startup failed");
  }
  const primary = await runtime.profiles.ensureProfileBrowser("profile-a");
  const leases = [];
  for (let i = 0; i < 5; i++) {
    leases.push(await primary.leaseTurn({ traceId: `trace-${i}`, modelIdentity: "gpt-5.3-codex" }));
  }
  assert(primary.activeTurns === 5, "Expected exactly five active leased turns");
  let denied = false;
  try {
    await primary.leaseTurn({ traceId: "trace-overflow", modelIdentity: "gpt-5.3-codex" });
  } catch (err: unknown) {
    assert(err !== null && typeof err === "object" && "status" in err && "code" in err && (err as { status: number; code: string }).status === 503 && (err as { status: number; code: string }).code === "concurrency_limit", "Expected 503 concurrency_limit on sixth turn");
    denied = true;
  }
  assert(denied, "Sixth concurrent browser turn must be rejected");
  for (const lease of leases) await lease.release();
  assert(primary.activeTurns === 0, "Active turns must return to zero after release");
  const profiles = runtime.state.listProfiles();
  assert(profiles.length === 2, "Profile creation count mismatch");
  assert(runtime.profiles.physicalIdle(), "Physical idle was not observed for freshly initialized profiles");
  console.info(JSON.stringify({ gate: "smoke-profile-ownership", initialized: true, profiles: 2, profileConcurrency: true, physicalIdle: true, platform: process.platform, arch: process.arch }));
} finally {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
