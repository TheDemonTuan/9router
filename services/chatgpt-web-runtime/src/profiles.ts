import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { BrowserManager, browserProfileWork, closeBrowserManagers } from "./browser/manager";
import { probeBrowserLoginSession } from "./browser-login";
import { activateChatGptEffortMenu, chatGptNewChatUrl, CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_CONTROL_SELECTOR } from "./chatgpt-session";
import { assertChatGptModelFamily, selectChatGptModelFamily } from "./adapters/chatgpt-web/model-selection";
import { availableChatGptWebModelRoutes, chatGptWebRouteEfforts, resolveChatGptWebContextLimits, CHATGPT_WEB_LUNA_BACKEND_MODEL } from "./chatgpt-web-models";
import type { ChatGptWebAccountCapabilities, ChatGptWebAutomaticModelRoute } from "./chatgpt-web-models";
import { profileSettingsSchema } from "./config";
import type { RuntimeConfig } from "./config";
import { RuntimeState, RuntimeStateError } from "./runtime-state";
import { ProfileTunnel } from "./tunnel";
import type { ProfileTunnelConfig } from "./tunnel";
import { MAX_BROWSER_TURNS, PROTOCOL_VERSION } from "../protocol.js";
import { harnessBuildCompatible } from "./harness-compatibility";
import { ChatGptBrowserWorker } from "./adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, atomicWriteFile } from "./config";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";

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
  private readonly harnessEvidence = new Map<string, { epoch: string; connector: boolean }>();
  constructor(readonly config: RuntimeConfig, readonly state: RuntimeState, readonly tunnelConfigs: Record<string, ProfileTunnelConfig> = {}) {}
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
        this.invalidate(profile.profileId, error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "profile_probe_failed");
        if (!(error instanceof RuntimeStateError || error instanceof ChatGptWebAdapterError) || !["login_required", "session_expired", "model_version_unavailable", "harness_compatibility_unverified"].includes(error.code || "")) throw error;
      }
    }
  }
  private fullReady(profileId: string): boolean {
    const profile = this.state.profile(profileId);
    const evidence = this.harnessEvidence.get(profileId);
    return harnessBuildCompatible() && evidence?.epoch === profile.epoch && evidence.connector
      && this.tunnels.get(profileId)?.diagnostic().ready === true;
  }
  async refreshReadiness(profileId: string): Promise<void> {
    if (this.state.profile(profileId).settings.mode === "full") {
      if (!await this.tunnels.get(profileId)?.ready()) this.invalidate(profileId, "connector_unavailable");
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
    if (this.state.fence() || this.viewer?.profileId === profileId && this.viewer.manualLogin || this.viewerStarting) return false;
    let profile;
    try { profile = this.state.profile(profileId); } catch { return false; }
    const probe = this.probes.get(profileId);
    return !!probe && probe.epoch === profile.epoch && probe.revision === profile.revision && probe.models.length > 0
      && (profile.settings.mode !== "full" || this.fullReady(profileId));
  }
  evidence(profileId: string): ProfileProbe {
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
  async probe(profileId: string, navigate = true, initializing = false, manualManager?: BrowserManager, assertLease?: () => void): Promise<ProfileProbe> {
    if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
    await this.ensureDisplay(profileId);
    assertLease?.();
    const manager = manualManager ?? this.manager(profileId);
    this.probes.delete(profileId);
    try {
      const result = await manager.maintenance("session probe", async () => {
        const profile = this.state.profile(profileId);
        if (!manualManager && profile.epoch !== manager.profileEpoch) throw new RuntimeStateError("profile_revision_conflict", "Stale browser epoch probe discarded");
        const page = await manager.maintenancePage();
        if (navigate) await page.goto(chatGptNewChatUrl(profile.settings.useSavedChats), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const evidence = await probeBrowserLoginSession(page, this.state.accountSalt, profile.settings.useSavedChats);
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
              const minimum = Number(await menu.slider.getAttribute("aria-valuemin"));
              const maximum = Number(await menu.slider.getAttribute("aria-valuemax"));
              const target = minimum + effortIndex;
              for (let tries = 0; tries <= maximum - minimum; tries++) {
                const value = Number(await menu.slider.getAttribute("aria-valuenow"));
                if (value === target) break;
                await menu.slider.press(value < target ? "ArrowRight" : "ArrowLeft");
              }
              await assertChatGptModelFamily(menu, route.modelFamily, route.adapterEffort, effortIndex, 1000);
            } catch { continue; }
            finally { await page.keyboard.press("Escape").catch(() => {}); }
          }
          const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, { ...evidence.capabilities, experimentalBiggerContext: profile.settings.experimentalBiggerContext });
          const full = profile.accountFingerprint === evidence.accountFingerprint && profile.settings.mode === "full" && harnessBuildCompatible()
            && this.harnessEvidence.get(profileId)?.epoch === profile.epoch && await this.tunnels.get(profileId)?.ready() === true;
          models.push({ id: route.slug, display_name: route.displayName,
            supported_reasoning_levels: [...chatGptWebRouteEfforts(route, evidence.capabilities)], default_reasoning_level: route.codexEffort,
            ...(route.modelFamily ? { model_family: route.modelFamily } : {}), legacy: route.legacy === true,
            context_window: limits.contextWindow, auto_compact_token_limit: limits.autoCompactTokenLimit,
            capabilities: { text: true, vision: true, reasoning: true, compact: route.backendModel !== CHATGPT_WEB_LUNA_BACKEND_MODEL,
              streaming: true, responses: true, native_responses: true, generic_responses: false,
              tools: full, mcp_tools: full, exec: full, subagents: full, computer_use: false, browser_tool: false } });
        }
        if (!models.length) throw new RuntimeStateError("model_version_unavailable", "Authenticated profile has no verified model route");
        assertLease?.();
        if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
        const current = this.state.observeAccount(profileId, evidence.accountFingerprint, profile.revision);
        if (current.epoch !== profile.epoch) {
          this.harnessEvidence.delete(profileId);
          await this.tunnels.get(profileId)?.stop(); this.tunnels.delete(profileId);
          await TurnBroker.forSocket(defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId))).close();
          await manager.discardRetained();
        }
        assertLease?.();
        if (this.state.fence() && !initializing) throw new RuntimeStateError("runtime_draining", "Profile probe mutations denied while drained", 503);
        const probe: ProfileProbe = { revision: current.revision, epoch: current.epoch, capabilities: evidence.capabilities,
          checkedAt: evidence.checkedAt, models, catalogRevision: randomUUID() };
        this.probes.set(profileId, probe); this.errors.delete(profileId);
        return probe;
      }, manualManager !== undefined);
      if (result.epoch !== manager.profileEpoch && !manualManager) await manager.close();
      return result;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "profile_probe_failed";
      this.errors.set(profileId, code);
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
      connectorReady: profile.settings.mode === "full" && this.fullReady(profileId),
      lastError: this.errors.get(profileId) || null };
  }
  async patch(profileId: string, revision: number, value: unknown): Promise<unknown> {
    if (this.state.fence()) throw new RuntimeStateError("runtime_draining", "Profile settings denied while drained", 503);
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
      if (settings.mode === "browser-only") { await this.tunnels.get(profileId)?.stop(); this.tunnels.delete(profileId); }
      this.state.patchProfile(profileId, revision, settings);
      this.probes.delete(profileId);
      await manager.discardRetained();
    });
    return this.status(profileId);
  }
  async harnessSmoke(profileId: string, initializing = false): Promise<void> {
    if (!harnessBuildCompatible()) throw new RuntimeStateError("harness_compatibility_unverified", "Build compatibility gates have not been recorded", 503);
    const config = this.tunnelConfigs[profileId];
    if (!config) throw new RuntimeStateError("connector_unavailable", "Operator tunnel provisioning required", 503);
    const evidence = await this.probe(profileId, true, initializing);
    await TurnBroker.forSocket(defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId))).listen();
    let tunnel = this.tunnels.get(profileId);
    if (!tunnel) {
      tunnel = new ProfileTunnel(config); this.tunnels.set(profileId, tunnel);
      try { await tunnel.start(); }
      catch (error) { if (this.tunnels.get(profileId) === tunnel) this.tunnels.delete(profileId); throw error; }
    } else if (!await tunnel.ready()) throw new RuntimeStateError("connector_unavailable", "Owned tunnel is not ready", 503);
    const profile = this.state.profile(profileId);
    await ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: {
      profileId, profileEpoch: profile.epoch, clientId: "operator-connector-smoke", browserProfilePath: join(this.config.dataDir, "profiles", profileId, "browser"),
      chromeExecutablePath: this.config.chromiumExecutable, headed: true, appName: profile.settings.connectorName,
      brokerSocketPath: defaultBrokerEndpoint(join(this.config.dataDir, "profiles", profileId)), localToolsEnabled: true,
      solAvailable: evidence.capabilities.solAvailable, proAvailable: evidence.capabilities.proAvailable, extraHighAvailable: evidence.capabilities.extraHighAvailable,
    } }).verifyConnector();
    if (this.state.profile(profileId).epoch !== profile.epoch || this.state.profile(profileId).revision !== profile.revision) throw new RuntimeStateError("profile_revision_conflict", "Stale connector probe discarded");
    this.harnessEvidence.set(profileId, { epoch: profile.epoch, connector: true });
    if (!await this.tunnels.get(profileId)!.ready()) { this.harnessEvidence.delete(profileId); throw new RuntimeStateError("connector_unavailable", "Owned tunnel lost readiness", 503); }
    atomicWriteFile(join(this.config.dataDir, "profiles", profileId, "state", "harness-evidence.json"), JSON.stringify({ protocolVersion: 1, profileEpoch: profile.epoch, verifiedAt: new Date().toISOString(), connector: true }));
  }
  async startViewer(profileId: string, login: boolean, traceId?: string): Promise<unknown> {
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
      try {
        await manager.verifyManualLogin(async () => {
          assertLease();
          return this.probe(viewer.profileId, true, false, manager, assertLease);
        });
        assertLease();
        await this.closeViewer("completed");
        return this.viewerStatus(loginId);
      } catch (error) {
        if (this.viewer === viewer && !viewer.revoked && !this.viewerClosing && !this.state.fence() && viewer.expiresAt > Date.now()) {
          try {
            await manager.restoreManualLogin(chatGptNewChatUrl(this.state.profile(viewer.profileId).settings.useSavedChats), () => {
              if (this.viewer === viewer) void this.closeViewer("error").catch(() => {});
            });
            assertLease();
          } catch (restoreError) {
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
    for (const display of this.displays.values()) {
      for (const child of [display.wm, display.child]) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    }
    this.displays.clear(); this.probes.clear(); this.harnessEvidence.clear(); this.approvalWaits.clear();
  }
}
