import type { RuntimeResourceLimits } from "./config";

// Physical ownership is deliberately separate from executing permits. Only the
// caller that observes physical close/settlement may release a reservation.
export interface PhysicalReservation { release(): void }
export interface TabReservation extends PhysicalReservation {
  setState(state: "active" | "retainedNative" | "inspection"): void;
}
export interface RetainedReservation extends PhysicalReservation {}
export interface ResourceLease extends PhysicalReservation {
  suspendForExternalTools(): void;
  resume(signal?: AbortSignal): Promise<void>;
  markSubmitted(): void;
}
export interface ResourceAcquireOptions {
  profileId: string;
  kind: "new" | "continuation";
  signal?: AbortSignal;
  priority?: "nested";
  canRun?: () => boolean;
}
export class ResourceCapacityError extends Error {
  readonly status = 503;
  readonly errorType = "runtime_error";
  readonly code = "runtime_capacity_exceeded";
  readonly retryable = false;
  readonly submission_state: "not_sent" | "unknown";
  readonly headers = { "x-9router-no-fallback": "true", "x-should-retry": "false" };
  constructor(message = "Runtime resource capacity exceeded", submitted = false) {
    super(message);
    this.name = "ResourceCapacityError";
    this.submission_state = submitted ? "unknown" : "not_sent";
  }
}
export interface ResourceTabCounts {
  active: number;
  retainedNative: number;
  retainedGeneric: number;
  inspection: number;
}
export interface ResourceProfileSnapshot {
  profileId: string;
  browserState: "awake" | "sleeping";
  browsers: number;
  executingTurns: number;
  waitingToolTurns: number;
  tabs: ResourceTabCounts;
  retainedSlots: number;
  queueDepth: number;
}
export interface ResourceSnapshot {
  limits: RuntimeResourceLimits;
  browsers: number;
  tabs: ResourceTabCounts;
  executingTurns: number;
  waitingToolTurns: number;
  queueDepth: number;
  profiles: ResourceProfileSnapshot[];
  totals: { admitted: number; rejected: number; queueWaitMs: number; polls: number; domCacheHits: number; domCacheMisses: number };
}
interface ProfileCounts {
  executingTurns: number;
  waitingToolTurns: number;
  active: number;
  retainedNative: number;
  inspection: number;
  retainedSlots: number;
  browser?: PhysicalReservation;
}
interface LeaseState {
  profileId: string;
  state: "executing" | "suspended" | "released";
  submitted: boolean;
  pending?: QueueEntry;
  resuming?: Promise<void>;
}
interface QueueEntry {
  profileId: string;
  kind: "new" | "continuation";
  priority?: "nested";
  canRun?: () => boolean;
  lease?: LeaseState;
  signal?: AbortSignal;
  queuedAt: number;
  settled: boolean;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  resolve: (lease: ResourceLease | undefined) => void;
  reject: (error: ResourceCapacityError) => void;
}

export class RuntimeResourceBudget {
  readonly limits: Readonly<RuntimeResourceLimits>;
  private readonly now: () => number;
  private readonly profiles = new Map<string, ProfileCounts>();
  private readonly queue: QueueEntry[] = [];
  private executingTurns = 0;
  private browsers = 0;
  private conversationTabs = 0;
  private drained = false;
  private pumping = false;
  private readonly totals = { admitted: 0, rejected: 0, queueWaitMs: 0, polls: 0, domCacheHits: 0, domCacheMisses: 0 };

  constructor(limits: RuntimeResourceLimits, { now = Date.now }: { now?: () => number } = {}) {
    this.limits = Object.freeze({ ...limits });
    this.now = now;
  }

  private profile(profileId: string): ProfileCounts {
    let counts = this.profiles.get(profileId);
    if (!counts) {
      counts = { executingTurns: 0, waitingToolTurns: 0, active: 0, retainedNative: 0, inspection: 0, retainedSlots: 0 };
      this.profiles.set(profileId, counts);
    }
    return counts;
  }

  private failure(message: string, submitted = false): ResourceCapacityError {
    this.totals.rejected++;
    return new ResourceCapacityError(message, submitted);
  }

  acquire(options: ResourceAcquireOptions): Promise<ResourceLease> {
    return this.enqueue(options).then(lease => lease!);
  }

