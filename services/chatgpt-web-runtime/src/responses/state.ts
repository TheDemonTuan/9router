import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../config";
import { runtimeExecutionScope, runtimeScopeKey, scopedStatePath } from "../runtime-scope";
import type { RuntimeExecutionScope } from "../runtime-scope";

const MAX_STORED_RESPONSES = 1000;
const RESPONSE_TTL_MS = 60 * 60 * 1000;
const SNAPSHOT_DEBOUNCE_MS = 2000;
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
interface StoredResponseState { createdAt: number; items: unknown[]; sizeBytes: number; }
const replayedInputPrefixLengths = new WeakMap<object, number>();
const stores = new Map<string, ScopedResponseStore>();
function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  return typeof input === "string" ? [{ role: "user", content: input }] : [input];
}
class ScopedResponseStore {
  private readonly states = new Map<string, StoredResponseState>();
  private bytes = 0;
  private timer: Timer | undefined;
  private readonly path: string;
  constructor(scope: RuntimeExecutionScope) {
    this.path = scopedStatePath(scope, "responses-state.json");
    if (!existsSync(this.path)) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.path, "utf8"));
      if (snapshot.version !== 2 || snapshot.namespace !== runtimeScopeKey(scope) || !Array.isArray(snapshot.states)) return;
      for (const pair of snapshot.states) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !Number.isFinite(pair[1]?.createdAt) || !Array.isArray(pair[1]?.items)) continue;
        this.insert(pair[0], pair[1].createdAt, pair[1].items);
      }
      this.prune();
    } catch { /* Missing/corrupt private cache never grants continuation. */ }
  }
  private insert(id: string, createdAt: number, items: unknown[]): void {
    this.delete(id);
    const sizeBytes = Buffer.byteLength(JSON.stringify(items));
    this.states.set(id, { createdAt, items, sizeBytes }); this.bytes += sizeBytes;
  }
  private delete(id: string): void {
    const entry = this.states.get(id); if (!entry) return;
    this.bytes -= entry.sizeBytes; this.states.delete(id);
  }
  private prune(): void {
    const cutoff = Date.now() - RESPONSE_TTL_MS;
    for (const [id, state] of this.states) if (state.createdAt < cutoff) this.delete(id);
    while (this.states.size > MAX_STORED_RESPONSES || this.bytes > MAX_STORED_RESPONSE_BYTES) {
      const first = this.states.keys().next().value;
      if (first === undefined) break;
      this.delete(first);
    }
  }
  expand(request: Record<string, unknown>): unknown {
    this.prune();
    const previous = typeof request.previous_response_id === "string" ? this.states.get(request.previous_response_id) : undefined;
    if (!previous) return request;
    const expanded = { ...request, input: [...previous.items, ...inputItems(request.input)] };
    replayedInputPrefixLengths.set(expanded, previous.items.length);
    return expanded;
  }
  remember(request: Record<string, unknown>, response: { id: string; output: unknown[] }): void {
    this.insert(response.id, Date.now(), [...inputItems(request.input), ...response.output]); this.prune();
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), SNAPSHOT_DEBOUNCE_MS); this.timer.unref(); }
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const entries: [string, { createdAt: number; items: unknown[] }][] = [];
    let bytes = 0;
    for (const [id, state] of [...this.states].reverse()) {
      const entry: [string, { createdAt: number; items: unknown[] }] = [id, { createdAt: state.createdAt, items: state.items }];
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (bytes + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      bytes += size; entries.push(entry);
    }
    entries.reverse();
    const namespace = this.path.split(/[\\/]/).at(-2);
    atomicWriteFile(this.path, JSON.stringify({ version: 2, namespace, states: entries }));
  }
}
function scopedStore(): ScopedResponseStore {
  const scope = runtimeExecutionScope.getStore();
  if (!scope) throw new Error("Responses continuation requires exact runtime execution scope");
  const key = runtimeScopeKey(scope);
  let store = stores.get(key);
  if (!store) { store = new ScopedResponseStore(scope); stores.set(key, store); }
  return store;
}
export function flushResponseState(): void {
  for (const store of stores.values()) store.flush();
}
export function closeResponseState(): void {
  flushResponseState();
  stores.clear();
}
export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  if (typeof request.previous_response_id !== "string") return body;
  return scopedStore().expand(request);
}
export function previousResponseReplayPrefixLength(body: unknown): number {
  return body && typeof body === "object" ? replayedInputPrefixLengths.get(body) ?? 0 : 0;
}
export function rememberResponseState(requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown }, opts?: { force?: boolean }): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  if (request.store === false && !opts?.force || typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || !("reason" in details) || details.reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  scopedStore().remember(request, { id: response.id, output: response.output });
}
