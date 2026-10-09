import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CodexProviderConfig } from "./types";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";
import type { ChatGptTurnEnvironment } from "./adapters/chatgpt-web/environment";
import { z } from "zod";

export type RuntimeMode = "browser-only" | "full";
export const CHATGPT_CONNECTOR_NAME = "Codex Native2";
export const DEV_CHATGPT_CONNECTOR_NAME = `${CHATGPT_CONNECTOR_NAME} DEV`;
export const LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"] as const;
export function isLegacyChatGptConnectorName(value: string): boolean {
  return (LEGACY_CHATGPT_CONNECTOR_NAMES as readonly string[]).includes(value);
}
export function legacyChatGptConnectorMigrationMessage(name: string): string {
  return `Connector ${JSON.stringify(name)} is retired; configure ${CHATGPT_CONNECTOR_NAME}.`;
}
export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
}
export function getConfigDir(): string {
  const configured = process.env.CGW_DATA_DIR?.trim();
  if (!configured) throw new Error("CGW_DATA_DIR is required; no user-home fallback is permitted");
  return resolve(configured);
}
export function defaultChromeExecutable(): string {
  return process.env.CGW_CHROMIUM_EXECUTABLE?.trim() || "/usr/bin/chromium";
}
export function isWindowsPipeEndpoint(value: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}
export function defaultBrokerEndpoint(home = getConfigDir(), platform = process.platform): string {
  if (platform !== "win32") return join(home, "run", "turn-broker.sock");
  const identity = createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 20);
  return `\\\\.\\pipe\\9router-cgw-${identity}`;
}
export function resolveBrokerEndpoint(value: string): string {
  return isWindowsPipeEndpoint(value) ? value : resolve(value);
}
const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;
export function atomicWriteFile(path: string, data: string | Uint8Array,
  { mode = 0o600, protectDirectory = true }: { mode?: number; protectDirectory?: boolean } = {}): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (protectDirectory) chmodSync(directory, 0o700);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
        if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(code || "") || delay === undefined) throw error;
        Atomics.wait(atomicWaitCell, 0, 0, delay);
      }
    }
    chmodSync(path, mode);
    if (process.platform !== "win32") {
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}
export function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}
export interface ProfileSettings {
  mode: RuntimeMode;
  experimentalBiggerContext: boolean;
  experimentalFreshConversationPerTurn: boolean;
  useSavedChats: boolean;
  autoApproveToolCalls: boolean;
  connectorName: "Codex Native2";
}
export const DEFAULT_PROFILE_SETTINGS: Readonly<ProfileSettings> = Object.freeze({
  mode: "browser-only", experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false,
  useSavedChats: false, autoApproveToolCalls: false, connectorName: CHATGPT_CONNECTOR_NAME,
});
export const profileSettingsSchema = z.object({
  mode: z.enum(["browser-only", "full"]),
  experimentalBiggerContext: z.boolean(), experimentalFreshConversationPerTurn: z.boolean(),
  useSavedChats: z.boolean(), autoApproveToolCalls: z.boolean(), connectorName: z.literal("Codex Native2"),
}).strict();

export interface RuntimeResourceLimits {
  maxGlobalBrowsers: number;
  maxGlobalTurns: number;
  maxGlobalTabs: number;
  maxRetainedTabsPerProfile: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
  browserIdleTtlMs: number;
  browserMode: "headed" | "headless-text";
  adaptiveDomPolling: boolean;
}

export const DEFAULT_RUNTIME_RESOURCE_LIMITS: Readonly<RuntimeResourceLimits> = Object.freeze({
  maxGlobalBrowsers: 2,
  maxGlobalTurns: 2,
  maxGlobalTabs: 10,
  maxRetainedTabsPerProfile: 5,
  maxQueueSize: 16,
  queueTimeoutMs: 30_000,
  browserIdleTtlMs: 300_000,
  browserMode: "headed",
  adaptiveDomPolling: false,
});

