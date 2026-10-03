import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { MAX_CHATGPT_BROWSER_TABS } from "../adapters/chatgpt-web/concurrency";
import { ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../adapters/chatgpt-web/adapter-error";

export interface BrowserProfileConfig {
  profileId: string;
  profileEpoch: string;
  browserProfilePath: string;
  chromeExecutablePath: string;
  headed: boolean;
  display?: string;
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
}

const profiles = new Map<string, BrowserManager>();

export function browserProfileWork(profileId: string): { activeTurns: number; idle: boolean } {
  const manager = profiles.get(profileId);
  return { activeTurns: manager?.activeTurns ?? 0, idle: manager?.isIdle ?? true };
}
const directories = new Map<string, BrowserManager>();

function busy(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 503, errorType: "server_error", code: "provider_busy", retryable: false,
  });
}

/** One local Playwright pipe and persistent Chromium context per canonical account profile. */
export class BrowserManager {
  static forProfile(config: BrowserProfileConfig): BrowserManager {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(config.profileId)
      || !config.profileEpoch.trim() || !config.browserProfilePath.trim()) {
      throw new Error("A canonical ChatGPT profile, epoch and operator-owned browser directory are required");
    }
    const previous = profiles.get(config.profileId);
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
    const manager = new BrowserManager(config, previous?.close());
    profiles.set(config.profileId, manager);
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

  private constructor(private readonly config: BrowserProfileConfig, private readonly predecessor?: Promise<void>) {
    this.directory = resolve(config.browserProfilePath);
  }

