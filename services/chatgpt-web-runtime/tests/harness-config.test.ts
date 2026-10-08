import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HarnessConfigStore } from "../src/harness-config";
import { allocateProfileTunnelHealth, buildProfileTunnelConfig, loadProfileTunnelConfigs, ProfileTunnel, releaseProfileTunnelHealth, TUNNEL_ID_PATTERN, validateTunnelId } from "../src/tunnel";
import type { ProfileTunnelConfig } from "../src/tunnel";
import { RuntimeStateError } from "../src/runtime-state";

const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const otherTunnelId = "tunnel_abcdef0123456789abcdef0123456789";
const key = "sk-runtime-synthetic-01234567890123456789";
const roots: string[] = [];
const stores: HarnessConfigStore[] = [];
function fixture(operatorConfigs: Record<string, ProfileTunnelConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cgw-harness-secrets-"));
  roots.push(root);
  const store = new HarnessConfigStore(root, operatorConfigs);
  stores.push(store);
  return { root, store, file: join(root, "profiles", "one", "secrets", "harness.json") };
}
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected a typed configuration failure"); }
  catch (error) {
    expect(error).toBeInstanceOf(RuntimeStateError);
    expect((error as RuntimeStateError).code).toBe(code);
    expect(String(error)).not.toContain(key);
  }
}
afterEach(async () => {
  try { for (const store of stores) { try { await store.cleanup("one"); await store.cleanup("two"); } catch {} } }
  finally { stores.length = 0; for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.length = 0; }
});