export function loadRuntimeResourceLimits(env: NodeJS.ProcessEnv = process.env): RuntimeResourceLimits {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid ${name}: expected an integer ${min}..${max}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected an integer ${min}..${max}`);
    return value;
  };
  const browserMode = env.CGW_BROWSER_MODE ?? "headed";
  if (browserMode !== "headed" && browserMode !== "headless-text") throw new Error("Invalid CGW_BROWSER_MODE: expected headed or headless-text");
  const adaptive = env.CGW_ADAPTIVE_DOM_POLLING ?? "false";
  if (adaptive !== "true" && adaptive !== "false") throw new Error("Invalid CGW_ADAPTIVE_DOM_POLLING: expected true or false");
  return {
    maxGlobalBrowsers: integer("CGW_MAX_GLOBAL_BROWSERS", 2, 1, 32),
    maxGlobalTurns: integer("CGW_MAX_GLOBAL_TURNS", 2, 1, 64),
    maxGlobalTabs: integer("CGW_MAX_GLOBAL_TABS", 10, 5, 160),
    maxRetainedTabsPerProfile: integer("CGW_MAX_RETAINED_TABS_PER_PROFILE", 5, 1, 5),
    maxQueueSize: integer("CGW_MAX_QUEUE_SIZE", 16, 0, 128),
    queueTimeoutMs: integer("CGW_QUEUE_TIMEOUT_MS", 30_000, 1_000, 120_000),
    browserIdleTtlMs: integer("CGW_BROWSER_IDLE_TTL_MS", 300_000, 1_000, 3_600_000),
    browserMode,
    adaptiveDomPolling: adaptive === "true",
  };
}

export type BrowserPurpose = "inference" | "inspection" | "login" | "viewer" | "connector";

export function resolveProfileBrowserMode(
  settings: ProfileSettings | undefined,
  purpose: BrowserPurpose,
  configuredMode: "headed" | "headless-text" = "headed",
): "headed" | "headless" {
  if (purpose === "login" || purpose === "viewer" || purpose === "connector") return "headed";
  if (settings?.mode === "full") return "headed";
  if (configuredMode === "headless-text" && (purpose === "inference" || purpose === "inspection")) return "headless";
  return "headed";
}

export interface RuntimeConfig {
  dataDir: string;
  host: string;
  port: number;
  chromiumExecutable: string;
  runtimeToken: Buffer;
  adminToken: Buffer;
  resourceLimits?: RuntimeResourceLimits;
}

function secretFile(name: string): Buffer {
  const file = process.env[name]?.trim();
  if (!file) throw new Error(`${name} is required`);
  const value = readFileSync(file, "utf8").trim();
  if (value.length < 32 || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`${name} contains an invalid bearer token`);
  return Buffer.from(value, "utf8");
}

export function loadRuntimeConfig(): RuntimeConfig {
  const port = Number(process.env.CGW_PORT || 17841);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CGW_PORT");
  const runtimeToken = secretFile("CGW_RUNTIME_TOKEN_FILE");
  const adminToken = secretFile("CGW_ADMIN_TOKEN_FILE");
  if (runtimeToken.length === adminToken.length && timingSafeEqual(runtimeToken, adminToken)) throw new Error("Runtime and admin bearer tokens must differ");
  return {
    dataDir: getConfigDir(),
    host: "0.0.0.0",
    port,
    chromiumExecutable: defaultChromeExecutable(),
    runtimeToken,
    adminToken,
    resourceLimits: loadRuntimeResourceLimits(),
  };
}

export function tokenMatches(header: string | null, secret: Buffer): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

export function providerConfig(options: {
  profileId: string; profileEpoch: string; clientId: string; pathFlavor: "win32" | "posix";
  settings: ProfileSettings; capabilities: ChatGptWebAccountCapabilities; verifiedEnvironment: ChatGptTurnEnvironment;
  dataDir: string; contextWindow: number;
  browserMode?: "headed" | "headless-text";
  chromiumExecutable?: string;
}): CodexProviderConfig {
  const { profileId, profileEpoch, clientId, pathFlavor, settings, capabilities, verifiedEnvironment, dataDir, browserMode } = options;
  const profileRoot = join(dataDir, "profiles", profileId);
  const stateRoot = join(profileRoot, "state", createHash("sha256").update(JSON.stringify([profileId, profileEpoch, clientId])).digest("hex"));
  const effectiveMode = resolveProfileBrowserMode(settings, "inference", browserMode ?? "headed");
  return {
    adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", contextWindow: options.contextWindow,
    chatgptWeb: {
      profileId, profileEpoch, clientId, pathFlavor, verifiedEnvironment, browserProfilePath: join(profileRoot, "browser"),
      chromeExecutablePath: options.chromiumExecutable ?? defaultChromeExecutable(), headed: effectiveMode === "headed", appName: settings.connectorName,
      brokerSocketPath: defaultBrokerEndpoint(profileRoot),
      threadEnvironmentStatePath: join(stateRoot, "thread-environments.json"),
      lunaCheckpointStatePath: join(stateRoot, "luna-checkpoints.json"),
      localToolsEnabled: settings.mode === "full", solAvailable: capabilities.solAvailable,
      extraHighAvailable: capabilities.extraHighAvailable, proAvailable: capabilities.proAvailable,
      experimentalBiggerContext: settings.experimentalBiggerContext,
      experimentalFreshConversationPerTurn: settings.experimentalFreshConversationPerTurn,
      useSavedChats: settings.useSavedChats, autoApproveToolCalls: settings.autoApproveToolCalls,
    },
  };
}

export function browserProviderConfig(options: {
  profileId: string; profileEpoch: string; requestId: string;
  settings: ProfileSettings; capabilities: ChatGptWebAccountCapabilities;
  dataDir: string; contextWindow: number;
  browserMode?: "headed" | "headless-text";
  chromiumExecutable?: string;
}): CodexProviderConfig {
  const { profileId, profileEpoch, requestId, settings, capabilities, dataDir, browserMode } = options;
  const effectiveMode = resolveProfileBrowserMode(settings, "inference", browserMode ?? "headed");
  return {
    adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", contextWindow: options.contextWindow,
    chatgptWeb: {
      profileId, profileEpoch, clientId: `browser:${requestId}`,
      browserProfilePath: join(dataDir, "profiles", profileId, "browser"),
      chromeExecutablePath: options.chromiumExecutable ?? defaultChromeExecutable(), headed: effectiveMode === "headed",
      localToolsEnabled: false, autoApproveToolCalls: false,
      experimentalFreshConversationPerTurn: true, useSavedChats: false,
      experimentalBiggerContext: settings.experimentalBiggerContext,
      solAvailable: capabilities.solAvailable, extraHighAvailable: capabilities.extraHighAvailable,
      proAvailable: capabilities.proAvailable,
    },
  };
}
