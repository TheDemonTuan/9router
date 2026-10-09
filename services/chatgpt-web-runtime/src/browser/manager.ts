import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { MAX_CHATGPT_BROWSER_TABS } from "../adapters/chatgpt-web/concurrency";
import { ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../adapters/chatgpt-web/adapter-error";
import { NativeBrowserProcess, NativeBrowserLaunchError } from "./native-process";
import type { RuntimeResourceBudget, PhysicalReservation, TabReservation } from "../resource-budget";
import { runtimeExecutionScope } from "../runtime-scope";
import type { ProfileSettings } from "../config";

export interface BrowserProfileConfig {
  profileId: string;
  profileEpoch: string;
  browserProfilePath: string;
  chromeExecutablePath: string;
  headed: boolean;
  display?: string;
  resourceBudget?: RuntimeResourceBudget;
  settings?: ProfileSettings;
}

export interface BrowserTurnLease {
  readonly page: Page;
  readonly reused: boolean;
  rebind(): Page;
  release(options?: { retain?: boolean; connectorBound?: boolean }): Promise<void>;
}

interface Conversation {
  page: Page;
  modelIdentity: string;
  connectorIdentity?: string;
  connectorBound: boolean;
  leased: boolean;
  discard: boolean;
  ownerKind: "native";
  lastUsedAt: number;
  tabReservation?: TabReservation;
  retainedReservation?: PhysicalReservation;
}

const noPhysicalSettlement = Promise.resolve();
const profiles = new Map<string, BrowserManager>();
const resourceGroups = new WeakMap<RuntimeResourceBudget, Map<string, BrowserManager>>();
function profileRegistry(budget?: RuntimeResourceBudget): Map<string, BrowserManager> {
  if (!budget) return profiles;
  let registry = resourceGroups.get(budget);
  if (!registry) { registry = new Map(); resourceGroups.set(budget, registry); }
  return registry;
}

export function browserProfileWork(profileId: string, budget?: RuntimeResourceBudget): { activeTurns: number; idle: boolean } {
  const manager = profileRegistry(budget ?? runtimeExecutionScope.getStore()?.resourceBudget).get(profileId);
  return { activeTurns: manager?.activeTurns ?? 0, idle: manager?.isIdle ?? true };
}
const directories = new Map<string, BrowserManager>();

function busy(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 503, errorType: "server_error", code: "provider_busy", retryable: false,
  });
}

