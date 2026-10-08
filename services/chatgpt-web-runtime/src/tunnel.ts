import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, lstatSync } from "node:fs";
import { once } from "node:events";
import { RuntimeStateError } from "./runtime-state";
import { join, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { atomicWriteFile, defaultBrokerEndpoint } from "./config";
import { validateProfileId } from "../protocol.js";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { clearInterval, setInterval } from "node:timers";

export const TUNNEL_ID_PATTERN = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
export function validateTunnelId(value: unknown): string {
  if (typeof value !== "string" || !TUNNEL_ID_PATTERN.test(value.trim())) {
    throw new RuntimeStateError("harness_config_invalid", "Enter a canonical Tunnel ID", 400);
  }
  // Pinned a390c168 runtimeconfig.ValidateTunnelID accepts no namespace segment.
  if (!/^tunnel_[a-z0-9]{32}$/.test(value.trim())) {
    throw new RuntimeStateError("harness_tunnel_id_unsupported", "This pinned runtime does not support namespaced Tunnel IDs; an operator-reviewed tunnel-client upgrade is required", 400);
  }
  return value.trim();
}

// Runtime-owned paths must never traverse a symlink, including their parents.
export function ensurePrivateDirectory(dataDir: string, directory: string, create = true): void {
  const root = resolve(dataDir), suffix = relative(root, resolve(directory));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Invalid runtime directory");
  const paths: string[] = [];
  let current = root;
  paths.push(current);
  for (const part of suffix.split(sep).filter(Boolean)) { current = join(current, part); paths.push(current); }
  // Also reject symlink ancestors of the configured runtime root, without changing their modes.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error("Invalid runtime directory");
    if (parent === dirname(parent)) break;
  }
  for (const path of paths) {
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try { if (!lstatSync(path).isDirectory()) throw new Error("Invalid runtime directory"); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (create) chmodSync(path, 0o700);
  }
}
export function assertRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid runtime file");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export const TUNNEL_VERSION = "0.0.15";
export interface ProfileTunnelConfig {
  binaryPath: string; profileDir: string; profileName: string; tunnelId: string; runtimeKeyFile: string;
  mcpEntrypoint: string; healthAddress: string;
  cleanup?: () => void;
}
export function buildProfileTunnelConfig(dataDir: string, profileId: string, tunnelId: string, runtimeKeyFile: string): ProfileTunnelConfig {
  validateProfileId(profileId);
  tunnelId = validateTunnelId(tunnelId);
  const profile = join(resolve(dataDir), "profiles", profileId);
  ensurePrivateDirectory(dataDir, profile);
  const entrypoint = join(profile, "run-mcp");
  assertRegularFile(entrypoint);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  atomicWriteFile(entrypoint, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "adapters/chatgpt-web/mcp-main.ts"))} --broker-socket ${quote(defaultBrokerEndpoint(profile))} --agent-broker-socket ${quote(join(profile, "run", "agent-turns.sock"))} --contract native\n`, { mode: 0o700 });
  return { binaryPath: "/usr/local/bin/tunnel-client", profileDir: join(profile, "tunnel"), profileName: profileId,
    tunnelId, runtimeKeyFile, mcpEntrypoint: entrypoint, healthAddress: "127.0.0.1:0" };
}

const provisionSchema = z.record(z.string(), z.object({ tunnelId: z.string().regex(TUNNEL_ID_PATTERN), runtimeKeyFile: z.string().min(1) }).strict());
export function loadProfileTunnelConfigs(file: string | undefined, dataDir: string): Record<string, ProfileTunnelConfig> {
  if (!file) return {};
  const provisioned = provisionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const configs: Record<string, ProfileTunnelConfig> = Object.create(null);
  for (const profileId of Object.keys(provisioned).sort()) {
    const secret = provisioned[profileId]!;
    if (!isAbsolute(secret.runtimeKeyFile) || !resolve(secret.runtimeKeyFile).startsWith("/run/secrets/cgw-tunnel-keys/")) throw new Error("Tunnel key must use the operator-mounted secret directory");
    configs[profileId] = buildProfileTunnelConfig(dataDir, profileId, secret.tunnelId, secret.runtimeKeyFile);
  }
  return configs;
}

const healthReservations = new Map<ProfileTunnelConfig, string>();
export async function allocateProfileTunnelHealth(config: ProfileTunnelConfig): Promise<string> {
  const existing = healthReservations.get(config);
  if (existing) return existing;
  for (let attempt = 0; attempt < 16; attempt++) {
    const server = createServer();
    const address = await new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address();
        if (!value || typeof value === "string") { server.close(); reject(new Error("Invalid health listener")); return; }
        resolve(`127.0.0.1:${value.port}`);
      });
    });
    // Record the reservation before releasing the OS socket; starts share this allocator.
    let taken = false;
    for (const reserved of healthReservations.values()) { if (reserved === address) { taken = true; break; } }
    if (!taken) { healthReservations.set(config, address); config.healthAddress = address; }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!taken) return address;
  }
  throw new RuntimeStateError("connector_unavailable", "Unable to allocate a tunnel health listener", 503);
}
export function releaseProfileTunnelHealth(config: ProfileTunnelConfig): void {
  healthReservations.delete(config);
  config.healthAddress = "127.0.0.1:0";
}
async function healthListenerAvailable(address: string): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>(resolve => {
    server.once("error", () => resolve(false));
    server.listen(Number(address.split(":")[1]), "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
export class ProfileTunnel {
  private child?: ChildProcess;
  private running = false;
  private lastFailure: string | null = null;
  private checkedAt = 0;
  private healthy = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private healthObserver?: NodeJS.Timeout;
  private healthCheck?: Promise<boolean>;
  constructor(readonly config: ProfileTunnelConfig) {
    validateTunnelId(config.tunnelId);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.profileName) || !TUNNEL_ID_PATTERN.test(config.tunnelId)
      || !/^127\.0\.0\.1:[0-9]{1,5}$/.test(config.healthAddress) || Number(config.healthAddress.split(":")[1]) > 65535) throw new RuntimeStateError("harness_config_invalid", "Invalid tunnel configuration", 400);
  }
  private async command(args: string[]): Promise<void> {
    const child = spawn(this.config.binaryPath, args, { stdio: "ignore", shell: false });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () => reject(new RuntimeStateError("connector_unavailable", "Pinned tunnel initialization failed", 503))); child.once("exit", resolve);
    });
    if (status !== 0) throw new RuntimeStateError("connector_unavailable", "Pinned tunnel initialization failed", 503);
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.reject(new Error("Tunnel already has an owned foreground process"));
    this.starting = this.startOwned().catch(async error => {
      await this.stop();
      if (error instanceof RuntimeStateError) throw error;
      throw new RuntimeStateError("connector_unavailable", "Pinned tunnel startup failed", 503);
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async startOwned(): Promise<void> {
    const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
    if (process.platform !== "linux" || !architecture) throw new RuntimeStateError("connector_unavailable", "Tunnel requires a supported native Linux runtime", 503);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "image-build-manifest.json"), "utf8"));
    if (manifest.tunnel?.version !== TUNNEL_VERSION) throw new RuntimeStateError("connector_unavailable", "Tunnel pin manifest mismatch", 503);
    const build = manifest.tunnel.sourceBuild;
    const licenses = join(dirname(this.config.binaryPath), "..", "share", "licenses", "tunnel-client");
    const proof = JSON.parse(readFileSync(join(licenses, "build-provenance.json"), "utf8"));
    if (!build || proof.schemaVersion !== 1 || proof.architecture !== `linux/${architecture}`
      || proof.nativeBuild !== true || proof.flavor !== "full" || proof.cgoEnabled !== false
      || proof.inputLockSha256 !== build.inputLockSha256 || proof.buildHelperSha256 !== build.buildHelperSha256
      || proof.tunnelRevision !== manifest.tunnel.revision
      || proof.cloudflaredRevision !== manifest.tunnel.cloudflared.release_commit
      || proof.goVersion !== manifest.buildToolchain.version
      || proof.goArchiveSha256 !== manifest.buildToolchain.platforms[architecture].sha256) {
      throw new RuntimeStateError("connector_unavailable", "Pinned tunnel build provenance failed", 503);
    }
    for (const member of ["tunnel-client", "cloudflared", "cloudflared-manifest.json"]) {
      const path = member === "tunnel-client" ? this.config.binaryPath : member === "cloudflared" ? join(dirname(this.config.binaryPath), member)
        : join(licenses, member);
      const key = member === "cloudflared-manifest.json" ? `share/licenses/tunnel-client/${member}` : `bin/${member}`;
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (digest !== proof.files?.[key]) throw new RuntimeStateError("connector_unavailable", "Pinned tunnel closure integrity failed", 503);
    }
    const profileRoot = dirname(this.config.profileDir);
    ensurePrivateDirectory(dirname(dirname(profileRoot)), this.config.profileDir);
    this.lastFailure = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await allocateProfileTunnelHealth(this.config);
      // Another process can take the OS port between allocation and the child's bind.
      if (!await healthListenerAvailable(this.config.healthAddress)) {
        releaseProfileTunnelHealth(this.config);
        continue;
      }
      await this.command(["init", "--force", "--sample", "sample_mcp_stdio_local", "--profile-dir", this.config.profileDir,
        "--profile", this.config.profileName, "--tunnel-id", this.config.tunnelId,
        "--control-plane-api-key-ref", `file:${this.config.runtimeKeyFile}`,
        "--mcp-command", this.config.mcpEntrypoint, "--health-listen-addr", this.config.healthAddress]);
      const child = spawn(this.config.binaryPath, ["run", "--profile-dir", this.config.profileDir, "--profile", this.config.profileName], { stdio: "ignore", shell: false, detached: true });
      this.child = child;
      child.once("error", () => {
        if (this.child === child) {
          this.running = false; this.healthy = false; this.lastFailure = "tunnel_process_failed";
          this.stopHealthObserver();
          if (!this.starting) void this.stop().catch(() => {});
        }
      });
      child.once("exit", () => {
        if (this.child === child) {
          this.running = false; this.healthy = false; this.lastFailure = "tunnel_process_exited";
          this.stopHealthObserver();
          if (!this.starting) void this.stop().catch(() => {});
        }
      });
      this.running = true;
      const deadline = Date.now() + 120_000;
      let collision = false;
      do {
        if (!this.running) {
          collision = !await healthListenerAvailable(this.config.healthAddress);
          break;
        }
        if (await this.ready()) {
          this.healthObserver = setInterval(() => { void this.ready(); }, 1000);
          this.healthObserver.unref();
          return;
        }
        await Bun.sleep(1000);
      } while (Date.now() < deadline);
      // Settle the entire process group before allocating a replacement; retain the key for this retry.
      await this.stopOwned();
      if (!collision) throw new RuntimeStateError("connector_unavailable", "Owned tunnel did not become ready", 503);
      releaseProfileTunnelHealth(this.config);
    }
    throw new RuntimeStateError("connector_unavailable", "Unable to bind a tunnel health listener", 503);
  }
  ready(): Promise<boolean> {
    if (this.healthCheck) return this.healthCheck;
    this.healthCheck = this.checkReady().finally(() => { this.healthCheck = undefined; });
    return this.healthCheck;
  }
  private stopHealthObserver(): void {
    if (this.healthObserver) clearInterval(this.healthObserver);
    this.healthObserver = undefined;
  }
  private async checkReady(): Promise<boolean> {
    const child = this.child;
    if (!child || !this.running || child.exitCode !== null || child.signalCode !== null) return false;
    let healthy = false;
    try {
      const response = await fetch(`http://${this.config.healthAddress}/readyz`, { redirect: "error", proxy: "", signal: AbortSignal.timeout(2000) });
      healthy = response.ok;
      await response.body?.cancel();
    } catch {}
    if (this.child !== child || !this.running) return false;
    this.checkedAt = Date.now(); this.healthy = healthy;
    return healthy;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOwned().then(() => {
      releaseProfileTunnelHealth(this.config);
      this.config.cleanup?.();
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopOwned(): Promise<void> {
    this.stopHealthObserver();
    if (this.healthCheck) await this.healthCheck;
    this.healthy = false;
    const child = this.child;
    if (!child) return;
    const live = child.exitCode === null && child.signalCode === null && child.pid !== undefined;
    const exited = live ? once(child, "exit") : Promise.resolve();
    try {
      if (process.platform === "linux" && child.pid) process.kill(-child.pid, "SIGTERM");
      else if (live) child.kill("SIGTERM");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    // No forced kill: quiescence requires the entire owned process group to exit.
    await exited;
    if (process.platform === "linux" && child.pid) {
      for (;;) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
        await Bun.sleep(50);
      }
    }
    if (this.child === child) this.child = undefined;
    this.running = false; this.healthy = false;
  }
  diagnostic(): { running: boolean; ready: boolean; error: string | null } {
    return { running: this.running, ready: this.running && this.healthy && Date.now() - this.checkedAt < 3000, error: this.lastFailure };
  }
}