  private enqueue(options: ResourceAcquireOptions, lease?: LeaseState): Promise<ResourceLease | undefined> {
    if ((this.drained && !lease) || options.signal?.aborted) {
      return Promise.reject(this.failure(this.drained && !lease ? "Runtime admission is drained" : "Runtime capacity wait cancelled", lease?.submitted));
    }
    const { promise, resolve, reject } = Promise.withResolvers<ResourceLease | undefined>();
    const entry: QueueEntry = { ...options, lease, queuedAt: this.now(), settled: false, resolve, reject };
    if (lease) lease.pending = entry;
    entry.onAbort = () => {
      this.rejectEntry(entry, "Runtime capacity wait cancelled");
      this.notify();
    };
    options.signal?.addEventListener("abort", entry.onAbort, { once: true });
    this.queue.push(entry);
    this.notify();
    // Zero queue capacity still permits immediately runnable work.
    if (!entry.settled && this.queue.length > this.limits.maxQueueSize) {
      this.rejectEntry(entry, "Runtime capacity queue is full");
    }
    return promise;
  }

  private armTimeout(entry: QueueEntry): void {
    entry.timer = setTimeout(() => { entry.timer = undefined; this.notify(); }, Math.max(1, entry.queuedAt + this.limits.queueTimeoutMs - this.now()));
    entry.timer.unref?.();
  }

  private removeEntry(entry: QueueEntry): void {
    entry.settled = true;
    const index = this.queue.indexOf(entry);
    if (index !== -1) this.queue.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    if (entry.lease?.pending === entry) entry.lease.pending = undefined;
  }

  private rejectEntry(entry: QueueEntry, message: string): void {
    if (entry.settled) return;
    this.removeEntry(entry);
    entry.reject(this.failure(message, entry.lease?.submitted));
  }

  private rank(entry: QueueEntry, now: number): number {
    if (entry.lease) return 0;
    if (entry.priority === "nested") return 1;
    if (entry.kind === "new" && now - entry.queuedAt >= this.limits.queueTimeoutMs / 2) return 2;
    return entry.kind === "continuation" ? 3 : 4;
  }

