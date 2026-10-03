import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { RuntimeStateError } from "./runtime-state";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { atomicWriteFile, defaultBrokerEndpoint } from "./config";
import { validateProfileId } from "../protocol.js";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const provisionSchema = z.record(z.string(), z.object({ tunnelId: z.string().regex(/^tunnel_[a-f0-9]{32}$/), runtimeKeyFile: z.string().min(1) }).strict());
export function loadProfileTunnelConfigs(file: string | undefined, dataDir: string): Record<string, ProfileTunnelConfig> {
  if (!file) return {};
  const provisioned = provisionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const configs: Record<string, ProfileTunnelConfig> = {};
  let index = 0;
  for (const profileId of Object.keys(provisioned).sort()) {
    validateProfileId(profileId);
    const secret = provisioned[profileId]!;
    if (!isAbsolute(secret.runtimeKeyFile) || !resolve(secret.runtimeKeyFile).startsWith("/run/secrets/cgw-tunnel-keys/")) throw new Error("Tunnel key must use the operator-mounted secret directory");
    const profile = join(dataDir, "profiles", profileId);
    const entrypoint = join(profile, "run-mcp");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    atomicWriteFile(entrypoint, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "adapters/chatgpt-web/mcp-main.ts"))} --broker-socket ${quote(defaultBrokerEndpoint(profile))} --contract native\n`, { mode: 0o700 });
    configs[profileId] = { binaryPath: "/usr/local/bin/tunnel-client", profileDir: join(profile, "tunnel"), profileName: profileId,
      tunnelId: secret.tunnelId, runtimeKeyFile: secret.runtimeKeyFile, mcpEntrypoint: entrypoint, healthAddress: `127.0.0.1:${19000 + index++}` };
  }
  return configs;
}

export const TUNNEL_VERSION = "0.0.12";
export interface ProfileTunnelConfig {
  binaryPath: string; profileDir: string; profileName: string; tunnelId: string; runtimeKeyFile: string;
  mcpEntrypoint: string; healthAddress: string;
}
export class ProfileTunnel {
  private child?: ChildProcess;
  private running = false;
  private lastFailure: string | null = null;
  private checkedAt = 0;
  private healthy = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(readonly config: ProfileTunnelConfig) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.profileName) || !/^tunnel_[a-f0-9]{32}$/.test(config.tunnelId)
      || !/^127\.0\.0\.1:[0-9]{1,5}$/.test(config.healthAddress)) throw new Error("Invalid operator tunnel configuration");
  }
  private async command(args: string[]): Promise<void> {
    const child = spawn(this.config.binaryPath, args, { stdio: "ignore", shell: false });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    if (status !== 0) throw new RuntimeStateError("connector_unavailable", "Pinned tunnel initialization failed", 503);
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.reject(new Error("Tunnel already has an owned foreground process"));
    this.starting = this.startOwned().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async startOwned(): Promise<void> {
    const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
    if (process.platform !== "linux" || !architecture) throw new RuntimeStateError("connector_unavailable", "Tunnel requires a supported native Linux runtime", 503);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "image-build-manifest.json"), "utf8"));
    if (manifest.tunnel?.version !== TUNNEL_VERSION) throw new RuntimeStateError("connector_unavailable", "Tunnel pin manifest mismatch", 503);
    const members = manifest.tunnel.platforms?.[architecture]?.members;
    for (const member of ["tunnel-client", "cloudflared", "cloudflared-manifest.json"]) {
      const path = member === "tunnel-client" ? this.config.binaryPath : member === "cloudflared" ? join(dirname(this.config.binaryPath), member)
        : join(dirname(this.config.binaryPath), "..", "share", "licenses", "tunnel-client", member);
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (!members || digest !== members[member]) throw new RuntimeStateError("connector_unavailable", "Pinned tunnel closure integrity failed", 503);
    }
    mkdirSync(this.config.profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.profileDir, 0o700);
    await this.command(["init", "--sample", "sample_mcp_stdio_local", "--profile-dir", this.config.profileDir,
      "--profile", this.config.profileName, "--tunnel-id", this.config.tunnelId,
      "--control-plane-api-key-ref", `file:${this.config.runtimeKeyFile}`,
      "--mcp-command", this.config.mcpEntrypoint, "--health-listen-addr", this.config.healthAddress]);
    const child = spawn(this.config.binaryPath, ["run", "--profile-dir", this.config.profileDir, "--profile", this.config.profileName], { stdio: "ignore", shell: false, detached: true });
    this.child = child;
    child.once("error", () => { this.running = false; this.healthy = false; this.lastFailure = "tunnel_process_failed"; });
    child.once("exit", () => { this.running = false; this.healthy = false; this.lastFailure = "tunnel_process_exited"; });
    this.running = true;
    const deadline = Date.now() + 120_000;
    try {
      do {
        if (!this.running) throw new RuntimeStateError("connector_unavailable", "Owned tunnel process exited", 503);
        if (await this.ready()) return;
        await Bun.sleep(1000);
      } while (Date.now() < deadline);
      throw new RuntimeStateError("connector_unavailable", "Owned tunnel readiness deadline exceeded", 503);
    } catch (error) { await this.stop(); throw error; }
  }
  async ready(): Promise<boolean> {
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
    this.stopping = this.stopOwned().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopOwned(): Promise<void> {
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
