import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { atomicWriteFile } from "../../config";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, type ChatGptSandboxPolicy, type ChatGptTurnEnvironment } from "./environment";

export type ChatGptPathFlavor = "win32" | "posix";
export type VerifiedChatGptEnvironment = Pick<ChatGptTurnEnvironment, "cwd" | "roots" | "writableRoots" | "sandboxPolicy">;

interface StoredThreadEnvironment extends VerifiedChatGptEnvironment {
  pathFlavor: ChatGptPathFlavor;
  updatedAt: number;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || (parsed.pathFlavor !== "win32" && parsed.pathFlavor !== "posix")
    || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
    throw new Error("Invalid persisted ChatGPT remote environment");
  }
  const paths = parsed.pathFlavor === "win32" ? win32 : posix;
  const identity = (path: string): string => parsed.pathFlavor === "win32"
    ? paths.normalize(path).toLowerCase() : paths.normalize(path);
  const absolute = (value: unknown): string => {
    if (typeof value !== "string" || !paths.isAbsolute(value)) {
      throw new Error("ChatGPT remote authority requires absolute client paths");
    }
    return paths.normalize(value);
  };
  const list = (value: unknown, allowEmpty = false): string[] => {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
      throw new Error("Invalid ChatGPT remote authority roots");
    }
    const unique = new Map<string, string>();
    for (const entry of value) {
      const path = absolute(entry);
      unique.set(identity(path), path);
    }
    return [...unique.values()];
  };
  const same = (left: string[], right: string[]): boolean => {
    const expected = new Set(right.map(identity));
    return left.length === expected.size && left.every(path => expected.has(identity(path)));
  };
  const cwd = absolute(parsed.cwd);
  const roots = list(parsed.roots);
  const writableRoots = list(parsed.writableRoots, true);
  if (!roots.some(root => {
    const relative = paths.relative(identity(root), identity(cwd));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  })) throw new Error("ChatGPT remote cwd is outside its declared roots");
  const policy = record(parsed.sandboxPolicy);
  let sandboxPolicy: ChatGptSandboxPolicy;
  if (policy?.type === "dangerFullAccess" && same(roots, writableRoots)) {
    sandboxPolicy = { type: "dangerFullAccess" };
  } else if (policy?.type === "readOnly" && typeof policy.networkAccess === "boolean" && writableRoots.length === 0) {
    sandboxPolicy = { type: "readOnly", networkAccess: policy.networkAccess };
  } else if (policy?.type === "workspaceWrite" && typeof policy.networkAccess === "boolean"
    && same(list(policy.writableRoots), writableRoots)) {
    sandboxPolicy = { type: "workspaceWrite", writableRoots, networkAccess: policy.networkAccess };
  } else {
    throw new Error("Invalid ChatGPT remote sandbox policy");
  }
  return { cwd, roots, writableRoots, sandboxPolicy, pathFlavor: parsed.pathFlavor, updatedAt: parsed.updatedAt };
}

/** Stores verified authority for diagnostics/persistence, never as proof for a later request. */
export class ChatGptThreadEnvironmentStore {
  private static readonly stores = new Map<string, ChatGptThreadEnvironmentStore>();
  static forPath(path: string): ChatGptThreadEnvironmentStore {
    let store = this.stores.get(path);
    if (!store) { store = new ChatGptThreadEnvironmentStore(path); this.stores.set(path, store); }
    return store;
  }
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {}

  resolveVerified(
    parsed: CodexParsedRequest,
    verified: VerifiedChatGptEnvironment,
    pathFlavor: ChatGptPathFlavor,
    executionNamespace: string,
  ): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!executionNamespace || !identity.threadId || !identity.turnId) {
      throw new Error("ChatGPT remote authority requires exact native thread and turn identity");
    }
    const environment = validateStoredEnvironment({ ...verified, pathFlavor, updatedAt: this.now() });
    this.load();
    const key = JSON.stringify([executionNamespace, identity.threadId]);
    this.threads.delete(key);
    this.threads.set(key, environment);
    this.prune();
    this.persist();
    const { updatedAt: _updatedAt, ...authority } = environment;
    // Signed authority does not grant cached tools. Only this request's inventory is available.
    return { ...authority, executionScope: { namespace: executionNamespace, threadId: identity.threadId, turnId: identity.turnId }, tools: parsed.context.tools ?? [] };
  }

  private prune(): void {
    const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
    for (const [key, environment] of this.threads) {
      if (environment.updatedAt < cutoff) this.threads.delete(key);
    }
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      this.threads.delete(this.threads.keys().next().value!);
    }
  }

  private load(): void {
    if (this.loaded) return;
    if (this.path && existsSync(this.path)) {
      const parsed = record(JSON.parse(readFileSync(this.path, "utf8")));
      const threads = record(parsed?.threads);
      if (parsed?.version !== 2 || !threads) throw new Error("Unsupported ChatGPT remote environment store");
      const entries = Object.entries(threads).map(([key, value]) => [key, validateStoredEnvironment(value)] as const)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      for (const [key, environment] of entries) this.threads.set(key, environment);
      this.prune();
    }
    this.loaded = true;
  }

  private persist(): void {
    if (this.path) atomicWriteFile(this.path, `${JSON.stringify({ version: 2, threads: Object.fromEntries(this.threads) })}\n`, { mode: 0o600 });
  }
}
