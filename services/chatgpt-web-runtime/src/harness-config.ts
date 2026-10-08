import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./config";
import { RuntimeStateError } from "./runtime-state";
import { validateProfileId } from "../protocol.js";
import { allocateProfileTunnelHealth, assertRegularFile, buildProfileTunnelConfig, ensurePrivateDirectory, releaseProfileTunnelHealth, validateTunnelId } from "./tunnel";
import type { ProfileTunnelConfig } from "./tunnel";

export interface HarnessConfigDescription {
  source: "none" | "managed" | "operator";
  configRevision: number;
  tunnelId: string | null;
  keyConfigured: boolean;
}
interface SavedHarnessConfig { version: 1; configRevision: number; tunnelId: string; runtimeApiKey: string; }
export interface HarnessConfigInput { tunnelId: string; runtimeApiKey?: string; }

function storageError(): RuntimeStateError {
  return new RuntimeStateError("harness_storage_invalid", "Runtime harness storage is unavailable or unsafe", 503);
}
function runtimeKey(value: unknown): string {
  if (typeof value !== "string") throw new RuntimeStateError("harness_key_invalid", "Enter a single-line Runtime API key", 400);
  const key = value.trim(), bytes = Buffer.byteLength(key, "utf8");
  if (bytes < 32 || bytes > 4096 || /[\r\n\0]/.test(key) || key.startsWith("sk-admin-")) {
    throw new RuntimeStateError("harness_key_invalid", "Enter a Runtime API key, not an admin key", 400);
  }
  return key;
}
function readPrivateFile(path: string): string | undefined {
  if (!assertRegularFile(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw storageError();
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export class HarnessConfigStore {
  private readonly prepared = new Map<string, ProfileTunnelConfig>();
  private readonly preparing = new Map<string, Promise<ProfileTunnelConfig>>();
  readonly dataDir: string;
  constructor(dataDir: string, private readonly operatorConfigs: Record<string, ProfileTunnelConfig> = {}) {
    this.dataDir = resolve(dataDir);
  }
  private profile(profileId: string): string {
    validateProfileId(profileId);
    return join(this.dataDir, "profiles", profileId);
  }
  private operator(profileId: string): ProfileTunnelConfig | undefined {
    return Object.hasOwn(this.operatorConfigs, profileId) ? this.operatorConfigs[profileId] : undefined;
  }
  private saved(profileId: string): SavedHarnessConfig | undefined {
    const file = join(this.profile(profileId), "secrets", "harness.json");
    try {
      ensurePrivateDirectory(this.dataDir, dirname(file), false);
      const text = readPrivateFile(file);
      if (text === undefined) return undefined;
      const value = JSON.parse(text);
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.configRevision) || value.configRevision < 1
        || Object.keys(value).sort().join(",") !== "configRevision,runtimeApiKey,tunnelId,version") throw storageError();
      const tunnelId = validateTunnelId(value.tunnelId), key = runtimeKey(value.runtimeApiKey);
      if (tunnelId !== value.tunnelId || key !== value.runtimeApiKey) throw storageError();
      return { version: 1, configRevision: value.configRevision, tunnelId, runtimeApiKey: key };
    } catch { throw storageError(); }
  }
  describe(profileId: string): HarnessConfigDescription {
    this.profile(profileId);
    const operator = this.operator(profileId);
    if (operator) return { source: "operator", configRevision: 0, tunnelId: operator.tunnelId, keyConfigured: true };
    const saved = this.saved(profileId);
    return saved ? { source: "managed", configRevision: saved.configRevision, tunnelId: saved.tunnelId, keyConfigured: true }
      : { source: "none", configRevision: 0, tunnelId: null, keyConfigured: false };
  }
  private validatedConfiguration(profileId: string, expectedConfigRevision: number, input: HarnessConfigInput): SavedHarnessConfig {
    this.profile(profileId);
    if (this.operator(profileId)) throw new RuntimeStateError("harness_operator_managed", "This profile's tunnel is managed by the runtime operator", 409);
    const previous = this.saved(profileId);
    if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 0 || expectedConfigRevision !== (previous?.configRevision ?? 0)) {
      throw new RuntimeStateError("harness_config_conflict", "Harness configuration changed; refresh before saving", 409);
    }
    if (!input || typeof input !== "object" || Object.keys(input).some(key => !["tunnelId", "runtimeApiKey"].includes(key))) {
      throw new RuntimeStateError("harness_config_invalid", "Invalid harness configuration", 400);
    }
    const tunnelId = validateTunnelId(input.tunnelId);
    if (input.runtimeApiKey === undefined && !previous) throw new RuntimeStateError("harness_key_required", "A Runtime API key is required for the first save", 400);
    const key = input.runtimeApiKey === undefined ? previous!.runtimeApiKey : runtimeKey(input.runtimeApiKey);
    const configRevision = (previous?.configRevision ?? 0) + 1;
    if (!Number.isSafeInteger(configRevision)) throw new RuntimeStateError("harness_config_conflict", "Harness configuration revision limit reached", 409);
    return { version: 1, configRevision, tunnelId, runtimeApiKey: key };
  }
  validateConfiguration(profileId: string, expectedConfigRevision: number, input: HarnessConfigInput): void {
    this.validatedConfiguration(profileId, expectedConfigRevision, input);
  }
  configure(profileId: string, expectedConfigRevision: number, input: HarnessConfigInput): HarnessConfigDescription {
    const config = this.validatedConfiguration(profileId, expectedConfigRevision, input);
    if (this.prepared.has(profileId) || this.preparing.has(profileId)) throw new RuntimeStateError("harness_config_conflict", "Stop the tunnel before changing its configuration", 409);
    const file = join(this.profile(profileId), "secrets", "harness.json");
    try {
      ensurePrivateDirectory(this.dataDir, dirname(file));
      assertRegularFile(file);
      atomicWriteFile(file, JSON.stringify(config), { mode: 0o600 });
    } catch { throw storageError(); }
    return { source: "managed", configRevision: config.configRevision, tunnelId: config.tunnelId, keyConfigured: true };
  }
  processConfig(profileId: string): Promise<ProfileTunnelConfig> {
    this.profile(profileId);
    const existing = this.prepared.get(profileId);
    if (existing) return Promise.resolve(existing);
    const pending = this.preparing.get(profileId);
    if (pending) return pending;
    const preparing = this.prepare(profileId).finally(() => { this.preparing.delete(profileId); });
    this.preparing.set(profileId, preparing);
    return preparing;
  }
  private async prepare(profileId: string): Promise<ProfileTunnelConfig> {
    const operator = this.operator(profileId), saved = operator ? undefined : this.saved(profileId);
    if (!operator && !saved) throw new RuntimeStateError("harness_config_missing", "Save a Tunnel ID and Runtime API key first", 409);
    const tunnelId = validateTunnelId(operator?.tunnelId ?? saved!.tunnelId);
    const profile = this.profile(profileId), keyFile = join(profile, "run", "tunnel-runtime-key");
    let config: ProfileTunnelConfig | undefined;
    let keyWritten = false;
    try {
      ensurePrivateDirectory(this.dataDir, dirname(keyFile));
      assertRegularFile(keyFile);
      const key = operator ? runtimeKey(readPrivateFile(operator.runtimeKeyFile)) : saved!.runtimeApiKey;
      atomicWriteFile(keyFile, key, { mode: 0o600 });
      keyWritten = true;
      config = buildProfileTunnelConfig(this.dataDir, profileId, tunnelId, keyFile);
      const preparedConfig = config;
      config.cleanup = () => {
        releaseProfileTunnelHealth(preparedConfig);
        ensurePrivateDirectory(this.dataDir, dirname(keyFile));
        if (assertRegularFile(keyFile)) unlinkSync(keyFile);
        if (this.prepared.get(profileId) === preparedConfig) this.prepared.delete(profileId);
      };
      await allocateProfileTunnelHealth(config);
      this.prepared.set(profileId, config);
      return config;
    } catch {
      if (config) releaseProfileTunnelHealth(config);
      try {
        if (keyWritten) {
          ensurePrivateDirectory(this.dataDir, dirname(keyFile));
          if (assertRegularFile(keyFile)) unlinkSync(keyFile);
        }
      } catch {}
      throw storageError();
    }
  }
  async cleanup(profileId: string): Promise<void> {
    this.profile(profileId);
    const pending = this.preparing.get(profileId);
    if (pending) { try { await pending; } catch {} }
    const config = this.prepared.get(profileId);
    try {
      if (config) config.cleanup?.();
      else {
        const file = join(this.profile(profileId), "run", "tunnel-runtime-key");
        ensurePrivateDirectory(this.dataDir, dirname(file));
        if (assertRegularFile(file)) unlinkSync(file);
      }
    } catch { throw storageError(); }
  }
}