  // Call after a physical release, an eligibility change, or advancing an
  // injected clock. Ineligible profiles never head-of-line block other work.
  notify(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = this.now();
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const entry = this.queue[i]!;
        if (entry.signal?.aborted || now - entry.queuedAt >= this.limits.queueTimeoutMs) {
          this.rejectEntry(entry, entry.signal?.aborted ? "Runtime capacity wait cancelled" : "Runtime capacity wait timed out");
        }
      }
      while (this.executingTurns < this.limits.maxGlobalTurns) {
        let chosen: QueueEntry | undefined;
        let chosenRank = Infinity;
        for (let i = 0; i < this.queue.length; i++) {
          const entry = this.queue[i]!;
          if (this.drained && !entry.lease) continue;
          if (this.profile(entry.profileId).executingTurns >= 5) continue;
          let eligible = true;
          try { eligible = entry.canRun?.() ?? true; }
          catch {
            this.rejectEntry(entry, "Runtime capacity eligibility check failed");
            i--;
            continue;
          }
          if (entry.settled) { i--; continue; }
          if (!eligible) continue;
          const rank = this.rank(entry, now);
          if (rank < chosenRank) { chosen = entry; chosenRank = rank; }
        }
        if (!chosen || chosen.settled) break;
        this.removeEntry(chosen);
        this.executingTurns++;
        const counts = this.profile(chosen.profileId);
        counts.executingTurns++;
        this.totals.queueWaitMs += Math.max(0, now - chosen.queuedAt);
        if (chosen.lease) {
          counts.waitingToolTurns--;
          chosen.lease.state = "executing";
          chosen.resolve(undefined);
        } else {
          this.totals.admitted++;
          chosen.resolve(this.createLease(chosen.profileId));
        }
      }
      // A timer may run before its injected clock deadline. Keep the timeout
      // armed rather than admitting expired work or losing its eventual wakeup.
      for (const entry of this.queue) {
        if (entry.timer === undefined) this.armTimeout(entry);
      }
    } finally { this.pumping = false; }
  }

  private createLease(profileId: string): ResourceLease {
    const lease: LeaseState = { profileId, state: "executing", submitted: false };
    const counts = this.profile(profileId);
    return {
      markSubmitted: () => { if (lease.state !== "released") lease.submitted = true; },
      suspendForExternalTools: () => {
        if (lease.state !== "executing") return;
        lease.state = "suspended";
        this.executingTurns--; counts.executingTurns--; counts.waitingToolTurns++;
        this.notify();
      },
      resume: signal => {
        if (lease.state === "released" || lease.state === "executing") return Promise.resolve();
        if (lease.resuming) return lease.resuming;
        const promise = this.enqueue({ profileId, kind: "continuation", signal }, lease).then(() => {});
        lease.resuming = promise;
        // Clear without creating an unhandled rejected promise. The physical
        // owner still must settle/release after any resume failure.
        void promise.then(() => { lease.resuming = undefined; }, () => { lease.resuming = undefined; });
        return promise;
      },
      release: () => {
        if (lease.state === "released") return;
        if (lease.pending) this.rejectEntry(lease.pending, "Runtime lease released while waiting");
        if (lease.state === "executing") { this.executingTurns--; counts.executingTurns--; }
        else counts.waitingToolTurns--;
        lease.state = "released";
        this.notify();
      },
    };
  }

  async reserveBrowser(profileId: string, signal?: AbortSignal): Promise<PhysicalReservation> {
    if (this.drained || signal?.aborted) throw this.failure("Runtime browser admission is unavailable");
    const counts = this.profile(profileId);
    if (counts.browser) return counts.browser;
    if (this.browsers >= this.limits.maxGlobalBrowsers) throw this.failure("Runtime browser capacity exceeded");
    this.browsers++;
    const reservation: PhysicalReservation = { release: () => {
      if (counts.browser !== reservation) return;
      counts.browser = undefined;
      this.browsers--;
      this.notify();
    } };
    counts.browser = reservation;
    return reservation;
  }

  reserveTab(profileId: string, { inspection = false }: { inspection?: boolean } = {}): TabReservation {
    const counts = this.profile(profileId);
    if (this.drained || (inspection ? counts.inspection >= 1 : this.conversationTabs >= this.limits.maxGlobalTabs || counts.active + counts.retainedNative >= 5)) {
      throw this.failure("Runtime tab capacity exceeded");
    }
    let state: "active" | "retainedNative" | "inspection" = inspection ? "inspection" : "active";
    let released = false;
    counts[state]++;
    if (!inspection) this.conversationTabs++;
    return {
      setState: next => {
        if (released || next === state) return;
        // Inspection pages cannot be promoted into conversation ownership (or
        // vice versa) to circumvent the independent physical caps.
        if ((next === "inspection") !== inspection) throw this.failure("Runtime tab reservation kind cannot change");
        counts[state]--; counts[next]++; state = next;
      },
      release: () => {
        if (released) return;
        released = true;
        counts[state]--;
        if (!inspection) this.conversationTabs--;
        this.notify();
      },
    };
  }

  reserveRetained(profileId: string): RetainedReservation {
    const counts = this.profile(profileId);
    if (this.drained || counts.retainedSlots >= this.limits.maxRetainedTabsPerProfile) throw this.failure("Runtime retained conversation capacity exceeded");
    counts.retainedSlots++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      counts.retainedSlots--;
      this.notify();
    } };
  }

  drain(): void {
    this.drained = true;
    for (const entry of [...this.queue]) {
      if (!entry.lease) this.rejectEntry(entry, "Runtime admission is drained");
    }
    this.notify();
  }
  undrain(): void { this.drained = false; this.notify(); }

  recordDomPoll({ cacheHit }: { cacheHit?: boolean } = {}): void {
    this.totals.polls++;
    if (cacheHit === true) this.totals.domCacheHits++;
    else if (cacheHit === false) this.totals.domCacheMisses++;
  }

  snapshot(): ResourceSnapshot {
    const tabs = { active: 0, retainedNative: 0, retainedGeneric: 0, inspection: 0 };
    let waitingToolTurns = 0;
    const profiles = Array.from(this.profiles, ([profileId, counts]) => {
      tabs.active += counts.active; tabs.retainedNative += counts.retainedNative; tabs.inspection += counts.inspection;
      waitingToolTurns += counts.waitingToolTurns;
      return { profileId, browserState: counts.browser ? "awake" as const : "sleeping" as const,
        browsers: counts.browser ? 1 : 0, executingTurns: counts.executingTurns, waitingToolTurns: counts.waitingToolTurns,
        tabs: { active: counts.active, retainedNative: counts.retainedNative, retainedGeneric: 0, inspection: counts.inspection },
        retainedSlots: counts.retainedSlots, queueDepth: this.queue.filter(entry => entry.profileId === profileId).length };
    });
    return { limits: { ...this.limits }, browsers: this.browsers, tabs, executingTurns: this.executingTurns,
      waitingToolTurns, queueDepth: this.queue.length, profiles, totals: { ...this.totals } };
  }
}