/** One physical browser owner per canonical account profile; login has no automation channel. */
export class BrowserManager {
  static forProfile(config: BrowserProfileConfig): BrowserManager {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(config.profileId)
      || !config.profileEpoch.trim() || !config.browserProfilePath.trim()) {
      throw new Error("A canonical ChatGPT profile, epoch and operator-owned browser directory are required");
    }
    const registry = profileRegistry(config.resourceBudget);
    const previous = registry.get(config.profileId);
    if (previous && previous.config.profileEpoch === config.profileEpoch && !previous.closed) {
      if (resolve(config.browserProfilePath) !== previous.directory
        || config.chromeExecutablePath !== previous.config.chromeExecutablePath
        || config.headed !== previous.config.headed
        || (config.display !== undefined && config.display !== previous.config.display)) {
        throw new Error("Browser ownership settings require an idle profile restart");
      }
      if (previous.closing) throw busy("ChatGPT profile browser is closing");
      return previous;
    }
    if (previous && !previous.isIdle) throw busy("ChatGPT profile epoch cannot change while browser work is active");
    const manager = new BrowserManager(config, registry, previous?.close());
    registry.set(config.profileId, manager);
    return manager;
  }

  private readonly directory: string;
  private context?: BrowserContext;
  private opening?: Promise<BrowserContext>;
  private closing?: Promise<void>;
  private closed = false;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private maintenanceCount = 0;
  private leaseTail: Promise<void> = Promise.resolve();
  private pendingLeaseCount = 0;
  private readonly physicalLeases = new Map<Page, { traceId: string; settlement: Promise<void>; settle: () => void }>();
  private physicalSettlementFailed = false;
  private readonly runs = new Map<string, Promise<unknown>>();
  private readonly conversations = new Map<string, Conversation>();
  private inspectionPage?: Page;
  private ownedDirectory?: string;
  private manualLogin = false;
  private manualVerifying = false;
  private manualBrowser?: NativeBrowserProcess;
  private manualStarting?: Promise<void>;
  private manualEnding?: Promise<void>;
  private browserReservation?: PhysicalReservation;
  private inspectionReservation?: TabReservation;
  private lastUsedAt = Date.now();
  private viewerOwned = false;
  private approvalOwned = false;
  setViewerOwned(value: boolean): void { this.viewerOwned = value; }
  setApprovalOwned(value: boolean): void { this.approvalOwned = value; }
  adoptBrowserReservation(reservation: PhysicalReservation): void {
    if (this.browserReservation && this.browserReservation !== reservation) throw new Error("Browser reservation already has a physical owner");
    this.browserReservation = reservation;
  }

  private constructor(private readonly config: BrowserProfileConfig, private readonly registry: Map<string, BrowserManager>, private readonly predecessor?: Promise<void>) {
    this.directory = resolve(config.browserProfilePath);
  }

  get isIdle(): boolean {
    return this.runs.size === 0 && this.maintenanceCount === 0
      && this.pendingLeaseCount === 0 && this.physicalLeases.size === 0 && !this.opening && !this.manualLogin;
  }
  get activeTurns(): number { return Math.max(this.runs.size, this.physicalLeases.size); }
  get profileEpoch(): string { return this.config.profileEpoch; }
  get isClosed(): boolean { return this.closed; }
  get isClosing(): boolean { return Boolean(this.closing); }
  get requiresPhysicalRecovery(): boolean { return this.physicalSettlementFailed; }
  waitForPhysicalSettlement(traceId: string): Promise<void> {
    for (const lease of this.physicalLeases.values()) if (lease.traceId === traceId) return lease.settlement;
    return noPhysicalSettlement;
  }

  get canSleep(): boolean {
    return this.isIdle && !this.closed && !this.closing && !this.physicalSettlementFailed
      && !this.manualStarting && !this.manualEnding && !this.manualVerifying && !this.manualBrowser
      && !this.opening && !this.viewerOwned && !this.approvalOwned && this.pendingLeaseCount === 0 && this.conversations.size === 0;
  }

  resourceSnapshot() {
    return {
      browserState: this.physicalSettlementFailed ? "error" as const : this.opening || this.manualStarting ? "waking" as const
        : this.context || this.manualBrowser ? "awake" as const : "sleeping" as const,
      lastUsedAt: this.lastUsedAt,
      activeTabs: this.physicalLeases.size,
      retainedNative: [...this.conversations.values()].filter(value => !value.leased && value.ownerKind === "native").length,
      retainedGeneric: 0,
      inspection: this.inspectionPage && !this.inspectionPage.isClosed() ? 1 : 0,
      canSleep: this.canSleep,
    };
  }

  private releaseConversationResources(conversation: Conversation): void {
    conversation.tabReservation?.release();
    conversation.tabReservation = undefined;
    conversation.retainedReservation?.release();
    conversation.retainedReservation = undefined;
  }

  async focusTurn(traceId?: string): Promise<void> {
    const pages = [...this.physicalLeases.entries()].filter(([page, lease]) => !page.isClosed() && (!traceId || lease.traceId === traceId));
    const page = pages.length === 1 ? pages[0]![0] : !traceId && pages.length === 0 ? this.inspectionPage : undefined;
    if (!page) throw busy("Private viewer requires an existing unambiguous browser surface");
    await page.bringToFront();
  }

  async discardRetained(): Promise<void> {
    for (const [key, conversation] of this.conversations) {
      if (conversation.leased) throw busy("Retained browser state requires physical settlement");
      try { if (!conversation.page.isClosed()) await conversation.page.close(); }
      catch (error) { this.physicalSettlementFailed = true; throw error; }
      this.conversations.delete(key);
      this.releaseConversationResources(conversation);
    }
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.manualEnding || this.manualBrowser || (this.manualLogin && !this.manualVerifying)) throw busy("Human sign-in owns the browser profile");
    if (this.closed || this.physicalSettlementFailed || (this.closing && this.isIdle)) throw busy("ChatGPT profile browser is closed");
    if (this.context) return this.context;
    if (this.opening) return this.opening;
    const opening = this.openContext();
    this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = undefined; }
  }

  private async claimDirectory(): Promise<string> {
    await this.predecessor;
    if (this.closed) throw busy("ChatGPT profile browser is closed");
    if (!existsSync(this.config.chromeExecutablePath)) throw new Error("Configured Chromium executable does not exist");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const canonicalDirectory = realpathSync(this.directory);
    const owner = directories.get(canonicalDirectory);
    if (owner && owner !== this) throw new Error("Browser profile directory already has an owner");
    directories.set(canonicalDirectory, this);
    this.ownedDirectory = canonicalDirectory;
    return canonicalDirectory;
  }

  private async openContext(): Promise<BrowserContext> {
    let canonicalDirectory: string | undefined;
    let reservationAcquired = false;
    try {
      await this.predecessor;
      this.browserReservation ??= await this.config.resourceBudget?.reserveBrowser(this.config.profileId);
      reservationAcquired = true;
      canonicalDirectory = await this.claimDirectory();
      if (this.manualBrowser || (this.manualLogin && !this.manualVerifying)) throw busy("Human sign-in owns the browser profile");
      this.inspectionReservation ??= this.config.resourceBudget?.reserveTab(this.config.profileId, { inspection: true });

      const effectiveHeadless = !this.config.headed;
      const context = await chromium.launchPersistentContext(this.directory, {
        executablePath: this.config.chromeExecutablePath,
        headless: effectiveHeadless,
        chromiumSandbox: true,
        env: { ...process.env, ...(this.config.display && !effectiveHeadless ? { DISPLAY: this.config.display } : {}) },
        viewport: { width: 1280, height: 900 },
      });
      this.context = context;
      context.once("close", () => {
        if (this.context === context) {
          this.context = undefined;
          this.inspectionPage = undefined;
          for (const conversation of this.conversations.values()) this.releaseConversationResources(conversation);
          this.conversations.clear();
          this.inspectionReservation?.release();
          this.inspectionReservation = undefined;
          this.browserReservation?.release();
          this.browserReservation = undefined;
        }
        for (const lease of this.physicalLeases.values()) lease.settle();
        this.physicalLeases.clear();
        if (!this.manualLogin && canonicalDirectory && directories.get(canonicalDirectory) === this) {
          directories.delete(canonicalDirectory);
        }
      });
      return context;
    } catch (error) {
      if (this.context) {
        try { await this.context.close(); }
        catch (closeError) { this.physicalSettlementFailed = true; throw closeError; }
      }
      this.inspectionReservation?.release(); this.inspectionReservation = undefined;
      if (reservationAcquired) {
        this.browserReservation?.release();
        this.browserReservation = undefined;
      }
      if (canonicalDirectory && !this.manualLogin && directories.get(canonicalDirectory) === this) {
        directories.delete(canonicalDirectory);
      }
      if (!this.manualLogin) this.ownedDirectory = undefined;
      throw error;
    }
  }

  run<T>(traceId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing || this.physicalSettlementFailed || this.maintenanceCount > 0 || this.manualLogin) {
      return Promise.reject(busy("ChatGPT profile browser is in maintenance or requires restart"));
    }
    if (this.runs.has(traceId)) return Promise.reject(new Error("Duplicate profile browser turn"));
    if (this.runs.size >= MAX_CHATGPT_BROWSER_TABS) return Promise.reject(new ChatGptWebAdapterError(
      "ChatGPT profile has reached its browser turn concurrency limit", {
        status: 503, errorType: "server_error", code: "concurrency_limit", retryable: false,
      },
    ));
    this.lastUsedAt = Date.now();
    const operation = Promise.resolve().then(action);
    this.runs.set(traceId, operation);
    void operation.finally(() => {
      if (this.runs.get(traceId) === operation) this.runs.delete(traceId);
    }).catch(() => {});
    return operation;
  }

  maintenance<T>(name: string, action: () => Promise<T>, manualLogin = false): Promise<T> {
    if (this.closed || this.closing || this.physicalSettlementFailed || (this.manualLogin && !manualLogin)) return Promise.reject(busy("ChatGPT profile browser requires restart or human sign-in completion"));
    this.maintenanceCount += 1;
    const operation = this.maintenanceTail.then(() => {
      if (this.closed || this.closing || (this.manualLogin && !manualLogin)) throw busy("ChatGPT profile browser is unavailable");
      if (this.runs.size > 0 || this.physicalLeases.size > 0 || this.pendingLeaseCount > 0) {
        throw busy(`ChatGPT ${name} requires all profile turns to settle`);
      }
      return action();
    }).finally(() => { this.maintenanceCount -= 1; });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async maintenancePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (!this.inspectionPage || this.inspectionPage.isClosed()) {
      let page: Page | undefined;
      const reservation = this.inspectionReservation ?? this.config.resourceBudget?.reserveTab(this.config.profileId, { inspection: true });
      this.inspectionReservation ??= reservation;
      try {
        // Reuse the persistent context's empty tab for authenticated inspection only.
        page = context.pages().find(p => !p.isClosed()
          && ![...this.conversations.values()].some(c => c.page === p))
          ?? await context.newPage();
        this.inspectionPage = page;
        page.once("close", () => {
          if (this.inspectionPage === page) {
            this.inspectionPage = undefined;
            this.inspectionReservation?.release();
            this.inspectionReservation = undefined;
          }
        });
      } catch (error) {
        if (this.inspectionReservation === reservation) {
          this.inspectionReservation?.release();
          this.inspectionReservation = undefined;
        }
        throw error;
      }
    }
    this.lastUsedAt = Date.now();
    return this.inspectionPage;
  }

  async leaseTurn(options: {
    traceId: string;
    conversationKey?: string;
    modelIdentity: string;
    connectorIdentity?: string;
    requireRetainedConversation?: boolean;
    retainConversation?: boolean;
  }): Promise<BrowserTurnLease> {
    if (this.closed || this.closing || this.physicalSettlementFailed || this.maintenanceCount > 0 || this.manualLogin) {
      throw busy("ChatGPT browser is in maintenance or requires restart");
    }
    this.pendingLeaseCount += 1;
    const operation = this.leaseTail.then(async (): Promise<BrowserTurnLease> => {
      const context = await this.ensureContext();
      const key = options.conversationKey;
      let conversation = key ? this.conversations.get(key) : undefined;
      if (conversation?.leased) throw busy("ChatGPT conversation already has a browser owner");
      if (conversation && (conversation.page.isClosed() || conversation.discard
        || conversation.modelIdentity !== options.modelIdentity
        || (options.connectorIdentity !== undefined && (!conversation.connectorBound
          || conversation.connectorIdentity !== options.connectorIdentity)))) {
        const pageToClose = conversation.page;
        try { if (!pageToClose.isClosed()) await pageToClose.close(); }
        catch (error) { this.physicalSettlementFailed = true; throw error; }
        if (key) this.conversations.delete(key);
        this.releaseConversationResources(conversation);
        conversation = undefined;
      }
      if (options.requireRetainedConversation && !conversation) throw chatGptRetainedConversationUnavailableError();
      if (this.physicalLeases.size >= MAX_CHATGPT_BROWSER_TABS) throw busy("ChatGPT profile has five leased browser turns");
      const reused = conversation !== undefined;
      if (!conversation) {
        const retainedReservation = options.retainConversation && key
          ? this.config.resourceBudget?.reserveRetained(this.config.profileId) : undefined;
        let tabReservation: TabReservation | undefined;
        try {
          tabReservation = this.config.resourceBudget?.reserveTab(this.config.profileId);
          conversation = {
            page: await context.newPage(),
            modelIdentity: options.modelIdentity,
            connectorIdentity: options.connectorIdentity,
            connectorBound: false,
            leased: false,
            discard: false,
            ownerKind: "native",
            lastUsedAt: Date.now(),
            tabReservation,
            retainedReservation,
          };
          const owned = conversation;
          owned.page.once("close", () => {
            this.releaseConversationResources(owned);
            if (key && this.conversations.get(key) === owned) this.conversations.delete(key);
            const physical = this.physicalLeases.get(owned.page);
            if (physical) { this.physicalLeases.delete(owned.page); physical.settle(); }
          });
        } catch (error) {
          tabReservation?.release();
          retainedReservation?.release();
          throw error;
        }
      }
      conversation.leased = true;
      conversation.lastUsedAt = this.lastUsedAt = Date.now();
      conversation.tabReservation?.setState("active");
      if (key) this.conversations.set(key, conversation);
      const owned = conversation;
      let settled!: () => void;
      const settlement = new Promise<void>(resolveSettlement => { settled = resolveSettlement; });
      this.physicalLeases.set(owned.page, { traceId: options.traceId, settlement, settle: settled });
      let release: Promise<void> | undefined;
      return {
        page: owned.page,
        reused,
        rebind: () => {
          // Re-resolve locators on the exact page; never reconnect or replay a submitted conversation.
          if (owned.page.isClosed() || this.context !== context || !context.pages().includes(owned.page)) {
            throw new Error("The leased ChatGPT browser surface is unavailable");
          }
          return owned.page;
        },
        release: (result = {}) => {
          if (release) return release;
          release = this.leaseTail.then(async () => {
            try {
              owned.leased = false;
              if (result.retain && options.retainConversation && key && !owned.discard && !owned.page.isClosed() && this.context === context) {
                owned.connectorBound = result.connectorBound === true || owned.connectorBound;
                owned.lastUsedAt = this.lastUsedAt = Date.now();
                owned.tabReservation?.setState("retainedNative");
              } else {
                if (key && this.conversations.get(key) === owned) this.conversations.delete(key);
                if (!owned.page.isClosed()) await owned.page.close();
                this.releaseConversationResources(owned);
              }
            } catch (error) {
              this.physicalSettlementFailed = true;
              throw error;
            } finally {
              if (!this.physicalSettlementFailed || owned.page.isClosed()) {
                this.physicalLeases.delete(owned.page);
                settled();
              }
            }
          });
          this.leaseTail = release.then(() => undefined, () => undefined);
          return release;
        },
      };
    });
    this.leaseTail = operation.then(() => undefined, () => undefined);
    try { return await operation; }
    finally { this.pendingLeaseCount -= 1; }
  }

  async releaseRetainedConversation(conversationKey: string): Promise<boolean> {
    const operation = this.leaseTail.then(async () => {
      const conversation = this.conversations.get(conversationKey);
      if (!conversation) return false;
      conversation.discard = true;
      if (conversation.leased) return false;
      try { if (!conversation.page.isClosed()) await conversation.page.close(); }
      catch (error) { this.physicalSettlementFailed = true; throw error; }
      this.conversations.delete(conversationKey);
      this.releaseConversationResources(conversation);
      return true;
    });
    this.leaseTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  startManualLogin(startUrl: string, onUnexpectedExit?: () => void): Promise<void> {
    if (this.manualLogin || !this.isIdle || this.closed || this.closing) return Promise.reject(busy("Human sign-in requires an idle profile"));
    // Fence synchronously, including the context-close/native-spawn interval.
    this.manualLogin = true;
    const operation = this.maintenance("human sign-in", async () => {
      await this.opening;
      if (this.context) await this.context.close();
      await this.launchManualBrowser(startUrl, onUnexpectedExit);
    }, true).catch(async error => {
      await this.stopManualBrowser();
      this.manualLogin = false;
      if (this.ownedDirectory && directories.get(this.ownedDirectory) === this) directories.delete(this.ownedDirectory);
      this.ownedDirectory = undefined;
      throw error;
    });
    this.manualStarting = operation;
    void operation.finally(() => { if (this.manualStarting === operation) this.manualStarting = undefined; }).catch(() => {});
    return operation;
  }

  private async launchManualBrowser(startUrl: string, onUnexpectedExit?: () => void): Promise<void> {
    try {
      await this.predecessor;
      this.browserReservation ??= await this.config.resourceBudget?.reserveBrowser(this.config.profileId);
      await this.claimDirectory();
      if (this.manualEnding || this.closing || !this.manualLogin) throw busy("Human sign-in was revoked");
      this.manualBrowser = await NativeBrowserProcess.launch(this.config.chromeExecutablePath,
        this.ownedDirectory!, this.config.display, startUrl, () => {
          void this.stopManualBrowser().then(() => onUnexpectedExit?.(), () => {
            this.physicalSettlementFailed = true;
            onUnexpectedExit?.();
          });
        });
    } catch (error) {
      if (error instanceof NativeBrowserLaunchError) {
        this.manualBrowser = error.physicalOwner;
        this.physicalSettlementFailed = true;
      } else {
        this.browserReservation?.release(); this.browserReservation = undefined;
        if (this.ownedDirectory && directories.get(this.ownedDirectory) === this) directories.delete(this.ownedDirectory);
        this.ownedDirectory = undefined;
      }
      throw error;
    }
  }
  private async stopManualBrowser(): Promise<void> {
    const browser = this.manualBrowser;
    if (!browser) return;
    try { await browser.close(); }
    catch (error) { this.physicalSettlementFailed = true; throw error; }
    if (this.manualBrowser === browser) this.manualBrowser = undefined;
    this.browserReservation?.release();
    this.browserReservation = undefined;
  }

  async verifyManualLogin<T>(action: () => Promise<T>): Promise<T> {
    if (!this.manualLogin || this.manualVerifying || this.manualEnding || this.closed || this.closing) throw busy("Exact waiting human sign-in required");
    this.manualVerifying = true;
    try {
      await this.manualStarting;
      await this.stopManualBrowser();
      if (!this.manualLogin || this.manualEnding || this.closed || this.closing) throw busy("Human sign-in was revoked");
      return await action();
    }
    finally { this.manualVerifying = false; }
  }

  async restoreManualLogin(startUrl: string, onUnexpectedExit?: () => void): Promise<void> {
    if (!this.manualLogin || this.manualEnding || this.closed || this.closing) throw busy("Human sign-in was revoked");
    await this.maintenance("restore human sign-in", async () => {
      if (this.context) await this.context.close();
      await this.launchManualBrowser(startUrl, onUnexpectedExit);
    }, true);
  }

  endManualLogin(): Promise<void> {
    if (this.manualEnding) return this.manualEnding;
    if (!this.manualLogin) return Promise.resolve();
    this.manualEnding = (async () => {
      await this.manualStarting?.catch(() => undefined);
      await this.maintenanceTail;
      await this.stopManualBrowser();
      // Verification may have opened an automated inspection context. Settle it
      // before clearing the fence; no viewer can inherit the next physical owner.
      if (this.context) await this.context.close();
      this.manualLogin = false;
      if (this.ownedDirectory && directories.get(this.ownedDirectory) === this) directories.delete(this.ownedDirectory);
      this.ownedDirectory = undefined;
    })().finally(() => { this.manualEnding = undefined; });
    return this.manualEnding;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.endManualLogin();
      // A failed page close keeps the turn barrier pending. Explicit recovery
      // closes the context first, releasing that barrier without replaying work.
      if (this.physicalSettlementFailed && this.context) await this.context.close();
      await Promise.allSettled([...this.runs.values()]);
      await this.maintenanceTail;
      await this.leaseTail;
      if (!this.physicalSettlementFailed) {
        await Promise.all([...this.physicalLeases.values()].map(lease => lease.settlement));
      }
      await this.opening?.catch(() => undefined);
      const context = this.context;
      if (context) await context.close();
      this.context = undefined;
      this.closed = true;
      this.inspectionPage = undefined;

      for (const conversation of this.conversations.values()) this.releaseConversationResources(conversation);
      this.conversations.clear();
      this.inspectionReservation?.release();
      this.inspectionReservation = undefined;
      this.browserReservation?.release();
      this.browserReservation = undefined;

      await Promise.all([...this.physicalLeases.values()].map(lease => lease.settlement));
      if (this.ownedDirectory && directories.get(this.ownedDirectory) === this) directories.delete(this.ownedDirectory);
      if (this.registry.get(this.config.profileId) === this) this.registry.delete(this.config.profileId);
    })().catch(error => {
      this.physicalSettlementFailed = true;
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}

export async function releaseRetainedConversation(profileId: string, profileEpoch: string, conversationKey: string): Promise<boolean> {
  const manager = profileRegistry(runtimeExecutionScope.getStore()?.resourceBudget).get(profileId);
  if (!manager || manager.profileEpoch !== profileEpoch) return false;
  return manager.releaseRetainedConversation(conversationKey);
}

export async function closeBrowserManagers(budget?: RuntimeResourceBudget): Promise<void> {
  const results = await Promise.allSettled([...profileRegistry(budget).values()].map(manager => manager.close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "ChatGPT profile browsers failed to close");
}
