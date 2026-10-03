export type ChatGptProgressSource =
  | "mcp_call" | "mcp_result" | "tool_batch" | "tool_result"
  | "assistant_dom" | "multipart_ack" | "generation_transition" | "checkpoint";
export type ChatGptProgressListener = (source: ChatGptProgressSource, revision: number) => void;
export const COMPACTION_IDLE_TIMEOUT_MS = 300_000;

/** One idle clock for all phases; a bound capability and the abort timer renew synchronously. */
export class ChatGptCompactionIdleDeadline {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer?: NodeJS.Timeout;
  private expiresAt: number;
  private closed = false;
  private readonly revisions = new Map<ChatGptProgressSource, number>();
  private renewTransaction?: (ttlMs: number, now: number) => boolean;

  constructor(
    private readonly timeoutError: Error,
    private readonly ttlMs = COMPACTION_IDLE_TIMEOUT_MS,
    private readonly now = () => performance.now(),
  ) {
    this.expiresAt = this.now() + ttlMs;
    this.arm(ttlMs);
  }

  bindTransaction(renew: (ttlMs: number, now: number) => boolean): () => void {
    this.renewTransaction = renew;
    const now = this.now();
    if (!this.isActive(now) || !renew(this.expiresAt - now, now)) this.expire();
    else this.arm(this.expiresAt - now);
    return () => { if (this.renewTransaction === renew) this.renewTransaction = undefined; };
  }

  noteProgress: ChatGptProgressListener = (source, revision) => {
    const now = this.now();
    if (!Number.isSafeInteger(revision) || revision <= (this.revisions.get(source) ?? 0)
      || !this.isActive(now)) return;
    if (this.renewTransaction && !this.renewTransaction(this.ttlMs, now)) return;
    this.revisions.set(source, revision);
    this.expiresAt = now + this.ttlMs;
    this.arm(this.ttlMs);
  };

  /** Different browser phases have independent revision sequences, never replay each other's IDs. */
  reporter(): ChatGptProgressListener {
    const seen = new Map<ChatGptProgressSource, number>();
    return (source, revision) => {
      if (!Number.isSafeInteger(revision) || revision <= (seen.get(source) ?? 0)) return;
      seen.set(source, revision);
      this.noteProgress(source, (this.revisions.get(source) ?? 0) + 1);
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.renewTransaction = undefined;
  }

  private isActive(now: number): boolean {
    if (this.closed || this.signal.aborted) return false;
    if (now >= this.expiresAt) { this.expire(); return false; }
    return true;
  }

  private expire(): void {
    if (this.closed || this.signal.aborted) return;
    clearTimeout(this.timer);
    this.controller.abort(this.timeoutError);
  }

  private arm(ttlMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), ttlMs);
    this.timer.unref?.();
  }
}

/** Filters response projection changes, not arbitrary DOM mutations or spinner animation. */
export class ChatGptBrowserProgress {
  private readonly revisions = new Map<ChatGptProgressSource, number>();
  private readonly projections = new Map<string, string>();
  private readonly generations = new Map<string, boolean>();
  constructor(private readonly listener?: ChatGptProgressListener) {}

  record(source: ChatGptProgressSource): void {
    const revision = (this.revisions.get(source) ?? 0) + 1;
    this.revisions.set(source, revision);
    this.listener?.(source, revision);
  }

  observe(identity: string, projection: string, running: boolean, completionVisible: boolean): void {
    const previous = this.projections.get(identity) ?? "";
    // A virtualized prefix/remount is not new output. Accept only new projection growth.
    const grew = projection.length > previous.length && projection.startsWith(previous);
    if (grew) {
      this.projections.set(identity, projection);
      this.record("assistant_dom");
    }
    const previousRunning = this.generations.get(identity);
    if (previousRunning !== running
      && (previousRunning === undefined ? running : grew || completionVisible)) {
      this.generations.set(identity, running);
      this.record("generation_transition");
    }
  }
}

export interface ChatGptExternalTurnProgressSnapshot {
  revision: number;
  lastToolBatchRevision: number;
  activeToolCalls: number;
  lastProgressAt?: number;
}

