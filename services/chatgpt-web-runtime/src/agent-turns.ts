import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import * as z from "zod/v4";
import { AGENT_MAX_TOOLS, AGENT_MAX_CALLS, AGENT_MAX_ARGUMENT_BYTES, AGENT_MAX_BATCH_BYTES, AGENT_TOOL_NAME, validateAgentSchema, agentSchemaDialect, createAgentSchemaValidator } from "../agent-request.js";
import type { BrokerToolRequest } from "./adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnProgressReader, ChatGptExternalTurnProgressSnapshot } from "./adapters/chatgpt-web/turn-progress";

export type AgentTurnErrorCode = "agent_tool_batch_invalid" | "agent_tool_choice_unsatisfied" | "agent_request_expired" | "agent_request_consumed";
const messages: Record<AgentTurnErrorCode, string> = {
  agent_tool_batch_invalid: "The proposed agent tool batch is invalid",
  agent_tool_choice_unsatisfied: "The required agent tool choice was not satisfied",
  agent_request_expired: "The agent request capability is invalid or expired",
  agent_request_consumed: "The agent request capability has already been consumed",
};
export class AgentTurnError extends Error {
  readonly status = 400;
  readonly retryable = false;
  readonly errorType = "invalid_request_error";
  constructor(readonly code: AgentTurnErrorCode) { super(messages[code]); this.name = "AgentTurnError"; }
}
export interface AgentFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}
export type AgentToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };
export interface AgentTurnRegistration {
  profileId: string;
  profileEpoch: string;
  requestId: string;
  model: string;
  effort?: string;
  tools: AgentFunctionTool[];
  toolChoice?: AgentToolChoice;
  parallelToolCalls?: boolean;
  ttlMs?: number;
}
export interface AgentToolProposal { name: string; arguments: Record<string, unknown> }
export interface AgentToolReceipt { queued: true; executed: false; call_count: number }
export interface AgentTurnWorkSnapshot { activeRequests: number; activeSubmissions: number }
export interface AgentTurnHandle {
  token: string;
  signal: AbortSignal;
  finish(): BrokerToolRequest[];
  revoke(): void;
  completionFence: { begin(): Promise<number | undefined>; commit(revision: number): Promise<boolean> };
  externalProgress: ChatGptTurnProgressReader;
}
const MAX_FRAME_BYTES = AGENT_MAX_BATCH_BYTES + 64 * 1024;
const IPC_TIMEOUT_MS = 5_000;
const MAX_TTL_MS = 30 * 60_000;
const proposalSchema = z.object({ name: z.string().regex(AGENT_TOOL_NAME), arguments: z.record(z.string(), z.unknown()) }).strict();
const requestFrameSchema = z.object({ id: z.string().min(1).max(64), method: z.literal("submit"), requestToken: z.string().min(1).max(64), calls: z.array(proposalSchema).min(1).max(AGENT_MAX_CALLS) }).strict();
const receiptSchema = z.object({ queued: z.literal(true), executed: z.literal(false), call_count: z.number().int().min(1).max(AGENT_MAX_CALLS) }).strict();
const responseFrameSchema = z.union([
  z.object({ id: z.string(), result: receiptSchema }).strict(),
  z.object({ id: z.string(), error: z.object({ code: z.enum(["agent_tool_batch_invalid", "agent_tool_choice_unsatisfied", "agent_request_expired", "agent_request_consumed"]) }).strict() }).strict(),
]);
function invalid(): never { throw new AgentTurnError("agent_tool_batch_invalid"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }

/** Queued proposals are progress, never active native/local tool invocations. */
class AgentProgress implements ChatGptTurnProgressReader {
  private revision = 0;
  private lastProgressAt?: number;
  private readonly listeners = new Set<() => void>();
  snapshot(): ChatGptExternalTurnProgressSnapshot { return { revision: this.revision, lastToolBatchRevision: 0, activeToolCalls: 0, lastProgressAt: this.lastProgressAt }; }
  advance(retired = false): void {
    this.revision++;
    if (!retired) this.lastProgressAt = Date.now();
    for (const listener of [...this.listeners]) listener();
  }
  async acknowledgeToolBatch(revision: number): Promise<void> { if (revision !== 0) invalid(); }
  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) return Promise.reject(new AgentTurnError("agent_tool_batch_invalid"));
    if (signal?.aborted) return Promise.reject(new DOMException("Agent progress wait aborted", "AbortError"));
    if (this.revision > afterRevision) return Promise.resolve(this.snapshot());
    const { promise, resolve, reject } = Promise.withResolvers<ChatGptExternalTurnProgressSnapshot>();
    const cleanup = () => { this.listeners.delete(changed); signal?.removeEventListener("abort", aborted); };
    const changed = () => { cleanup(); resolve(this.snapshot()); };
    const aborted = () => { cleanup(); reject(new DOMException("Agent progress wait aborted", "AbortError")); };
    this.listeners.add(changed);
    signal?.addEventListener("abort", aborted, { once: true });
    return promise;
  }
}
interface TurnState {
  binding: Readonly<AgentTurnRegistration>;
  validators: Map<string, ValidateFunction>;
  calls?: BrokerToolRequest[];
  revision: number;
  completed: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
  progress: AgentProgress;
  abort: AbortController;
}
const brokers = new Map<string, AgentTurnBroker>();
export class AgentTurnBroker {
  static forSocket(socketPath: string): AgentTurnBroker {
    if (!isAbsolute(socketPath)) invalid();
    let broker = brokers.get(socketPath);
    if (!broker) { broker = new AgentTurnBroker(socketPath); brokers.set(socketPath, broker); }
    return broker;
  }
  private server?: Server;
  private listening?: Promise<void>;
  private closing?: Promise<void>;
  private profileId?: string;
  private readonly turns = new Map<string, TurnState>();
  private readonly retired = new Map<string, AgentTurnErrorCode>();
  private readonly sockets = new Set<Socket>();
  private constructor(readonly socketPath: string) {}
  get workSnapshot(): AgentTurnWorkSnapshot {
    return { activeRequests: this.turns.size, activeSubmissions: this.sockets.size };
  }
  listen(): Promise<void> {
    if (this.closing) return Promise.reject(new AgentTurnError("agent_request_expired"));
    if (this.listening) return this.listening;
    this.listening = this.startListening().catch(error => { this.listening = undefined; throw error; });
    return this.listening;
  }
  private async startListening(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(this.socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
    let previous;
    try { previous = lstatSync(this.socketPath); }
    catch (error) { if (!isObject(error) || error.code !== "ENOENT") throw error; }
    if (previous) {
      if (!previous.isSocket() || typeof process.getuid === "function" && previous.uid !== process.getuid() || (previous.mode & 0o077) !== 0) invalid();
      const stale = await new Promise<boolean>((resolve) => {
        const probe = createConnection(this.socketPath);
        let settled = false;
        const finish = (value: boolean) => { if (settled) return; settled = true; probe.destroy(); resolve(value); };
        probe.setTimeout(2000, () => finish(false));
        probe.once("connect", () => finish(false));
        probe.once("error", error => finish(["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")));
      });
      if (!stale) invalid();
      try {
        const current = lstatSync(this.socketPath);
        if (current.dev !== previous.dev || current.ino !== previous.ino || !current.isSocket()) invalid();
        unlinkSync(this.socketPath);
      } catch (error) { if (!isObject(error) || error.code !== "ENOENT") throw error; }
    }
    const server = createServer(socket => this.accept(socket));
    this.server = server;
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const failed = (error: Error) => { server.removeListener("listening", ready); reject(error); };
      const ready = () => { server.removeListener("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen(this.socketPath);
      await promise;
      chmodSync(this.socketPath, 0o600);
      server.on("error", () => { for (const token of this.turns.keys()) this.retire(token, "agent_request_expired"); });
    } catch (error) { if (server.listening) server.close(); this.server = undefined; throw error; }
  }
  register(input: AgentTurnRegistration): AgentTurnHandle {
    if (this.closing || !this.server?.listening) throw new AgentTurnError("agent_request_expired");
    if (!isObject(input) || !exactKeys(input, ["profileId", "profileEpoch", "requestId", "model", "effort", "tools", "toolChoice", "parallelToolCalls", "ttlMs"])) invalid();
    if (!input || typeof input.profileId !== "string" || !input.profileId || typeof input.requestId !== "string" || !input.requestId
      || typeof input.model !== "string" || !input.model || typeof input.profileEpoch !== "string" || !input.profileEpoch
      || input.effort !== undefined && typeof input.effort !== "string" || !Array.isArray(input.tools) || input.tools.length > AGENT_MAX_TOOLS
      || input.parallelToolCalls !== undefined && typeof input.parallelToolCalls !== "boolean") invalid();
    if (this.profileId !== undefined && this.profileId !== input.profileId) invalid();
    const ttlMs = input.ttlMs ?? MAX_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS || this.turns.size >= 128) invalid();
    const binding = freeze(structuredClone({ ...input, toolChoice: input.toolChoice ?? "auto", parallelToolCalls: input.parallelToolCalls ?? true }));
    // Compiled schemas belong only to this request; no unbounded global cache.
    const schemaEngines = new Map<string, ReturnType<typeof createAgentSchemaValidator>>();
    const validators = new Map<string, ValidateFunction>();
    try {
      for (const tool of binding.tools) {
        if (!isObject(tool) || !exactKeys(tool, ["type", "name", "description", "parameters", "strict"]) || tool.type !== "function"
          || !AGENT_TOOL_NAME.test(tool.name) || validators.has(tool.name) || tool.strict !== undefined && typeof tool.strict !== "boolean"
          || tool.description !== undefined && typeof tool.description !== "string") invalid();
        const schema = validateAgentSchema(tool.parameters), dialect = agentSchemaDialect(schema);
        let ajv = schemaEngines.get(dialect);
        if (!ajv) { ajv = createAgentSchemaValidator(schema, true); addFormats(ajv); schemaEngines.set(dialect, ajv); }
        validators.set(tool.name, ajv.compile(schema));
      }
    } catch { invalid(); }
    const choice = binding.toolChoice;
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice) || choice === "required" && !validators.size) invalid();
    } else if (!isObject(choice) || !exactKeys(choice, ["type", "name"]) || choice.type !== "function" || !validators.has(choice.name)) invalid();
    this.profileId = input.profileId;
    const token = randomBytes(32).toString("base64url");
    const progress = new AgentProgress();
    const abort = new AbortController();
    const timer = setTimeout(() => this.retire(token, "agent_request_expired"), ttlMs);
    timer.unref?.();
    this.turns.set(token, { binding, validators, revision: 0, completed: false, expiresAt: Date.now() + ttlMs, timer, progress, abort });
    return {
      token,
      signal: abort.signal,
      finish: () => this.finish(token),
      revoke: () => { this.retire(token, "agent_request_expired"); },
      completionFence: {
        begin: async () => this.current(token).revision,
        commit: async revision => {
          const state = this.current(token);
          if (!Number.isSafeInteger(revision) || revision !== state.revision) return false;
          state.completed = true;
          return true;
        },
      },
      externalProgress: progress,
    };
  }
  submit(token: string, calls: AgentToolProposal[]): AgentToolReceipt {
    const state = this.current(token);
    if (state.calls || state.completed) throw new AgentTurnError("agent_request_consumed");
    const choice = state.binding.toolChoice;
    if (choice === "none" || !Array.isArray(calls) || !calls.length || calls.length > AGENT_MAX_CALLS
      || !state.binding.parallelToolCalls && calls.length > 1) invalid();
    let totalBytes = 0;
    const accepted: BrokerToolRequest[] = [];
    for (const call of calls) {
      if (!isObject(call) || !exactKeys(call, ["name", "arguments"]) || !isObject(call.arguments)
        || typeof call.name !== "string" || !AGENT_TOOL_NAME.test(call.name)
        || typeof choice === "object" && call.name !== choice.name) invalid();
      const validator = state.validators.get(call.name);
      let serialized: string;
      try { serialized = JSON.stringify(call.arguments); } catch { invalid(); }
      const length = Buffer.byteLength(serialized);
      totalBytes += length;
      if (length > AGENT_MAX_ARGUMENT_BYTES || totalBytes > AGENT_MAX_BATCH_BYTES || !validator) invalid();
      // Validate a JSON snapshot, never mutable caller-owned objects or coerced/defaulted data.
      const args: unknown = JSON.parse(serialized);
      if (!isObject(args)) invalid();
      if (!validator(args)) invalid();
      accepted.push({ callId: `call_${randomBytes(24).toString("base64url")}`, wireName: call.name, arguments: args, freeform: false });
    }
    // Validation and this first-batch commit are synchronous: no completion fence can interleave.
    state.calls = accepted;
    state.revision++;
    state.progress.advance();
    return { queued: true, executed: false, call_count: accepted.length };
  }
  private current(token: string): TurnState {
    const state = this.turns.get(token);
    if (state && state.expiresAt <= Date.now()) this.retire(token, "agent_request_expired");
    if (!state || !this.turns.has(token)) throw new AgentTurnError(this.retired.get(token) ?? "agent_request_expired");
    return state;
  }
  private finish(token: string): BrokerToolRequest[] {
    const state = this.current(token);
    const calls = state.calls ?? [];
    const unsatisfied = !calls.length && state.binding.toolChoice !== "auto" && state.binding.toolChoice !== "none";
    this.retire(token, "agent_request_consumed");
    if (unsatisfied) throw new AgentTurnError("agent_tool_choice_unsatisfied");
    return calls;
  }
  private retire(token: string, code: AgentTurnErrorCode): void {
    const state = this.turns.get(token);
    if (!state) return;
    this.turns.delete(token); clearTimeout(state.timer); state.progress.advance(true);
    if (code === "agent_request_expired") state.abort.abort(new AgentTurnError(code));
    this.retired.set(token, code);
    if (this.retired.size > 1024) this.retired.delete(this.retired.keys().next().value!);
  }
  private accept(socket: Socket): void {
    if (this.closing || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), IPC_TIMEOUT_MS);
    socket.once("close", () => { clearTimeout(deadline); this.sockets.delete(socket); });
    socket.on("error", () => socket.destroy());
    const chunks: Buffer[] = [];
    let frameBytes = 0;
    let settled = false;
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      frameBytes += chunk.length;
      if (frameBytes > MAX_FRAME_BYTES) { settled = true; socket.end(`${JSON.stringify({ error: { code: "agent_tool_batch_invalid" } })}\n`); return; }
      chunks.push(chunk);
      const end = chunk.indexOf(10);
      if (end < 0) return;
      settled = true;
      let requestId: string | undefined;
      try {
        if (end !== chunk.length - 1) invalid();
        const buffered = Buffer.concat(chunks, frameBytes);
        const frame = requestFrameSchema.parse(JSON.parse(buffered.subarray(0, frameBytes - 1).toString("utf8")));
        requestId = frame.id;
        const receipt = this.submit(frame.requestToken, frame.calls);
        socket.end(`${JSON.stringify({ id: requestId, result: receipt })}\n`);
      } catch (error) {
        const safe = error instanceof AgentTurnError ? error : new AgentTurnError("agent_tool_batch_invalid");
        socket.end(`${JSON.stringify({ id: requestId, error: { code: safe.code } })}\n`);
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      for (const token of this.turns.keys()) this.retire(token, "agent_request_expired");
      if (this.listening) { try { await this.listening; } catch {} }
      for (const socket of this.sockets) socket.destroy();
      const server = this.server;
      if (server?.listening) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close(error => error ? reject(error) : resolve());
        await promise;
      }
      // net.Server removes only its own Unix socket. Never unlink a path ourselves.
      this.server = undefined;
      brokers.delete(this.socketPath);
    })();
    return this.closing;
  }
}
export async function closeAgentTurnBrokers(): Promise<void> { await Promise.all([...brokers.values()].map(broker => broker.close())); }
export async function submitAgentToolCalls(socketPath: string, requestToken: string, calls: AgentToolProposal[], signal?: AbortSignal): Promise<AgentToolReceipt> {
  const id = randomBytes(16).toString("hex");
  let frame: string;
  try { frame = `${JSON.stringify({ id, method: "submit", requestToken, calls })}\n`; } catch { invalid(); }
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) invalid();
  if (signal?.aborted) throw new DOMException("Agent handoff aborted", "AbortError");
  const { promise, resolve, reject } = Promise.withResolvers<AgentToolReceipt>();
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let frameBytes = 0;
    let settled = false;
    const finish = (error?: Error, receipt?: AgentToolReceipt) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(receipt!);
    };
    const abort = () => finish(new DOMException("Agent handoff aborted", "AbortError"));
    const timer = setTimeout(() => finish(new AgentTurnError("agent_request_expired")), IPC_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => finish(new AgentTurnError("agent_request_expired")));
    socket.once("close", () => { if (!settled) finish(new AgentTurnError("agent_request_expired")); });
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      frameBytes += chunk.length;
      if (frameBytes > 4096) { finish(new AgentTurnError("agent_tool_batch_invalid")); return; }
      chunks.push(chunk);
      const end = chunk.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== chunk.length - 1) invalid();
        const buffered = Buffer.concat(chunks, frameBytes);
        const response = responseFrameSchema.parse(JSON.parse(buffered.subarray(0, frameBytes - 1).toString("utf8")));
        if (response.id !== id) invalid();
        if ("error" in response) finish(new AgentTurnError(response.error.code));
        else finish(undefined, response.result);
      } catch (error) { finish(error instanceof AgentTurnError ? error : new AgentTurnError("agent_tool_batch_invalid")); }
    });
  return promise;
}