  get isIdle(): boolean {
    return this.runs.size === 0 && this.maintenanceCount === 0
      && this.pendingLeaseCount === 0 && this.physicalLeases.size === 0 && !this.opening;
  }
  get activeTurns(): number { return Math.max(this.runs.size, this.physicalLeases.size); }
  get profileEpoch(): string { return this.config.profileEpoch; }
  async focusTurn(traceId?: string): Promise<void> {
    const pages = [...this.physicalLeases.entries()].filter(([page, lease]) => !page.isClosed() && (!traceId || lease.traceId === traceId));
    const page = pages.length === 1 ? pages[0]![0] : !traceId && pages.length === 0 ? this.inspectionPage : undefined;
    if (!page) throw busy("Private viewer requires an existing unambiguous browser surface");
    await page.bringToFront();
  }
  async discardRetained(): Promise<void> {
    for (const [key, conversation] of this.conversations) {
      if (conversation.leased) throw busy("Retained browser state requires physical settlement");
      this.conversations.delete(key);
      if (!conversation.page.isClosed()) await conversation.page.close();
    }
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.closed || this.physicalSettlementFailed || (this.closing && this.isIdle)) throw busy("ChatGPT profile browser is closed");
    if (this.context) return this.context;
    if (this.opening) return this.opening;
    const opening = this.openContext();
    this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = undefined; }
  }

  private async openContext(): Promise<BrowserContext> {
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
    try {
      const context = await chromium.launchPersistentContext(this.directory, {
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
        chromiumSandbox: true,
        env: { ...process.env, ...(this.config.display ? { DISPLAY: this.config.display } : {}) },
        viewport: { width: 1280, height: 900 },
      });
      this.context = context;
      context.once("close", () => {
        if (this.context === context) {
          this.context = undefined;
          this.inspectionPage = undefined;
          this.conversations.clear();
        }
        for (const lease of this.physicalLeases.values()) lease.settle();
        this.physicalLeases.clear();
        if (directories.get(canonicalDirectory) === this) directories.delete(canonicalDirectory);
      });
      return context;
    } catch (error) {
      if (directories.get(canonicalDirectory) === this) directories.delete(canonicalDirectory);
      this.ownedDirectory = undefined;
      throw error;
    }
  }

  run<T>(traceId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing || this.physicalSettlementFailed || this.maintenanceCount > 0) {
      return Promise.reject(busy("ChatGPT profile browser is in maintenance or requires restart"));
    }
    if (this.runs.has(traceId)) return Promise.reject(new Error("Duplicate profile browser turn"));
    if (this.runs.size >= MAX_CHATGPT_BROWSER_TABS) return Promise.reject(new ChatGptWebAdapterError(
      "ChatGPT profile has reached its browser turn concurrency limit", {
        status: 503, errorType: "server_error", code: "concurrency_limit", retryable: false,
      },
    ));
    const operation = Promise.resolve().then(action);
    this.runs.set(traceId, operation);
    void operation.finally(() => {
      if (this.runs.get(traceId) === operation) this.runs.delete(traceId);
    }).catch(() => {});
    return operation;
  }

  maintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing || this.physicalSettlementFailed) return Promise.reject(busy("ChatGPT profile browser requires restart"));
    this.maintenanceCount += 1;
    const operation = this.maintenanceTail.then(() => {
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
      // The persistent context starts with an empty tab. It is also the private login surface.
      this.inspectionPage = context.pages().find(page => !page.isClosed()
        && ![...this.conversations.values()].some(conversation => conversation.page === page))
        ?? await context.newPage();
    }
    return this.inspectionPage;
  }

  async leaseTurn(options: {
    traceId: string;
    conversationKey?: string;
    modelIdentity: string;
    connectorIdentity?: string;
    requireRetainedConversation?: boolean;
  }): Promise<BrowserTurnLease> {
    if (this.closed || this.closing || this.physicalSettlementFailed || this.maintenanceCount > 0) {
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
        if (key) this.conversations.delete(key);
        if (!conversation.page.isClosed()) await conversation.page.close();
        conversation = undefined;
      }
      if (options.requireRetainedConversation && !conversation) throw chatGptRetainedConversationUnavailableError();
      if (this.physicalLeases.size >= MAX_CHATGPT_BROWSER_TABS) throw busy("ChatGPT profile has five leased browser turns");
      const reused = conversation !== undefined;
      conversation ??= {
        page: await context.newPage(), modelIdentity: options.modelIdentity,
        connectorIdentity: options.connectorIdentity, connectorBound: false, leased: false, discard: false,
      };
      conversation.leased = true;
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
              if (result.retain && key && !owned.discard && !owned.page.isClosed() && this.context === context) {
                owned.connectorBound = result.connectorBound === true || owned.connectorBound;
                this.conversations.delete(key);
                this.conversations.set(key, owned);
                const retained = [...this.conversations.entries()].filter(([, entry]) => !entry.leased);
                while (retained.length > MAX_CHATGPT_BROWSER_TABS) {
                  const [oldKey, old] = retained.shift()!;
                  this.conversations.delete(oldKey);
                  await old.page.close();
                }
              } else {
                if (key && this.conversations.get(key) === owned) this.conversations.delete(key);
                if (!owned.page.isClosed()) await owned.page.close();
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
      this.conversations.delete(conversationKey);
      if (!conversation.page.isClosed()) await conversation.page.close();
      return true;
    });
    this.leaseTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await Promise.allSettled([...this.runs.values()]);
      await this.maintenanceTail;
      await this.leaseTail;
      if (!this.physicalSettlementFailed) {
        await Promise.all([...this.physicalLeases.values()].map(lease => lease.settlement));
      }
      await this.opening?.catch(() => undefined);
      const context = this.context;
      this.context = undefined;
      this.closed = true;
      this.inspectionPage = undefined;
      this.conversations.clear();
      if (context) await context.close();
      await Promise.all([...this.physicalLeases.values()].map(lease => lease.settlement));
      if (this.ownedDirectory && directories.get(this.ownedDirectory) === this) directories.delete(this.ownedDirectory);
      if (profiles.get(this.config.profileId) === this) profiles.delete(this.config.profileId);
    })();
    return this.closing;
  }
}

export async function releaseRetainedConversation(profileId: string, profileEpoch: string, conversationKey: string): Promise<boolean> {
  const manager = profiles.get(profileId);
  if (!manager || manager.profileEpoch !== profileEpoch) return false;
  return manager.releaseRetainedConversation(conversationKey);
}

export async function closeBrowserManagers(): Promise<void> {
  const results = await Promise.allSettled([...profiles.values()].map(manager => manager.close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "ChatGPT profile browsers failed to close");
}