describe("managed harness configuration", () => {
  test("stores only in runtime-private files, protects modes and returns metadata without secrets", () => {
    const { root, store, file } = fixture();
    expect(store.describe("one")).toEqual({ source: "none", configRevision: 0, tunnelId: null, keyConfigured: false });
    const saved = store.configure("one", 0, { tunnelId: ` ${tunnelId} `, runtimeApiKey: ` ${key} ` });
    expect(saved).toEqual({ source: "managed", configRevision: 1, tunnelId, keyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(JSON.stringify(store.describe("one"))).not.toContain(key);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, configRevision: 1, tunnelId, runtimeApiKey: key });
    for (const directory of [root, join(root, "profiles"), join(root, "profiles", "one"), join(root, "profiles", "one", "secrets")]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
  test("restart reads committed revision; omitted update key retains the prior secret", () => {
    const { root, store, file } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const restarted = new HarnessConfigStore(root);
    stores.push(restarted);
    expect(restarted.describe("one").configRevision).toBe(1);
    expect(restarted.configure("one", 1, { tunnelId: otherTunnelId }).configRevision).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).runtimeApiKey).toBe(key);
    expect(store.describe("one").tunnelId).toBe(otherTunnelId);
  });
  test("stale CAS does not alter committed bytes", () => {
    const { store, file } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const original = readFileSync(file, "utf8");
    for (const revision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => store.configure("one", revision, { tunnelId: otherTunnelId, runtimeApiKey: `${key}new` }), "harness_config_conflict");
    }
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  test("first save requires a key; empty update does not delete or retain silently", () => {
    const { store, file } = fixture();
    expectCode(() => store.configure("one", 0, { tunnelId }), "harness_key_required");
    expect(existsSync(file)).toBe(false);
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const original = readFileSync(file, "utf8");
    for (const runtimeApiKey of ["", "  ", "x".repeat(31), "x".repeat(4097), `${key}\n${key}`, `${key}\0`, "sk-admin-" + "a".repeat(32)]) {
      expectCode(() => store.configure("one", 1, { tunnelId, runtimeApiKey }), "harness_key_invalid");
    }
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  test("key limits measure UTF-8 bytes rather than characters", () => {
    const { store } = fixture();
    expectCode(() => store.configure("one", 0, { tunnelId, runtimeApiKey: "é".repeat(2049) }), "harness_key_invalid");
    expect(store.configure("one", 0, { tunnelId, runtimeApiKey: "é".repeat(16) }).keyConfigured).toBe(true);
  });
  test("rejects noncanonical and pinned-unsupported IDs without truncation or writes", () => {
    const { store, file } = fixture();
    const namespaced = "tunnel_ab12_0123456789abcdef0123456789abcdef";
    expect(TUNNEL_ID_PATTERN.test(namespaced)).toBe(true);
    expectCode(() => store.configure("one", 0, { tunnelId: namespaced, runtimeApiKey: key }), "harness_tunnel_id_unsupported");
    expectCode(() => validateTunnelId(namespaced), "harness_tunnel_id_unsupported");
    for (const value of ["tunnel_../../secret", tunnelId.toUpperCase(), "tunnel_abc", `${tunnelId}extra`]) {
      expectCode(() => store.configure("one", 0, { tunnelId: value, runtimeApiKey: key }), "harness_config_invalid");
    }
    expect(existsSync(file)).toBe(false);
  });
  test("invalid persistent contents fail closed without echoing a key or path", () => {
    const { store, file, root } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    writeFileSync(file, JSON.stringify({ version: 1, configRevision: 1, tunnelId, runtimeApiKey: key, unsafe: root }));
    expectCode(() => store.describe("one"), "harness_storage_invalid");
    try { store.describe("one"); } catch (error) { expect(String(error)).not.toContain(root); }
  });
  test("read-only preflight preserves the live process configuration and does not create storage", async () => {
    const { root, store } = fixture();
    const profile = join(root, "profiles", "one");
    store.validateConfiguration("one", 0, { tunnelId, runtimeApiKey: key });
    expect(existsSync(profile)).toBe(false);
    expect(store.describe("one").source).toBe("none");
    expect(existsSync(profile)).toBe(false);
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const config = await store.processConfig("one");
    store.validateConfiguration("one", 1, { tunnelId: otherTunnelId });
    expectCode(() => store.validateConfiguration("one", 0, { tunnelId }), "harness_config_conflict");
    expectCode(() => store.validateConfiguration("one", 1, { tunnelId, runtimeApiKey: "" }), "harness_key_invalid");
    expect(await store.processConfig("one")).toBe(config);
    expect(readFileSync(config.runtimeKeyFile, "utf8")).toBe(key);
    expect(store.describe("one").configRevision).toBe(1);
  });

});

describe("file boundary and process configuration", () => {
  test("rejects symlink secret target, symlink parent and hardlinked target without modifying destination", () => {
    for (const kind of ["file", "directory", "hardlink"] as const) {
      const { root, store, file } = fixture();
      const outside = join(root, "outside"); mkdirSync(outside);
      const victim = join(outside, "harness.json"); writeFileSync(victim, key);
      if (kind === "directory") {
        mkdirSync(join(root, "profiles", "one"), { recursive: true });
        symlinkSync(outside, join(root, "profiles", "one", "secrets"));
      } else {
        mkdirSync(join(root, "profiles", "one", "secrets"), { recursive: true });
        if (kind === "file") symlinkSync(victim, file); else linkSync(victim, file);
      }
      expectCode(() => store.configure("one", 0, { tunnelId, runtimeApiKey: key }), "harness_storage_invalid");
      expect(readFileSync(victim, "utf8")).toBe(key);
    }
  });
  test("rejects non-regular targets before reading", () => {
    const { store, file } = fixture();
    mkdirSync(file, { recursive: true });
    expectCode(() => store.describe("one"), "harness_storage_invalid");
  });
  test("process config has fixed commands and a private key reference; cleanup retains saved secret", async () => {
    const { store, file, root } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const [first, second] = await Promise.all([store.processConfig("one"), store.processConfig("one")]);
    expect(second).toBe(first);
    expect(first.binaryPath).toBe("/usr/local/bin/tunnel-client");
    expect(first.runtimeKeyFile).toBe(join(root, "profiles", "one", "run", "tunnel-runtime-key"));
    expect(readFileSync(first.runtimeKeyFile, "utf8")).toBe(key);
    expect(lstatSync(first.runtimeKeyFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, "profiles", "one", "run")).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(first)).not.toContain(key);
    const command = readFileSync(first.mcpEntrypoint, "utf8");
    expect(command).toContain("--broker-socket");
    expect(command).toContain("--agent-broker-socket");
    expect(command).toContain("--contract native");
    expect(command).not.toContain(key);
    expect(lstatSync(first.mcpEntrypoint).mode & 0o777).toBe(0o700);
    expectCode(() => store.configure("one", 1, { tunnelId }), "harness_config_conflict");
    await store.cleanup("one");
    expect(existsSync(first.runtimeKeyFile)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(first.healthAddress).toBe("127.0.0.1:0");
    expect(store.configure("one", 1, { tunnelId }).configRevision).toBe(2);
    const restarted = new HarnessConfigStore(root); stores.push(restarted);
    expect(readFileSync((await restarted.processConfig("one")).runtimeKeyFile, "utf8")).toBe(key);
  });
  test("stop without a launched tunnel removes temporary key and allocation", async () => {
    const { store, file } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const config = await store.processConfig("one");
    await new ProfileTunnel(config).stop();
    expect(existsSync(config.runtimeKeyFile)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(config.healthAddress).toBe("127.0.0.1:0");
  });
  test("failed process preparation through symlink run never deletes outside key", async () => {
    const { root, store } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const outside = join(root, "outside"); mkdirSync(outside);
    const victim = join(outside, "tunnel-runtime-key"); writeFileSync(victim, key);
    symlinkSync(outside, join(root, "profiles", "one", "run"));
    await expect(store.processConfig("one")).rejects.toMatchObject({ code: "harness_storage_invalid" });
    expect(readFileSync(victim, "utf8")).toBe(key);
  });
  test("dynamic allocations do not collide for late managed and existing operator profiles", async () => {
    const { root, store } = fixture();
    const operatorFile = join(root, "operator.json");
    writeFileSync(operatorFile, JSON.stringify({ two: { tunnelId, runtimeKeyFile: "/run/secrets/cgw-tunnel-keys/two" } }));
    const operators = loadProfileTunnelConfigs(operatorFile, root);
    expect(operators.two!.healthAddress).toBe("127.0.0.1:0");
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const managed = await store.processConfig("one");
    try {
      await allocateProfileTunnelHealth(operators.two!);
      expect(operators.two!.healthAddress).not.toBe(managed.healthAddress);
      expect(managed.healthAddress).toMatch(/^127\.0\.0\.1:[1-9][0-9]+$/);
      expect(await allocateProfileTunnelHealth(operators.two!)).toBe(operators.two!.healthAddress);
    } finally { releaseProfileTunnelHealth(operators.two!); }
  });
});

describe("operator provisioning isolation", () => {
  test("exact-profile operator wins without reading a conflicting managed secret", async () => {
    const { root, store, file } = fixture();
    store.configure("one", 0, { tunnelId, runtimeApiKey: key });
    const operatorKey = join(root, "operator-key"); writeFileSync(operatorKey, `${key}operator`);
    const operator = buildProfileTunnelConfig(root, "one", otherTunnelId, operatorKey);
    const operators = new HarnessConfigStore(root, { one: operator }); stores.push(operators);
    writeFileSync(file, "invalid managed state must not be inspected");
    expect(operators.describe("one")).toEqual({ source: "operator", configRevision: 0, tunnelId: otherTunnelId, keyConfigured: true });
    expectCode(() => operators.configure("one", 0, { tunnelId, runtimeApiKey: key }), "harness_operator_managed");
    expect(operators.describe("two").source).toBe("none");
    const processConfig = await operators.processConfig("one");
    expect(processConfig.runtimeKeyFile).not.toBe(operatorKey);
    expect(readFileSync(processConfig.runtimeKeyFile, "utf8")).toBe(`${key}operator`);
    expect(processConfig.tunnelId).toBe(otherTunnelId);
    await operators.cleanup("one");
    expect(readFileSync(operatorKey, "utf8")).toBe(`${key}operator`);
    expect(readFileSync(file, "utf8")).toBe("invalid managed state must not be inspected");
  });
  test("external provisioning rejects dashboard-like filesystem references", () => {
    const { root } = fixture();
    const config = join(root, "operator.json");
    for (const runtimeKeyFile of ["relative-key", "/tmp/key", "/run/secrets/cgw-tunnel-keys/../outside"]) {
      writeFileSync(config, JSON.stringify({ one: { tunnelId, runtimeKeyFile } }));
      expect(() => loadProfileTunnelConfigs(config, root)).toThrow("operator-mounted secret directory");
    }
  });
});

// Set only to the privately built exact manifest revision; init generates local YAML, never starts a tunnel.
const pinnedCli = process.env.CGW_PINNED_TUNNEL_OFFLINE_BINARY;
test.skipIf(!pinnedCli)("actual pinned CLI init accepts unnamespaced canonical IDs and rejects namespaced IDs offline", () => {
  const { root } = fixture();
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "image-build-manifest.json"), "utf8"));
  expect(manifest.tunnel.version).toBe("0.0.15");
  expect(manifest.tunnel.revision).toBe("a390c168ff1b2d14e73a95991c186c6aba3ff5a0");
  for (const id of [tunnelId, "tunnel_ab12_0123456789abcdef0123456789abcdef"]) {
    const result = spawnSync(pinnedCli!, ["init", "--sample", "sample_mcp_stdio_local", "--profile-dir", join(root, "cli"),
      "--profile", "offline", "--force", "--tunnel-id", id, "--mcp-command", "/usr/bin/true", "--health-listen-addr", "127.0.0.1:0",
      "--control-plane-api-key-ref", "file:/nonexistent/offline-key"], {
      encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root },
    });
    expect(result.error).toBeUndefined();
    if (id === tunnelId) expect(result.status).toBe(0);
    else { expect(result.status).not.toBe(0); expect(result.stderr).toContain("invalid tunnel ID"); }
  }
});