interface ProgressWaiter {
  afterRevision: number;
  resolve: (snapshot: ChatGptExternalTurnProgressSnapshot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ToolBatchObservationWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * The read surface the browser worker depends on.
 *
 * The worker observes broker-recorded activity and acknowledges only the pre-dispatch answer
 * boundary it captured. Both ends share this causal reader inside the runtime process.
 */
export interface ChatGptTurnProgressReader {
  snapshot(): ChatGptExternalTurnProgressSnapshot;
  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot>;
  /** Confirm that the browser captured its answer projection before this batch was dispatched. */
  acknowledgeToolBatch(revision: number): Promise<void>;
}

/**
 * Carries only proven Codex MCP activity into the browser worker.
 *
 * It is deliberately not a completion channel: browser-visible text and terminal state remain
 * owned by the ChatGPT DOM. A valid current-turn tool request only proves that submission was
 * accepted and that the model is still making progress while its DOM is temporarily unavailable.
 */
abstract class ChatGptTurnProgressBroadcaster implements ChatGptTurnProgressReader {
  private readonly waiters = new Set<ProgressWaiter>();

  abstract snapshot(): ChatGptExternalTurnProgressSnapshot;
  abstract acknowledgeToolBatch(revision: number): Promise<void>;

  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("ChatGPT external progress revision must be a non-negative safe integer");
    }
    const current = this.snapshot();
    if (current.revision > afterRevision) return Promise.resolve(current);
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ProgressWaiter = { afterRevision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  protected notify(snapshot: ChatGptExternalTurnProgressSnapshot): void {
    for (const waiter of [...this.waiters]) {
      if (snapshot.revision <= waiter.afterRevision) continue;
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(snapshot);
    }
  }
}

export class ChatGptExternalTurnProgress extends ChatGptTurnProgressBroadcaster {
  private revision = 0;
  private lastToolBatchRevision = 0;
  private observedToolBatchRevision = 0;
  private activeToolCalls = 0;
  private lastProgressAt?: number;
  private retirementError?: Error;
  private readonly toolBatchObservationWaiters = new Set<ToolBatchObservationWaiter>();
  private readonly progressListeners = new Set<ChatGptProgressListener>();
  private readonly progressRevisions = new Map<ChatGptProgressSource, number>();

  subscribeProgress(listener: ChatGptProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }

  recordProgress: ChatGptProgressListener = (source, revision) => {
    if (this.retirementError || revision <= (this.progressRevisions.get(source) ?? 0)) return;
    this.progressRevisions.set(source, revision);
    for (const listener of this.progressListeners) listener(source, revision);
  };

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return {
      revision: this.revision,
      lastToolBatchRevision: this.lastToolBatchRevision,
      activeToolCalls: this.activeToolCalls,
      ...(this.lastProgressAt !== undefined ? { lastProgressAt: this.lastProgressAt } : {}),
    };
  }

  recordToolBatch(count: number, now = Date.now()): number {
    this.assertNotRetired();
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("ChatGPT external progress requires a non-empty tool batch");
    }
    this.activeToolCalls += count;
    this.advance(now, "tool_batch");
    return this.lastToolBatchRevision;
  }

  async acknowledgeToolBatch(revision: number): Promise<void> {
    this.assertToolBatchRevision(revision);
    this.assertNotRetired();
    if (revision <= this.observedToolBatchRevision) return;
    this.observedToolBatchRevision = revision;
    for (const waiter of [...this.toolBatchObservationWaiters]) {
      if (waiter.revision > revision) continue;
      this.toolBatchObservationWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  waitForToolBatchObservation(revision: number, signal?: AbortSignal): Promise<void> {
    this.assertToolBatchRevision(revision);
    if (this.retirementError) return Promise.reject(this.retirementError);
    if (this.observedToolBatchRevision >= revision) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ToolBatchObservationWaiter = { revision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.toolBatchObservationWaiters.delete(waiter);
          reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.toolBatchObservationWaiters.add(waiter);
    });
  }

  recordToolResult(now = Date.now()): void {
    this.assertNotRetired();
    if (this.activeToolCalls <= 0) {
      throw new Error("ChatGPT external progress received a tool result without an active call");
    }
    this.activeToolCalls -= 1;
    this.advance(now, "tool_result");
  }

  /** Retire every unresolved batch when the broker capability can no longer accept its result. */
  retire(error: Error): boolean {
    if (!(error instanceof Error)) throw new Error("ChatGPT external progress retirement requires an error");
    if (this.retirementError) return false;
    this.retirementError = error;
    for (const waiter of this.toolBatchObservationWaiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    this.toolBatchObservationWaiters.clear();
    this.progressListeners.clear();
    if (this.activeToolCalls === 0) return true;
    this.activeToolCalls = 0;
    // Retirement is not fresh model progress. Advance the transport revision so the browser mirror
    // drops its completion veto, while preserving the timestamp of the last proven MCP activity.
    this.revision += 1;
    this.notify(this.snapshot());
    return true;
  }

  assertToolBatchActive(revision: number): void {
    this.assertToolBatchRevision(revision);
    this.assertNotRetired();
  }

  private advance(now: number, event: "tool_batch" | "tool_result"): void {
    if (!Number.isFinite(now)) throw new Error("ChatGPT external progress timestamp must be finite");
    this.revision += 1;
    if (event === "tool_batch") this.lastToolBatchRevision = this.revision;
    this.lastProgressAt = now;
    this.notify(this.snapshot());
    this.recordProgress(event, this.revision);
  }

  private assertToolBatchRevision(revision: number): void {
    if (!Number.isSafeInteger(revision)
      || revision <= 0
      || revision > this.lastToolBatchRevision) {
      throw new Error("ChatGPT tool-boundary acknowledgement has an invalid batch revision");
    }
  }

  private assertNotRetired(): void {
    if (this.retirementError) throw this.retirementError;
  }
}


export function chatGptExternalProgressIsLive(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!snapshot) return false;
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("ChatGPT external progress liveness inputs are invalid");
  }
  return snapshot.activeToolCalls > 0
    || (snapshot.lastProgressAt !== undefined && now - snapshot.lastProgressAt < graceMs);
}

/** Only unresolved native tool calls veto browser-turn completion. */
export function chatGptExternalToolCallsAreInFlight(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
): boolean {
  return (snapshot?.activeToolCalls ?? 0) > 0;
}
