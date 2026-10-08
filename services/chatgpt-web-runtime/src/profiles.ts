import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { BrowserManager, browserProfileWork, closeBrowserManagers } from "./browser/manager";
import { probeBrowserLoginSession } from "./browser-login";
import { activateChatGptEffortMenu, readChatGptEffortSnapshot, chatGptNewChatUrl, CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_CONTROL_SELECTOR } from "./chatgpt-session";
import { assertChatGptModelFamily, selectChatGptModelFamily } from "./adapters/chatgpt-web/model-selection";
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, resolveChatGptWebContextLimits, CHATGPT_WEB_LUNA_BACKEND_MODEL } from "./chatgpt-web-models";
import type { ChatGptWebAccountCapabilities, ChatGptWebAutomaticModelRoute } from "./chatgpt-web-models";
import { profileSettingsSchema } from "./config";
import type { RuntimeConfig } from "./config";
import { RuntimeState, RuntimeStateError } from "./runtime-state";
import { ProfileTunnel } from "./tunnel";
import type { ProfileTunnelConfig } from "./tunnel";
import { MAX_BROWSER_TURNS, PROTOCOL_VERSION, validateProfileId } from "../protocol.js";
import { harnessBuildCompatible, genericToolHandoffBuildCompatible } from "./harness-compatibility";
import { ChatGptBrowserWorker } from "./adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, atomicWriteFile } from "./config";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";
import { parseChatGptWebSessionTransfer, SessionTransferError } from "../session-transfer.js";
import { HarnessConfigStore } from "./harness-config";
import { AgentTurnBroker } from "./agent-turns";

const HARNESS_MESSAGES: Record<string, string> = {
  harness_compatibility_unverified: "This runtime build has not passed harness compatibility checks",
  harness_config_required: "Enter a Platform Tunnel ID and a runtime API key before starting coding tools",
  connector_unavailable: "Check the owned tunnel, then create or install Codex Native2 in the correct ChatGPT workspace and verify again",
  harness_config_revision_conflict: "Tunnel configuration changed; refresh before trying again",
  profile_revision_conflict: "Profile changed; refresh before trying again",
  harness_operator_managed: "This profile is provisioned by the operator; dashboard configuration cannot replace it",
  harness_tunnel_id_unsupported: "This pinned tunnel client does not support namespaced Tunnel IDs; an operator-reviewed targeted runtime upgrade is required",
};

export interface WebModelRow {
  id: string; display_name: string; supported_reasoning_levels: string[]; default_reasoning_level: string;
  model_family?: "5.6" | "6"; legacy: boolean; context_window: number; auto_compact_token_limit: number;
  capabilities: Record<string, boolean>;
}
interface ProfileProbe {
  revision: number; epoch: string; capabilities: ChatGptWebAccountCapabilities; checkedAt: string; models: WebModelRow[]; catalogRevision: string;
}
interface ViewerLease {
  loginId: string; profileId: string; expiresAt: number; manualLogin: boolean;
  manager?: BrowserManager; completing?: Promise<ViewerStatus>; revoked?: boolean;
  child: ChildProcess; timer: Timer; passwordFile: string; password: string; transports: Set<() => void>;
}
interface ViewerStatus { loginId: string; profileId: string; expiresAt: string; manualLogin: boolean; state: "waiting" | "completed" | "expired" | "error" | "closed"; }
export class RuntimeProfiles {
  private readonly probes = new Map<string, ProfileProbe>();
  private readonly errors = new Map<string, string>();
  private readonly tunnels = new Map<string, ProfileTunnel>();
  private readonly displays = new Map<string, { number: number; child: ChildProcess; wm: ChildProcess }>();
  private viewer?: ViewerLease;
  private viewerClosing?: Promise<void>;
  private lastViewer?: ViewerStatus;
  private readonly displayStarts = new Map<string, Promise<void>>();
  private viewerStarting = false;
  private viewerStart?: Promise<unknown>;
  private viewerGeneration = 0;
  private nextDisplay = 100;
  private readonly approvalWaits = new Map<string, { traceId: string; promptInstance: string }>();
  private readonly harnessEvidence = new Map<string, { epoch: string; configRevision: number; tunnelId: string; connector: boolean }>();
  private readonly harnessErrors = new Map<string, string>();
  private readonly harnessMutations = new Set<string>();
  readonly harnessConfig: HarnessConfigStore;
  constructor(readonly config: RuntimeConfig, readonly state: RuntimeState, readonly tunnelConfigs: Record<string, ProfileTunnelConfig> = {}) {
    this.harnessConfig = new HarnessConfigStore(config.dataDir, tunnelConfigs);
  }
  async ensureProfileBrowser(profileId: string): Promise<BrowserManager> {
    this.state.profile(profileId);
    await this.ensureDisplay(profileId);
    return this.manager(profileId);
  }
  async initialize(): Promise<void> {
    for (const profile of this.state.listProfiles()) {
      await this.ensureProfileBrowser(profile.profileId);
      await this.manager(profile.profileId).ensureContext();
      try {
        if (profile.settings.mode === "full") await this.harnessSmoke(profile.profileId, true);
        await this.probe(profile.profileId, true, true);
      } catch (error) {
        if (error instanceof ChatGptWebAdapterError && error.code === "connector_not_found") error = new RuntimeStateError("connector_unavailable", HARNESS_MESSAGES.connector_unavailable!, 503);
        this.invalidate(profile.profileId, error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "profile_probe_failed");
        if (!(error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError) || !["login_required", "session_expired", "model_version_unavailable", "harness_compatibility_unverified", "harness_config_required", "harness_config_missing", "harness_storage_invalid", "connector_unavailable", "profile_probe_failed"].includes(error.code || "")) throw error;
      }
    }
  }
  private fullReady(profileId: string): boolean {
    const profile = this.state.profile(profileId);
    const evidence = this.harnessEvidence.get(profileId);
    let config;
    try { config = this.harnessConfig.describe(profileId); }
    catch (error) {
      if (!(error instanceof RuntimeStateError) || error.code !== "harness_storage_invalid") throw error;
      this.harnessEvidence.delete(profileId);
      this.harnessErrors.set(profileId, error.code);
      return false;
    }
    return harnessBuildCompatible() && evidence?.epoch === profile.epoch && evidence.connector
      && evidence.configRevision === config.configRevision && evidence.tunnelId === config.tunnelId
      && this.tunnels.get(profileId)?.diagnostic().ready === true;
  }
  async refreshReadiness(profileId: string): Promise<void> {
    const full = this.state.profile(profileId).settings.mode === "full";
    if ((full || this.tunnels.has(profileId)) && !await this.tunnels.get(profileId)?.ready()) {
      this.harnessEvidence.delete(profileId); this.harnessErrors.set(profileId, "connector_unavailable");
      if (full) this.invalidate(profileId, "connector_unavailable");
      await AgentTurnBroker.forSocket(join(this.config.dataDir, "profiles", profileId, "run", "agent-turns.sock")).close();
    }
  }
  physicalIdle(): boolean {
    return !this.viewerStarting && !this.viewerClosing && !this.viewer?.completing && this.displayStarts.size === 0 && this.state.listProfiles().every(profile => browserProfileWork(profile.profileId).idle);
  }
  invalidate(profileId: string, code: string): void {
    this.probes.delete(profileId);
    this.errors.set(profileId, /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "profile_probe_failed");
  }
  noteApproval(profileId: string, traceId: string, promptInstance: string): void {
    this.approvalWaits.set(profileId, { traceId, promptInstance });
  }
  clearApproval(profileId: string): void {
    this.approvalWaits.delete(profileId);
  }
  manager(profileId: string): BrowserManager {
    const profile = this.state.profile(profileId);
    return BrowserManager.forProfile({ profileId, profileEpoch: profile.epoch,
      browserProfilePath: join(this.config.dataDir, "profiles", profileId, "browser"),
      chromeExecutablePath: this.config.chromiumExecutable, headed: true,
      ...(this.displays.has(profileId) ? { display: `:${this.displays.get(profileId)!.number}` } : {}) });
  }
  private ensureDisplay(profileId: string): Promise<void> {
    if (process.platform !== "linux") return Promise.resolve();
    const display = this.displays.get(profileId);
    if (display && [display.child, display.wm].every(child => child.exitCode === null && child.signalCode === null)) return Promise.resolve();
    const existing = this.displayStarts.get(profileId);
    if (existing) return existing;
    const operation = (async () => {
      if (display) {
        if (!browserProfileWork(profileId).idle) throw new RuntimeStateError("profile_active", "Display restart requires physical settlement");
        await this.manager(profileId).close();
        for (const child of [display.wm, display.child]) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
        this.displays.delete(profileId);
      }
      await this.openDisplay(profileId);
    })().finally(() => this.displayStarts.delete(profileId));
    this.displayStarts.set(profileId, operation);
    return operation;
  }
  private async openDisplay(profileId: string): Promise<void> {
    while (existsSync(`/tmp/.X11-unix/X${this.nextDisplay}`) || existsSync(`/tmp/.X${this.nextDisplay}-lock`)) this.nextDisplay++;
    const number = this.nextDisplay++;
    const child = spawn("Xvfb", [`:${number}`, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: "ignore", shell: false });
    try {
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
      const deadline = Date.now() + 10_000;
      while (!existsSync(`/tmp/.X11-unix/X${number}`)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new RuntimeStateError("private_display_unavailable", "Owned display did not become ready", 503);
        await Bun.sleep(50);
      }
      const wm = spawn("openbox", [], { env: { ...process.env, DISPLAY: `:${number}` }, stdio: "ignore", shell: false });
      await new Promise<void>((resolve, reject) => { wm.once("error", reject); wm.once("spawn", resolve); });
      this.displays.set(profileId, { number, child, wm });
      for (const owned of [child, wm]) owned.once("exit", () => this.invalidate(profileId, "private_display_unavailable"));
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
      throw error;
    }
  }
  ready(profileId: string): boolean {
    if (this.harnessMutations.has(profileId)) return false;
    if (this.state.fence() || this.viewer?.profileId === profileId && this.viewer.manualLogin || this.viewerStarting) return false;
    let profile;
    try { profile = this.state.profile(profileId); } catch { return false; }
    const probe = this.probes.get(profileId);
    return !!probe && probe.epoch === profile.epoch && probe.revision === profile.revision && probe.models.length > 0
      && (profile.settings.mode !== "full" || this.fullReady(profileId));
  }
  evidence(profileId: string): ProfileProbe {
    if (this.harnessMutations.has(profileId)) throw new RuntimeStateError("profile_active", "Profile setup is in progress");
    if (this.viewer?.profileId === profileId && this.viewer.manualLogin) throw new RuntimeStateError("login_required", "Finish human sign-in before model operations");
    const profile = this.state.profile(profileId);
    const probe = this.probes.get(profileId);
    if (!probe || probe.epoch !== profile.epoch || probe.revision !== profile.revision || probe.models.length === 0) throw new RuntimeStateError("login_required", "Profile requires a live authenticated session and model probe");
    if (profile.settings.mode === "full" && !this.fullReady(profileId)) throw new RuntimeStateError("connector_unavailable", "Full profile requires live owned tunnel and connector proof", 503);
    return probe;
  }
  catalog(profileId: string): unknown {
    const profile = this.state.profile(profileId), evidence = this.evidence(profileId);
    return { protocolVersion: PROTOCOL_VERSION, profile_id: profileId, profile_epoch: profile.epoch,
      catalog_revision: evidence.catalogRevision, checked_at: evidence.checkedAt, max_concurrency: MAX_BROWSER_TURNS, models: evidence.models };
  }
  private probeDiagnostic(profileId: string, stage: "browser_open" | "navigation" | "session" | "composer" | "surface" | "capabilities" | "model_selection" | "account_commit" | "native_close" | "native_restore", error: unknown, startedAt: number, modelId?: string, effort?: string): void {
    const code = error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError ? error.code : undefined;
    const errorName = error instanceof RuntimeStateError ? "RuntimeStateError" : error instanceof ChatGptWebAdapterError ? "ChatGptWebAdapterError"
      : error instanceof Error && error.name === "TimeoutError" ? "TimeoutError" : "Error";
    console.error(JSON.stringify({ event: "cgw_profile_probe_failed", profileId, stage,
      code: code && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "profile_probe_failed", errorName,
      elapsedMs: Math.max(0, Date.now() - startedAt), ...(modelId ? { modelId, effort } : {}) }));
  }
  async probe(profileId: string, navigate = true, initializing = false, manualManager?: BrowserManager, assertLease?: () => void): Promise<ProfileProbe> {
    if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
    const startedAt = Date.now();
    let enteredMaintenance = false;
    try {
      await this.ensureDisplay(profileId);
      assertLease?.();
      const manager = manualManager ?? this.manager(profileId);
      const result = await manager.maintenance("session probe", () => {
        enteredMaintenance = true;
        return this.probeInMaintenance(profileId, manager, navigate, initializing, manualManager !== undefined, assertLease);
      }, manualManager !== undefined);
      if (result.epoch !== manager.profileEpoch && !manualManager) await manager.close();
      return result;
    } catch (error) {
      if (!enteredMaintenance) this.probeDiagnostic(profileId, "browser_open", error, startedAt);
      this.invalidate(profileId, error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError ? error.code || "profile_probe_failed" : "profile_probe_failed");
      throw error;
    }
  }
  private async probeInMaintenance(profileId: string, manager: BrowserManager, navigate: boolean, initializing: boolean, manualLogin: boolean, assertLease?: () => void, expectedAccountFingerprint?: string | null): Promise<ProfileProbe> {
    const startedAt = Date.now();
    let stage: Parameters<RuntimeProfiles["probeDiagnostic"]>[1] = "browser_open";
    this.probes.delete(profileId);
    try {
      const profile = this.state.profile(profileId);
      if (!manualLogin && profile.epoch !== manager.profileEpoch) throw new RuntimeStateError("profile_revision_conflict", "Stale browser epoch probe discarded");
      const page = await manager.maintenancePage();
      if (navigate) {
        stage = "navigation";
        try { await page.goto(chatGptNewChatUrl(profile.settings.useSavedChats), { waitUntil: "domcontentloaded", timeout: 60_000 }); }
        catch (cause) {
          throw new ChatGptWebAdapterError("ChatGPT session navigation failed", {
            status: 502, errorType: "runtime_error", code: "profile_probe_failed", retryable: false, cause,
          });
        }
      }
      const evidence = await probeBrowserLoginSession(page, this.state.accountSalt, profile.settings.useSavedChats, value => { stage = value; });
      if (expectedAccountFingerprint && evidence.accountFingerprint !== expectedAccountFingerprint) throw new RuntimeStateError("session_account_mismatch", "The imported session belongs to another ChatGPT account", 409);
      stage = "model_selection";
      const models: WebModelRow[] = [];
      for (const candidate of availableChatGptWebModelRoutes(evidence.capabilities)) {
        if (candidate.interactionMode !== "automatic") continue;
        const route: ChatGptWebAutomaticModelRoute = candidate;
        if (route.modelFamily) {
          try {
            const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
            const control = composer.locator("xpath=ancestor::form[1]").locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
            const activate = () => activateChatGptEffortMenu(page, control);
            let menu = await activate();
            menu = await selectChatGptModelFamily(menu, route.modelFamily, activate);
            const effortIndex = ["low", "medium", "high", "xhigh", "max"].indexOf(route.adapterEffort);
            let snapshot = await readChatGptEffortSnapshot(menu.sliderContainer);
            const minimum = snapshot.min, maximum = snapshot.max;
            const target = minimum + effortIndex;
            if (effortIndex < 0 || target < minimum || target > maximum || snapshot.available[effortIndex] !== true) {
              throw new Error("ChatGPT requested effort is unavailable");
            }
            const keyboardOwner = menu.slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
            for (let moves = 0; snapshot.value !== target; moves++) {
              if (moves >= maximum - minimum) throw new Error("ChatGPT effort selection exceeded its range");
              const previous = snapshot.value, direction = target > previous ? 1 : -1;
              await keyboardOwner.press(direction > 0 ? "ArrowRight" : "ArrowLeft", { timeout: 5_000 });
              const deadline = Date.now() + 5_000;
              do {
                snapshot = await readChatGptEffortSnapshot(menu.sliderContainer);
                if (snapshot.min !== minimum || snapshot.max !== maximum || snapshot.available[effortIndex] !== true) {
                  throw new Error("ChatGPT changed its effort range or availability during selection");
                }
                if (snapshot.value !== previous) break;
                if (Date.now() >= deadline) break;
                await Bun.sleep(50);
              } while (true);
              if (snapshot.value !== previous + direction) throw new Error("ChatGPT effort did not move exactly one step");
            }
            await assertChatGptModelFamily(menu, route.modelFamily, route.adapterEffort, effortIndex, 1000);
          } catch (error) {
            this.probeDiagnostic(profileId, "model_selection", error, startedAt, route.slug, route.adapterEffort);
            continue;
          }
          finally { await page.keyboard.press("Escape").catch(() => {}); }
        }
        const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, { ...evidence.capabilities, experimentalBiggerContext: profile.settings.experimentalBiggerContext });
        const full = profile.accountFingerprint === evidence.accountFingerprint && profile.settings.mode === "full" && this.fullReady(profileId);
        models.push({ id: route.slug, display_name: route.displayName,
          supported_reasoning_levels: [...chatGptWebRouteEfforts(route, evidence.capabilities)], default_reasoning_level: route.codexEffort,
          ...(route.modelFamily ? { model_family: route.modelFamily } : {}), legacy: route.legacy === true,
          context_window: limits.contextWindow, auto_compact_token_limit: limits.autoCompactTokenLimit,
          capabilities: { text: true, vision: true, reasoning: true, compact: route.backendModel !== CHATGPT_WEB_LUNA_BACKEND_MODEL,
            streaming: true, responses: true, native_responses: true, generic_responses: true,
            generic_tools: full && genericToolHandoffBuildCompatible(),
            tools: full, mcp_tools: full, exec: full, subagents: full, computer_use: false, browser_tool: false } });
      }
      if (!models.length) throw new RuntimeStateError("model_version_unavailable", "Authenticated profile has no verified model route");
      assertLease?.();
      if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
      stage = "account_commit";
      const current = this.state.observeAccount(profileId, evidence.accountFingerprint, profile.revision);
      if (current.epoch !== profile.epoch) {
        this.harnessEvidence.delete(profileId);
        await this.tunnels.get(profileId)?.stop(); this.tunnels.delete(profileId);
        await TurnBroker.forSocket(defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId))).close();
        await AgentTurnBroker.forSocket(join(this.config.dataDir, "profiles", profileId, "run", "agent-turns.sock")).close();
        await this.harnessConfig.cleanup(profileId);
        await manager.discardRetained();
      }
      // Import can only bind a first account or preserve the old one; its revision may
      // advance at this synchronous commit point, so its precommit guard is not repeated.
      if (expectedAccountFingerprint === undefined) assertLease?.();
      if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
      const probe: ProfileProbe = { revision: current.revision, epoch: current.epoch, capabilities: evidence.capabilities,
        checkedAt: evidence.checkedAt, models, catalogRevision: randomUUID() };
      this.probes.set(profileId, probe); this.errors.delete(profileId);
      return probe;
    } catch (error) {
      this.probeDiagnostic(profileId, stage, error, startedAt);
      this.invalidate(profileId, error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError ? error.code || "profile_probe_failed" : "profile_probe_failed");
      throw error;
    }
  }
  async importSession(profileId: string, revision: number, session: unknown): Promise<unknown> {
    const cookies = parseChatGptWebSessionTransfer(session);
    try { validateProfileId(profileId); }
    catch { throw new SessionTransferError("invalid_session_transfer", 400); }
    if (!Number.isSafeInteger(revision) || revision < 1) throw new SessionTransferError("invalid_session_transfer", 400);
    const assertTarget = () => {
      const profile = this.state.profile(profileId);
      if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Session import denied while drained", 503);
      if (profile.revision !== revision) throw new RuntimeStateError("profile_revision_conflict", "Profile revision changed", 409);
      if (this.viewerStarting || this.viewerClosing || this.viewer?.profileId === profileId) throw new RuntimeStateError("profile_active", "Session import requires an idle profile", 409);
      return profile;
    };
    assertTarget();
    if (!browserProfileWork(profileId).idle) throw new RuntimeStateError("profile_active", "Session import requires an idle profile", 409);
    await this.ensureDisplay(profileId);
    assertTarget();
    const manager = this.manager(profileId);
    if (!manager.isIdle) throw new RuntimeStateError("profile_active", "Session import requires an idle profile", 409);
    let restoreFailed = false;
    try {
      await manager.maintenance("session import", async () => {
        const original = assertTarget();
        const context = await manager.ensureContext();
        const page = await manager.maintenancePage();
        await manager.discardRetained();
        for (const idlePage of context.pages()) if (idlePage !== page) await idlePage.close();
        await page.goto("about:blank");
        const snapshot = await context.cookies();
        assertTarget();
        try {
          await context.clearCookies();
          try { await context.addCookies(cookies); }
          catch { throw new SessionTransferError("invalid_session_transfer", 400); }
          await this.probeInMaintenance(profileId, manager, true, false, false, () => { assertTarget(); }, original.accountFingerprint);
        } catch (error) {
          this.invalidate(profileId, error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError || error instanceof SessionTransferError ? error.code || "profile_probe_failed" : "profile_probe_failed");
          try {
            // A closed/crashed tab must not short-circuit context-level restoration.
            let quiesceFailed = false;
            try {
              try { await page.goto("about:blank"); }
              catch { if (!page.isClosed()) await page.close(); }
              for (const idlePage of context.pages()) if (idlePage !== page) await idlePage.close();
            } catch { quiesceFailed = true; }
            await context.clearCookies();
            await context.addCookies(snapshot);
            if (quiesceFailed) throw new RuntimeStateError("session_restore_failed", "Browser pages could not settle during session restoration", 503);
          } catch {
            restoreFailed = true;
            this.invalidate(profileId, "session_restore_failed");
            throw new RuntimeStateError("session_restore_failed", "The previous browser session could not be restored", 503);
          }
          throw error;
        }
      });
      return this.status(profileId);
    } catch (error) {
      if (restoreFailed) {
        // Closing inside maintenance would await its own tail. Settle only after it exits.
        await manager.close().catch(() => {});
      }
      if (error instanceof ChatGptWebAdapterError) throw new RuntimeStateError(error.code || "profile_probe_failed", error.message, error.status);
      throw error;
    }
  }
  async verifySession(profileId: string, revision: number): Promise<unknown> {
    try { validateProfileId(profileId); }
    catch { throw new RuntimeStateError("invalid_request", "Exact profile identity and revision required", 400); }
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RuntimeStateError("invalid_request", "Exact profile identity and revision required", 400);
    const assertTarget = () => {
      const profile = this.state.profile(profileId);
      if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Session verification denied while drained", 503);
      if (profile.revision !== revision) throw new RuntimeStateError("profile_revision_conflict", "Profile revision changed", 409);
      if (this.viewerStarting || this.viewerClosing || this.viewer?.profileId === profileId) throw new RuntimeStateError("profile_active", "Session verification requires an idle profile", 409);
    };
    assertTarget();
    if (!browserProfileWork(profileId).idle) throw new RuntimeStateError("profile_active", "Session verification requires an idle profile", 409);
    await this.ensureDisplay(profileId);
    assertTarget();
    const manager = this.manager(profileId);
    if (!manager.isIdle) throw new RuntimeStateError("profile_active", "Session verification requires an idle profile", 409);
    try {
      const result = await manager.maintenance("saved session verification", async () => {
        assertTarget();
        return this.probeInMaintenance(profileId, manager, true, false, false);
      });
      if (result.epoch !== manager.profileEpoch) await manager.close();
      return this.status(profileId);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw new RuntimeStateError(error.code || "profile_probe_failed", error.message, error.status);
      throw error;
    }
  }
  status(profileId: string): unknown {
    const profile = this.state.profile(profileId);
    const probe = this.probes.get(profileId);
    return { profileId, profileEpoch: profile.epoch, revision: profile.revision, settings: profile.settings,
      state: this.state.fence() ? "draining" : this.approvalWaits.has(profileId) ? "waiting_for_chatgpt_tool_approval"
        : this.ready(profileId) ? "ready" : this.errors.get(profileId) === "login_required" ? "login_required" : this.errors.has(profileId) ? "error" : "login_required",
      models: probe?.models ?? [], activeTurns: browserProfileWork(profileId).activeTurns, maxConcurrency: MAX_BROWSER_TURNS,
      connectorReady: this.fullReady(profileId),
      lastError: this.errors.get(profileId) || null };
  }
  async patch(profileId: string, revision: number, value: unknown): Promise<unknown> {
    if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Profile settings denied while drained", 503);
    if (this.harnessMutations.has(profileId)) throw new RuntimeStateError("profile_active", "Profile setup is in progress");
    const manager = this.manager(profileId);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeStateError("invalid_settings", "Settings object required", 400);
    await manager.maintenance("settings update", async () => {
      if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Profile settings denied while drained", 503);
      const current = this.state.profile(profileId);
      if (!Number.isSafeInteger(revision) || revision !== current.revision) throw new RuntimeStateError("profile_revision_conflict", "Profile revision changed");
      const parsed = profileSettingsSchema.partial().safeParse(value);
      if (!parsed.success) throw new RuntimeStateError("invalid_settings", "Invalid profile settings", 400);
      const settings = { ...current.settings, ...parsed.data };
      if (settings.experimentalBiggerContext && !this.evidence(profileId).capabilities.solAvailable) throw new RuntimeStateError("bigger_context_unsupported", "Bigger Context requires a supported Sol profile", 400);
      if (settings.mode === "full") {
        await this.tunnels.get(profileId)?.ready();
        if (!this.fullReady(profileId)) throw new RuntimeStateError("connector_unavailable", "Run the explicit Full connector smoke after compatibility gates and tunnel provisioning");
      }
      if (current.settings.mode === "full" && settings.mode === "browser-only") await this.stopHarness(profileId);
      this.state.patchProfile(profileId, revision, settings);
      this.probes.delete(profileId);
      await manager.discardRetained();
    });
    return this.status(profileId);
  }
  harnessStatus(profileId: string) {
    const profile = this.state.profile(profileId), saved = this.harnessConfig.describe(profileId);
    const tunnel = this.tunnels.get(profileId)?.diagnostic();
    const proof = this.harnessEvidence.get(profileId);
    const verified = proof?.epoch === profile.epoch && proof.configRevision === saved.configRevision
      && proof.tunnelId === saved.tunnelId && proof.connector;
    const buildCompatible = harnessBuildCompatible();
    const code = this.harnessErrors.get(profileId) || (!buildCompatible ? "harness_compatibility_unverified" : !saved.keyConfigured ? "harness_config_required" : null);
    return { profileId, revision: profile.revision, ...saved, buildCompatible,
      tunnelState: tunnel?.ready ? "ready" : tunnel?.error ? "error" : tunnel?.running ? "starting" : "stopped",
      connectorState: verified && tunnel?.ready ? "verified" : this.harnessErrors.get(profileId) === "connector_unavailable" ? "unavailable" : "unverified",
      canEnableFull: !!(buildCompatible && verified && tunnel?.ready),
      lastError: code ? { code, message: HARNESS_MESSAGES[code] || "Coding tools setup failed; refresh and verify the prerequisites" } : null };
  }
  private assertHarnessScope(profileId: string, revision: number, configRevision: number): void {
    if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Profile setup denied while drained", 503);
    if (this.viewer?.profileId === profileId || this.viewerStarting || this.viewerClosing) throw new RuntimeStateError("viewer_busy", "Close the private viewer before changing coding tools");
    if (!this.manager(profileId).isIdle) throw new RuntimeStateError("profile_active", "Profile setup requires physical browser settlement");
    if (!Number.isSafeInteger(revision) || revision !== this.state.profile(profileId).revision) throw new RuntimeStateError("profile_revision_conflict", "Profile revision changed");
    if (!Number.isSafeInteger(configRevision) || configRevision < 0 || configRevision !== this.harnessConfig.describe(profileId).configRevision) throw new RuntimeStateError("harness_config_revision_conflict", "Tunnel configuration revision changed");
  }
  private async stopHarness(profileId: string): Promise<void> {
    this.harnessEvidence.delete(profileId);
    await this.tunnels.get(profileId)?.stop(); this.tunnels.delete(profileId);
    await TurnBroker.forSocket(defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId))).close();
    await AgentTurnBroker.forSocket(join(this.config.dataDir, "profiles", profileId, "run", "agent-turns.sock")).close();
    await this.harnessConfig.cleanup(profileId);
  }
  private async startHarness(profileId: string): Promise<void> {
    if (!harnessBuildCompatible()) throw new RuntimeStateError("harness_compatibility_unverified", "This runtime build has not passed harness compatibility checks", 503);
    const profile = this.state.profile(profileId), session = this.probes.get(profileId);
    if (!session || session.epoch !== profile.epoch || session.revision !== profile.revision) throw new RuntimeStateError("login_required", "Verify the saved session before starting coding tools");
    const existing = this.tunnels.get(profileId);
    if (existing && await existing.ready()) return;
    if (existing) await this.stopHarness(profileId);
    const tunnel = new ProfileTunnel(await this.harnessConfig.processConfig(profileId));
    this.tunnels.set(profileId, tunnel);
    try {
      await TurnBroker.forSocket(defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId))).listen();
      await AgentTurnBroker.forSocket(join(this.config.dataDir, "profiles", profileId, "run", "agent-turns.sock")).listen();
      await tunnel.start();
    }
    catch (error) { await this.stopHarness(profileId); throw error instanceof RuntimeStateError ? error : new RuntimeStateError("connector_unavailable", "Owned tunnel could not start", 503); }
  }
  private async verifyHarness(profileId: string): Promise<void> {
    if (!harnessBuildCompatible()) throw new RuntimeStateError("harness_compatibility_unverified", "This runtime build has not passed harness compatibility checks", 503);
    if (!await this.tunnels.get(profileId)?.ready()) throw new RuntimeStateError("connector_unavailable", "Start the owned tunnel before verifying Codex Native2", 503);
    const profile = this.state.profile(profileId), saved = this.harnessConfig.describe(profileId);
    const evidence = this.probes.get(profileId);
    if (!evidence || evidence.epoch !== profile.epoch || evidence.revision !== profile.revision) throw new RuntimeStateError("login_required", "Verify the saved session before configuring coding tools");
    try {
    await ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: {
      profileId, profileEpoch: profile.epoch, clientId: "operator-connector-smoke", browserProfilePath: join(this.config.dataDir, "profiles", profileId, "browser"),
      chromeExecutablePath: this.config.chromiumExecutable, headed: true, appName: profile.settings.connectorName,
      brokerSocketPath: defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId)), localToolsEnabled: true,
      solAvailable: evidence.capabilities.solAvailable, proAvailable: evidence.capabilities.proAvailable, extraHighAvailable: evidence.capabilities.extraHighAvailable,
    } }).verifyConnector();
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError && error.code === "connector_not_found") throw new RuntimeStateError("connector_unavailable", HARNESS_MESSAGES.connector_unavailable!, 503);
      throw error;
    }
    const current = this.state.profile(profileId), config = this.harnessConfig.describe(profileId);
    if (current.epoch !== profile.epoch || current.revision !== profile.revision || config.configRevision !== saved.configRevision || config.tunnelId !== saved.tunnelId) throw new RuntimeStateError("profile_revision_conflict", "Stale connector proof discarded");
    if (!await this.tunnels.get(profileId)!.ready()) throw new RuntimeStateError("connector_unavailable", "Owned tunnel lost readiness", 503);
    this.harnessEvidence.set(profileId, { epoch: profile.epoch, configRevision: saved.configRevision, tunnelId: saved.tunnelId!, connector: true });
    atomicWriteFile(join(this.config.dataDir, "profiles", profileId, "state", "harness-evidence.json"), JSON.stringify({ protocolVersion: 1, profileEpoch: profile.epoch, configRevision: saved.configRevision, tunnelId: saved.tunnelId, verifiedAt: new Date().toISOString(), connector: true }));
  }
  async harnessAction(action: "configure" | "start" | "verify" | "activate" | "disconnect", profileId: string, revision: number, configRevision: number, input?: { tunnelId: string; runtimeApiKey?: string }): Promise<unknown> {
    this.assertHarnessScope(profileId, revision, configRevision);
    if (this.harnessMutations.has(profileId)) throw new RuntimeStateError("profile_active", "Profile setup is already in progress");
    this.harnessMutations.add(profileId);
    const manager = this.manager(profileId);
    try {
      if (action === "configure") await manager.maintenance("tunnel configuration", async () => {
        this.harnessConfig.validateConfiguration(profileId, configRevision, input!);
        await this.stopHarness(profileId);
        this.harnessConfig.configure(profileId, configRevision, input!);
      });
      else if (action === "start") await manager.maintenance("tunnel start", () => this.startHarness(profileId));
      else if (action === "disconnect") {
        await manager.maintenance("tunnel disconnect", async () => {
          await this.stopHarness(profileId);
          const profile = this.state.profile(profileId);
          this.state.patchProfile(profileId, revision, { ...profile.settings, mode: "browser-only" });
          await manager.discardRetained();
        });
        await this.probe(profileId);
      } else {
        await this.verifyHarness(profileId);
        if (action === "activate") {
          await manager.maintenance("coding tools activation", async () => {
            const profile = this.state.profile(profileId);
            this.state.patchProfile(profileId, revision, { ...profile.settings, mode: "full" });
            await manager.discardRetained();
          });
          await this.probe(profileId);
        }
      }
      this.harnessErrors.delete(profileId);
    } catch (error) {
      this.harnessErrors.set(profileId, error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError ? error.code || "connector_unavailable" : "connector_unavailable");
      if (action === "verify" || action === "activate") this.harnessEvidence.delete(profileId);
      throw error;
    } finally { this.harnessMutations.delete(profileId); }
    const status = this.harnessStatus(profileId);
    return action === "activate" || action === "disconnect" ? { profile: this.status(profileId), status } : status;
  }
  async harnessSmoke(profileId: string, initializing = false): Promise<void> {
    await this.probe(profileId, true, initializing);
    if (initializing) {
      await this.startHarness(profileId);
      await this.verifyHarness(profileId);
    } else {
      const revision = this.state.profile(profileId).revision, configRevision = this.harnessConfig.describe(profileId).configRevision;
      await this.harnessAction("start", profileId, revision, configRevision);
      await this.harnessAction("verify", profileId, revision, configRevision);
    }
  }
  async startViewer(profileId: string, login: boolean, traceId?: string): Promise<unknown> {
    if (this.harnessMutations.has(profileId)) throw new RuntimeStateError("profile_active", "Profile setup is in progress");
    if (this.viewer?.profileId === profileId && !traceId && (!login || this.viewer.manualLogin)) {
      const loginId = this.viewer.loginId;
      this.viewerSession(loginId);
      return this.viewerStatus(loginId);
    }
    if (this.viewer || this.viewerStarting || this.viewerClosing) throw new RuntimeStateError("viewer_busy", "A private profile viewer lease already exists");
    this.viewerStarting = true;
    const operation = this.openViewer(profileId, login, traceId, this.viewerGeneration);
    this.viewerStart = operation;
    try { return await operation; }
    finally { this.viewerStarting = false; if (this.viewerStart === operation) this.viewerStart = undefined; }
  }
  private async openViewer(profileId: string, login: boolean, traceId: string | undefined, generation: number): Promise<unknown> {
    if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Viewer maintenance denied while drained", 503);
    await this.ensureDisplay(profileId);
    const manager = this.manager(profileId);
    if (login && !manager.isIdle) throw new RuntimeStateError("profile_active", "Login cannot interrupt active browser turns");
    const assertStarting = () => {
      if (this.state.fence() || generation !== this.viewerGeneration) throw new RuntimeStateError("runtime_draining", "Viewer startup was revoked", 503);
    };
    assertStarting();
    if (login) this.invalidate(profileId, "login_required");
    if (!login) await manager.focusTurn(traceId);
    const display = this.displays.get(profileId);
    if (!display) throw new RuntimeStateError("private_viewer_unavailable", "Private VNC requires the Linux runtime", 503);
    const loginId = randomUUID(), password = randomBytes(18).toString("base64url");
    let child: ChildProcess | undefined;
    let passwordFile: string | undefined;
    try {
      if (login) await manager.startManualLogin(chatGptNewChatUrl(this.state.profile(profileId).settings.useSavedChats), () => {
        if (this.viewer?.loginId === loginId) void this.closeViewer("error").catch(() => {});
        else if (this.viewerStarting) this.viewerGeneration++;
      });
      assertStarting();
      const directory = "/run/cgw/login"; mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
      passwordFile = join(directory, `${loginId}.password`);
      writeFileSync(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
      child = spawn("x11vnc", ["-display", `:${display.number}`, "-rfbport", "5900", "-localhost", "-passwdfile", passwordFile, "-forever", "-shared", "-noxdamage"], { stdio: "ignore", shell: false });
      await new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("spawn", resolve); });
      const deadline = Date.now() + 10_000;
      let listening = false;
      while (!listening) {
        assertStarting();
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new RuntimeStateError("private_viewer_unavailable", "Owned VNC listener did not become ready", 503);
        listening = await new Promise<boolean>(resolve => {
          const socket = connect({ host: "127.0.0.1", port: 5900 });
          socket.once("connect", () => { socket.destroy(); resolve(true); });
          socket.once("error", () => { socket.destroy(); resolve(false); });
          socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
        });
        if (!listening) await Bun.sleep(50);
      }
      assertStarting();
    } catch (error) {
      const results = await Promise.allSettled([child ? this.stopViewerChild(child) : Promise.resolve(), login ? manager.endManualLogin() : Promise.resolve()]);
      if (passwordFile && existsSync(passwordFile)) unlinkSync(passwordFile);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      throw error;
    }
    const expiresAt = Date.now() + 15 * 60_000;
    const timer = setTimeout(() => { void this.closeViewer("expired").catch(() => {}); }, expiresAt - Date.now());
    this.viewer = { loginId, profileId, expiresAt, manualLogin: login, ...(login ? { manager } : {}), child: child!, timer, passwordFile: passwordFile!, password, transports: new Set() };
    child!.once("exit", () => { if (this.viewer?.loginId === loginId) void this.closeViewer("error").catch(() => {}); });
    return this.viewerStatus(loginId);
  }
  viewerStatus(loginId: string): ViewerStatus {
    if (this.viewer?.loginId === loginId && !this.viewer.revoked && !this.viewerClosing) {
      if (this.viewer.expiresAt <= Date.now() || this.state.fence() || this.viewer.child.exitCode !== null || this.viewer.child.signalCode !== null) {
        const terminal = this.state.fence() ? "closed" : this.viewer.expiresAt <= Date.now() ? "expired" : "error";
        void this.closeViewer(terminal).catch(() => {});
      } else return { loginId, profileId: this.viewer.profileId, expiresAt: new Date(this.viewer.expiresAt).toISOString(), manualLogin: this.viewer.manualLogin, state: "waiting" };
    }
    if (this.lastViewer?.loginId === loginId) return { ...this.lastViewer };
    throw new RuntimeStateError("login_not_found", "Viewer lease not found", 404);
  }
  viewerSession(loginId: string) {
    const status = this.viewerStatus(loginId);
    if (status.state !== "waiting" || !this.viewer || this.viewerClosing || this.viewer.completing || this.state.fence()) throw new RuntimeStateError("login_not_found", "Active viewer lease required", 404);
    return { ...status, state: "waiting" as const, password: this.viewer.password };
  }
  attachViewerTransport(loginId: string, close: () => void): () => void {
    this.viewerSession(loginId);
    const viewer = this.viewer!;
    viewer.transports.add(close);
    return () => { viewer.transports.delete(close); };
  }
  async closeViewerLease(loginId: string): Promise<unknown> {
    this.viewerStatus(loginId);
    if (this.viewer?.loginId === loginId) await this.closeViewer();
    return this.viewerStatus(loginId);
  }
  completeLogin(loginId: string): Promise<ViewerStatus> {
    const status = this.viewerSession(loginId);
    const viewer = this.viewer!;
    if (!status.manualLogin || !viewer.manager) return Promise.reject(new RuntimeStateError("invalid_login", "Exact waiting human sign-in lease required", 400));
    if (viewer.completing) return Promise.reject(new RuntimeStateError("profile_active", "Human sign-in verification is already running"));
    // No existing or new viewer transport may control the automated verification surface.
    for (const close of viewer.transports) { try { close(); } catch { /* Revoke every sink. */ } }
    viewer.transports.clear();
    const assertLease = () => {
      if (this.viewer !== viewer || viewer.revoked || this.viewerClosing || this.state.fence() || viewer.expiresAt <= Date.now()) throw new RuntimeStateError("login_not_found", "Human sign-in lease was revoked", 404);
    };
    const manager = viewer.manager;
    const operation = (async () => {
      const startedAt = Date.now();
      let nativeClose = true;
      try {
        await manager.verifyManualLogin(async () => {
          nativeClose = false;
          assertLease();
          return this.probe(viewer.profileId, true, false, manager, assertLease);
        });
        assertLease();
        nativeClose = true;
        await this.closeViewer("completed");
        return this.viewerStatus(loginId);
      } catch (error) {
        if (nativeClose) this.probeDiagnostic(viewer.profileId, "native_close", error, startedAt);
        if (this.viewer === viewer && !viewer.revoked && !this.viewerClosing && !this.state.fence() && viewer.expiresAt > Date.now()) {
          try {
            await manager.restoreManualLogin(chatGptNewChatUrl(this.state.profile(viewer.profileId).settings.useSavedChats), () => {
              if (this.viewer === viewer) void this.closeViewer("error").catch(() => {});
            });
            assertLease();
          } catch (restoreError) {
            this.probeDiagnostic(viewer.profileId, "native_restore", restoreError, startedAt);
            await this.closeViewer("error");
            throw restoreError;
          }
        } else if (this.viewer === viewer) await this.closeViewer(this.state.fence() ? "closed" : "expired");
        if (error instanceof ChatGptWebAdapterError) throw new RuntimeStateError(error.code || "profile_probe_failed", error.message, error.status);
        throw error;
      }
    })();
    viewer.completing = operation;
    void operation.finally(() => { if (viewer.completing === operation) viewer.completing = undefined; }).catch(() => {});
    return operation;
  }
  private async stopViewerChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let timer: Timer | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("exit", exited); child.off("error", failed);
        if (error) reject(error); else resolve();
      };
      const exited = () => finish();
      const failed = (error: Error) => finish(error);
      child.once("exit", exited); child.once("error", failed);
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
          timer = setTimeout(() => finish(new Error("Owned VNC process did not settle")), 2000);
        } catch (error) { finish(error instanceof Error ? error : new Error("Owned VNC termination failed")); }
      }, 2000);
      try { child.kill("SIGTERM"); }
      catch (error) { finish(error instanceof Error ? error : new Error("Owned VNC termination failed")); }
    });
  }
  closeViewer(state: "completed" | "expired" | "error" | "closed" = "closed"): Promise<void> {
    if (this.viewerClosing) return this.viewerClosing;
    this.viewerGeneration++;
    const viewer = this.viewer;
    if (!viewer) {
      if (!this.viewerStart) return Promise.resolve();
      this.viewerClosing = this.viewerStart.then(() => undefined, () => undefined).finally(() => { this.viewerClosing = undefined; });
      return this.viewerClosing;
    }
    clearTimeout(viewer.timer);
    viewer.revoked = true;
    this.lastViewer = { loginId: viewer.loginId, profileId: viewer.profileId, expiresAt: new Date(viewer.expiresAt).toISOString(), manualLogin: viewer.manualLogin, state };
    for (const close of viewer.transports) { try { close(); } catch { /* Every transport must be revoked even if one sink has failed. */ } }
    viewer.transports.clear();
    viewer.password = "";
    this.viewerClosing = (async () => {
      const results = await Promise.allSettled([this.stopViewerChild(viewer.child), viewer.manualLogin ? viewer.manager!.endManualLogin() : Promise.resolve()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Viewer physical processes failed to settle");
      if (existsSync(viewer.passwordFile)) unlinkSync(viewer.passwordFile);
      if (this.viewer === viewer) this.viewer = undefined;
    })().finally(() => { this.viewerClosing = undefined; });
    return this.viewerClosing;
  }
  async close(): Promise<void> {
    await this.closeViewer();
    await Promise.all(this.displayStarts.values());
    await closeBrowserManagers();
    await Promise.all([...this.tunnels.values()].map(tunnel => tunnel.stop())); this.tunnels.clear();
    await Promise.all(this.state.listProfiles().map(profile => this.harnessConfig.cleanup(profile.profileId)));
    for (const display of this.displays.values()) {
      for (const child of [display.wm, display.child]) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    }
    this.displays.clear(); this.probes.clear(); this.harnessEvidence.clear(); this.approvalWaits.clear();
  }
}
