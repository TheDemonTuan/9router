#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { BrowserContext, CDPSession, Page, Request as PlaywrightRequest } from "playwright-core";
import { z } from "zod";
import type { RuntimeService } from "../src/server";

// All stateful runtime imports happen after full home/data isolation. This runner
// never reads the operator's database, browser profile, .env or account cookies.
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(["--worktree", "--proof-dir", "--gateway-entry"].includes(process.argv[i]) && process.argv[i + 1] && !flags.has(process.argv[i]), "Usage: session-connect-smoke.ts --worktree <absolute root> --proof-dir <absolute private directory> [--gateway-entry <absolute standalone custom-server.js>]");
  flags.set(process.argv[i], process.argv[i + 1]);
}
const worktree = flags.get("--worktree")!, proof = flags.get("--proof-dir")!;
assert(worktree && proof && isAbsolute(worktree) && isAbsolute(proof) && process.platform === "linux");
assert(process.env.DISPLAY && process.env.PLAYWRIGHT_BROWSERS_PATH, "Run under xvfb-run with the bundled Playwright Chromium cache");
const gatewayBun = process.env.CGW_GATEWAY_BUN;
assert(gatewayBun && isAbsolute(gatewayBun), "CGW_GATEWAY_BUN must point to Bun 1.4.2");
assert.equal(spawnSync(gatewayBun, ["--version"], { cwd: worktree, encoding: "utf8" }).stdout.trim(), "1.4.2");
assert.equal(Bun.version, "1.4.0", "The runtime runner requires Bun 1.4.0");
assert.equal(spawnSync("xdotool", ["version"], { cwd: worktree }).status, 0, "xdotool is required");
mkdirSync(proof, { recursive: true, mode: 0o700 });
assert(!existsSync(join(proof, "result.json")), "Use a fresh proof directory; old success must never survive a failed rerun");
const root = mkdtempSync(join(tmpdir(), "cgw-session-connect-"));
const cases: string[] = [];
let context: BrowserContext | undefined, bootstrap: BrowserContext | undefined, rootCdp: CDPSession | undefined;
let page: Page, extensionId = "", connection: { id: string; name: string; providerSpecificData: { profileId: string } };
let imports: { status?: number; origin?: string; site?: string }[] = [], nativeStarts = 0, downloads = 0;
const importRequests = new WeakMap<PlaywrightRequest, (typeof imports)[number]>();
let ownedRuntime: RuntimeService | undefined;
let ownedGateway: { kill(): void; exited: Promise<number> } | undefined;
let activeCase = "isolated fixture setup";
let safeFailureMetadata: { actualOrigin: string; expectedOrigin: string; actualSite?: string; headerSource?: string } | { expectedImports: number; actualImports: number; expectedStatus: number; actualStatus: number | null } | undefined;
let cdpFailure: { method: string; code: number } | undefined;
let outcomeFailure: { connectDisabled: boolean; copyDisabled: boolean; exportDisabled: boolean; statusPhase: string; safeCode: string | null; importsCount: number; lastStatus: number | null; collectionCalls: number; targetConsumed?: boolean; profileRevision?: number; profileReady?: boolean } | undefined;
try {
for (const [key, value] of Object.entries({ HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "home"), DATA_DIR: join(root, "gateway-data"), CGW_DATA_DIR: join(root, "runtime-data"), ENABLE_REQUEST_LOGS: "false", NEXT_TELEMETRY_DISABLED: "1" })) {
  process.env[key] = value;
  if (key !== "ENABLE_REQUEST_LOGS" && key !== "NEXT_TELEMETRY_DISABLED") mkdirSync(value, { recursive: true, mode: 0o700 });
}
// Static imports would initialize runtime/home state before the isolation above.
const { chromium } = await import("playwright-core");
assert.equal(JSON.parse(readFileSync(join(import.meta.dir, "../node_modules/playwright-core/package.json"), "utf8")).version, "1.62.0");
const { BrowserManager } = await import("../src/browser/manager");
const { startRuntime } = await import("../src/server");
const html = readFileSync(join(import.meta.dir, "../tests/fixtures/chatgpt-runtime.html"), "utf8");
const cookies = (account = "offline-account") => [
  { name: "cgw_fixture_session.0", value: account, domain: "chatgpt.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: "Lax" as const },
  { name: "cgw_fixture_session.1", value: "-import", domain: "chatgpt.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: "Strict" as const },
];
const transfer = (account = "offline-account") => ({ format: "9router-chatgpt-session", version: 1, cookies: cookies(account) });
const adminToken = "offline-connect-admin-token".repeat(4), dataToken = "offline-connect-data-token".repeat(4);
writeFileSync(join(root, "admin-token"), adminToken, { mode: 0o600 });
writeFileSync(join(root, "data-token"), dataToken, { mode: 0o600 });
let providerSends = 0, physicalSends = 0;
let authSessionGate: { entered(): void; settled: Promise<void> } | undefined;
const runtime = startRuntime({ dataDir: process.env.CGW_DATA_DIR!, host: "127.0.0.1", port: 0, chromiumExecutable: chromium.executablePath(), runtimeToken: Buffer.from(dataToken), adminToken: Buffer.from(adminToken) });
ownedRuntime = runtime;
await runtime.initialized;
runtime.state.createProfile("offline-switch");
const prepared = new WeakSet<BrowserContext>();
// Only display ownership is replaced, as in session-import.test.ts. Each profile
// still has a persistent, sandbox-enabled bundled Chromium and real cookie store.
// ensureDisplay is private in production; this is the same fixture seam as the
// import regression tests, not a browser/API/permission substitute.
const displayOwner = runtime.profiles as unknown as { ensureDisplay(id: string): Promise<void> };
displayOwner.ensureDisplay = async () => {};
runtime.profiles.manager = id => {
  const profile = runtime.state.profile(id);
  const manager = BrowserManager.forProfile({ profileId: id, profileEpoch: profile.epoch, browserProfilePath: join(process.env.CGW_DATA_DIR!, "profiles", id, "browser"), chromeExecutablePath: chromium.executablePath(), headed: false });
  const ensure = manager.ensureContext.bind(manager);
  if (!Reflect.get(manager, "__offlineIntercepted")) {
    Reflect.set(manager, "__offlineIntercepted", true);
    manager.ensureContext = async () => {
      const context = await ensure();
      if (!prepared.has(context)) {
        await context.exposeBinding("observeOfflineSend", () => { physicalSends++; });
        await context.addInitScript(() => {
          Object.assign(window, { __cgwLoginFixture: { semanticSlider: true, headerOnlyModel: true, pointerOnly: true } });
          document.addEventListener("submit", () => { const observer = Reflect.get(window, "observeOfflineSend"); if (typeof observer === "function") void observer(); }, true);
        });
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (request.method() === "POST") providerSends++;
          if (url.origin === "https://chatgpt.com" && url.pathname === "/api/auth/session") {
            const gate = authSessionGate;
            if (gate) { gate.entered(); await gate.settled; }
            const header = request.headers().cookie || "";
            const first = /(?:^|;\s*)cgw_fixture_session\.0=([^;]*)/.exec(header)?.[1];
            const second = /(?:^|;\s*)cgw_fixture_session\.1=([^;]*)/.exec(header)?.[1];
            return route.fulfill({ json: first && second ? { user: { id: first + second }, expires: new Date(Date.now() + 3600000).toISOString() } : {} });
          }
          if (url.origin === "https://chatgpt.com" && url.pathname === "/" && request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: html });
          return route.abort();
        });
        await context.routeWebSocket("**/*", socket => socket.close());
        prepared.add(context);
      }
      return context;
    };
  }
  return manager;
};
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
const port = reservation.port; reservation.stop(true);
const origin = `http://127.0.0.1:${port}`;
const entry = flags.get("--gateway-entry") ?? join(worktree, "custom-server.js");
assert(isAbsolute(entry) && existsSync(entry));
const gateway = Bun.spawn([gatewayBun, entry, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: flags.has("--gateway-entry") ? resolve(entry, "..") : worktree, env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", API_HOST: "", INITIAL_PASSWORD: "Offline-Session-Connect-Fixture-20261007", CHATGPT_WEB_RUNTIME_URL: `http://127.0.0.1:${runtime.server.port}`, CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE: join(root, "admin-token"), CHATGPT_WEB_RUNTIME_TOKEN_FILE: join(root, "data-token") }, stdout: "ignore", stderr: "ignore" });
ownedGateway = gateway;
const until = async (condition: () => Promise<boolean> | boolean, label: string, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await Bun.sleep(50); }
  throw new Error(label);
};
const record = async (name: string, action: () => Promise<void>) => { activeCase = name; await action(); cases.push(name); };
const targetSelector = "[data-9router-chatgpt-session-target]";
const inputSelector = "[data-9router-chatgpt-session-file]";
const requestEvent = "9router:chatgpt-session-import-request", resultEvent = "9router:chatgpt-session-import-result";
const assistant = () => page.getByRole("region", { name: "Connect ChatGPT session", exact: true });
const disclosure = (name: string) => page.locator("details").filter({ has: page.locator("summary").filter({ hasText: new RegExp(`^${name}$`) }) }).first();
async function showSignInMethod(method: "extension" | "browser") {
  await page.getByRole("tab", { name: "Connection", exact: true }).click();
  const details = disclosure("Change sign-in method");
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").click();
  await details.getByRole("button", { name: method === "extension" ? "Chrome extension" : "Private browser", exact: true }).click();
}
async function showImportMethod(method: "extension" | "paste" | "file") {
  if (!await assistant().count()) await showSignInMethod("extension");
  const details = assistant().locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Manual import$/ }) });
  const open = await details.evaluate(element => (element as HTMLDetailsElement).open);
  if (method === "extension") {
    if (open) await details.locator("summary").click();
  } else {
    if (!open) await details.locator("summary").click();
    await details.getByRole("button", { name: method === "paste" ? "Paste JSON" : "Select file", exact: true }).click();
  }
}
const noPost = async (before: number) => { await Bun.sleep(300); assert.equal(imports.length, before, "Invalid/unfinished input must not POST"); };
const targetSchema = z.object({ version: z.literal(1), attemptId: z.string().uuid(), profileId: z.string().min(1), revision: z.number().int().positive(), connectionName: z.string(), expiresAt: z.string() }).strict();
const readTarget = async () => targetSchema.parse(await page.locator(targetSelector).evaluate(element => JSON.parse(element.getAttribute("data-9router-chatgpt-session-target")!)));
const clearDraft = async () => {
  const textarea = page.getByRole("textbox", { name: "Session JSON", exact: true });
  // Response/readiness can precede exact-profile reconciliation and importer
  // finally. Observe eventual cleanup without clearing or overwriting any input.
  await until(async () => {
    const filesEmpty = await page.locator(inputSelector).count() === 0 || await page.locator(inputSelector).evaluate((element: HTMLInputElement) => (element.files?.length ?? 0) === 0);
    const pasteEmpty = await textarea.count() === 0 || await textarea.inputValue() === "";
    return filesEmpty && pasteEmpty;
  }, "App-owned importer did not clear credential drafts after settling", 30000);
  if (await page.locator(inputSelector).count()) assert.equal(await page.locator(inputSelector).evaluate((element: HTMLInputElement) => element.files?.length ?? 0), 0);
  if (await textarea.count()) assert.equal(await textarea.inputValue(), "");
  assert.equal(await page.evaluate(() => Reflect.get(window, "__offlineSafeEvents") !== false), true, "Transfer events may contain only safe metadata");
};
async function login(on: Page) {
  assert.equal((await on.request.post(`${origin}/api/auth/login`, { data: { password: "Offline-Session-Connect-Fixture-20261007" } })).status(), 200);
}
async function openConnection() {
  await page.goto(`${origin}/dashboard/providers/chatgpt-web`, { waitUntil: "networkidle" });
  // ConnectionRow names are plain text. Its Edit button owns the modal action;
  // scope to the named row rather than clicking inert text or another account.
  const row = page.locator("div.group").filter({ has: page.getByText(connection.name, { exact: true }) }).filter({ has: page.getByRole("button", { name: /Edit/i }) });
  assert.equal(await row.count(), 1, "Exactly one named connection row must reopen");
  await row.getByRole("button", { name: /Edit/i }).click();
  await page.getByRole("dialog").filter({ has: page.getByRole("tab", { name: "Connection", exact: true }) }).waitFor();
  await showSignInMethod("extension");
  await assistant().waitFor();
}
async function prepare() {
  if (!await assistant().count()) await showSignInMethod("extension");
  await showImportMethod("extension");
  const metadata = await assistant().getAttribute("data-9router-chatgpt-session-assistant");
  if (metadata && JSON.parse(metadata).reason === "consumed") {
    const verify = page.waitForResponse(response => response.url().endsWith("/runtime/session/verify") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Verify saved session", exact: true }).click();
    assert.equal((await verify).status(), 200);
    await until(async () => {
      const fresh = await assistant().getAttribute("data-9router-chatgpt-session-assistant");
      const reason = fresh ? JSON.parse(fresh).reason : "loading";
      return reason !== "consumed" && reason !== "probing" && reason !== "loading"
        && (await page.locator(targetSelector).count() === 1 || await assistant().getByRole("button", { name: "Prepare connection", exact: true }).isEnabled());
    }, "Saved-session verification must settle before explicit preparation", 120000);
  }
  const button = assistant().getByRole("button", { name: "Prepare connection", exact: true });
  // Auto-prepare can replace its CTA before Playwright resolves the click;
  // either surface is metadata-only. Never leave a stale click waiting to replay.
  if (await button.count() && await button.isEnabled()) await button.or(page.locator(targetSelector)).first().click();
  await page.locator(targetSelector).waitFor();
  await until(async () => await page.locator(targetSelector).count() === 1 && !(await page.locator(targetSelector).getAttribute("data-9router-chatgpt-session-consumed")), "Fresh direct attempt required");
  return readTarget();
}
// Action popups are sometimes omitted from Playwright page events. A small CDP
// transport attaches only to the discovered action document, never to MAIN world
// in the dashboard. Every action below clicks the real popup's real button.
const cdpResultSchema = z.object({
  result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }).optional(),
  exceptionDetails: z.unknown().optional(), data: z.string().optional(),
  breakpointId: z.string().optional(), scriptSource: z.string().optional(),
}).passthrough();
const cdpMessageSchema = z.object({ id: z.number().optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ code: z.number() }).optional() });
class AttachedTarget {
  private next = 0;
  private pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void }>();
  onEvent?: (method: string, params: unknown) => void;
  private readonly receive: (event: { sessionId: string; message: string }) => void;
  constructor(readonly sessionId: string, readonly targetId: string) {
    this.receive = event => {
      if (event.sessionId !== sessionId) return;
      const message = cdpMessageSchema.parse(JSON.parse(event.message));
      if (message.id) {
        const waiting = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error && waiting) {
          cdpFailure = { method: waiting.method, code: message.error.code };
          waiting.reject(new Error(`CDP ${waiting.method} ${message.error.code}`));
        } else waiting?.resolve(message.result);
      } else if (message.method) this.onEvent?.(message.method, message.params);
    };
    rootCdp!.on("Target.receivedMessageFromTarget", this.receive);
  }
  async send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.next;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { method, resolve, reject });
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    try {
      await rootCdp!.send("Target.sendMessageToTarget", { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) });
      return cdpResultSchema.parse(await promise);
    } finally { clearTimeout(timeout); this.pending.delete(id); }
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails && result.result, "Extension expression failed");
    // T describes the owned expression above, not an arbitrary page message.
    return result.result.value as T;
  }
  detachClosedDocument() {
    rootCdp!.off("Target.receivedMessageFromTarget", this.receive);
  }
  async close() {
    rootCdp!.off("Target.receivedMessageFromTarget", this.receive);
    await rootCdp!.send("Target.closeTarget", { targetId: this.targetId });
  }
}
async function attach(targetId: string) {
  const attached = await rootCdp!.send("Target.attachToTarget", { targetId, flatten: false });
  return new AttachedTarget(attached.sessionId, targetId);
}
async function popup() {
  await page.bringToFront();
  const marker = `CGW_CONNECT_${randomUUID().replaceAll("-", "")}`;
  await page.evaluate(marker => { document.title = marker; }, marker);
  let windowId = "";
  await until(() => {
    const search = spawnSync("xdotool", ["search", "--onlyvisible", "--name", marker], { cwd: worktree, encoding: "utf8" });
    const matches = search.stdout.trim().split(/\s+/).filter(Boolean);
    if (!matches.length) return false;
    assert.equal(matches.length, 1, "Unique owned dashboard window required"); windowId = matches[0]; return true;
  }, "Dashboard X11 window not found");
  assert.equal(spawnSync("xdotool", ["windowfocus", "--sync", windowId, "key", "--clearmodifiers", "alt+shift+9"], { cwd: worktree }).status, 0);
  let targetId = "";
  await until(async () => {
    const result = await rootCdp!.send("Target.getTargets");
    const targets = result.targetInfos.filter((target: { url: string }) => target.url === `chrome-extension://${extensionId}/popup.html`);
    assert(targets.length <= 1, "Ambiguous action popup"); targetId = targets[0]?.targetId; return !!targetId;
  }, "Real keyboard action popup did not appear");
  const target = await attach(targetId);
  await until(async () => target.evaluate<boolean>("!!document.querySelector('#connect')"), "Popup controls did not mount");
  await until(async () => target.evaluate<boolean>("(()=>{const help=document.querySelector('#target-help');return !!help&&help.textContent.trim()!==''&&help.textContent.trim()!=='Checking the active dashboard tab…'})()"), "Popup target probe did not settle");
  return target;
}
async function clickPopup(popup: AttachedTarget, id: string) {
  if (id === "connect") await until(async () => popup.evaluate<boolean>("!document.querySelector('#connect').disabled"), "Actual popup must confirm the current target before Connect");
  if (["copy", "export"].includes(id) && await popup.evaluate<boolean>(`!document.querySelector(${JSON.stringify(`#${id}`)}).closest('details').open`)) await clickPopupElement(popup, "details > summary");
  await clickPopupElement(popup, `#${id}`);
}
async function clickPopupElement(popup: AttachedTarget, selector: string) {
  const box = await popup.evaluate<{ x: number; y: number; width: number; height: number }>(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Control unavailable');b.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:window.innerWidth,height:window.innerHeight}})()`);
  assert(box.x >= 0 && box.x < box.width && box.y >= 0 && box.y < box.height, "Actual popup button must be inside its viewport before mouse gesture");
  await popup.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await popup.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
}
async function outcome(popup: AttachedTarget, pattern: RegExp) {
  try {
    await until(async () => {
      const state = await popup.evaluate<{ connectDisabled: boolean; copyDisabled: boolean; exportDisabled: boolean; statusPhase: string; safeCode: string | null; matches: boolean }>(`(()=>{const connect=document.querySelector('#connect'),copy=document.querySelector('#copy'),exportButton=document.querySelector('#export'),text=document.querySelector('#status')?.textContent??'';const code=/Import failed \\(([a-z0-9_]{1,64})\\)/.exec(text)?.[1]??(/target changed or is unavailable/.test(text)?'session_target_unavailable':/result is unknown/.test(text)?'import_result_unknown':/Sign in to the 9Router dashboard/.test(text)?'dashboard_auth_required':/profile changed/.test(text)?'profile_revision_conflict':/target expired/.test(text)?'session_target_expired':/already used or is in progress/.test(text)?'session_import_in_progress':null);return{connectDisabled:!!connect?.disabled,copyDisabled:!!copy?.disabled,exportDisabled:!!exportButton?.disabled,statusPhase:/^(Connecting|Preparing|Checking)/i.test(text)?'pending':/result is unknown/i.test(text)?'unknown':/completed|copied|download started/i.test(text)?'completed':'error',safeCode:code,matches:new RegExp(${JSON.stringify(pattern.source)},${JSON.stringify(pattern.flags)}).test(text)}})()`);
      outcomeFailure = { ...state, importsCount: imports.length, lastStatus: imports.at(-1)?.status ?? null, collectionCalls };
      return !state.copyDisabled && !state.exportDisabled && state.matches;
    }, "Popup did not report a settled safe outcome", 135000);
    outcomeFailure = undefined;
  } catch (error) {
    if (outcomeFailure) {
      outcomeFailure.profileRevision = runtime.state.profile(connection.providerSpecificData.profileId).revision;
      outcomeFailure.profileReady = runtime.profiles.ready(connection.providerSpecificData.profileId);
      outcomeFailure.targetConsumed = await page.locator(targetSelector).count() === 1 && await page.locator(targetSelector).getAttribute("data-9router-chatgpt-session-consumed") === "true";
    }
    throw error;
  }
}
let collectionCalls = 0, onCollected: (() => Promise<void>) | undefined;
  await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, "Owned gateway failed to start", 60000);
  bootstrap = await chromium.launchPersistentContext(join(root, "bootstrap"), { channel: "chromium", headless: false, chromiumSandbox: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await bootstrap.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await bootstrap.routeWebSocket("**/*", socket => socket.close());
  page = bootstrap.pages()[0] ?? await bootstrap.newPage();
  await login(page);
  await page.goto(`${origin}/dashboard/providers/chatgpt-web`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Add Connection/ }).click();
  await page.getByRole("textbox", { name: "Connection name", exact: true }).fill("Offline direct account");
  await page.getByRole("radio", { name: /^Chrome extension/ }).check();
  const creation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/providers" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const created = await creation; assert.equal(created.status(), 201); connection = (await created.json()).connection;
  await assistant().waitFor();
  await assistant().locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Install or update helper$/ }) }).locator("summary").click();
  const downloading = page.waitForEvent("download");
  await assistant().getByRole("link", { name: "Download Chrome helper", exact: true }).click();
  const archiveDownload = await downloading; assert.equal(archiveDownload.suggestedFilename(), "chatgpt-web-session-export.zip");
  const archive = join(root, "helper.zip"); await archiveDownload.saveAs(archive);
  // fflate belongs to the root build dependency; keep its type contract local
  // so the runtime can be typechecked before gateway dependencies are installed.
  const { unzipSync } = await import(join(worktree, "node_modules/fflate/esm/index.mjs")) as { unzipSync(bytes: Uint8Array): Record<string, Uint8Array> };
  const files = unzipSync(new Uint8Array(readFileSync(archive)));
  assert.deepEqual(Object.keys(files).sort(), ["background.js", "manifest.json", "popup.html", "popup.js"].map(name => `chatgpt-web-session-export/${name}`).sort());
  const extensionDir = join(root, "chatgpt-web-session-export"); mkdirSync(extensionDir, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(files)) {
    assert(!Buffer.from(bytes).includes(Buffer.from("offline-account")), "Archive must not contain session credentials");
    writeFileSync(join(root, name), bytes, { mode: 0o600 });
  }
  await bootstrap.close(); bootstrap = undefined;
  context = await chromium.launchPersistentContext(join(root, "extension-profile"), { channel: "chromium", headless: false, chromiumSandbox: true, serviceWorkers: "allow", acceptDownloads: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || url.protocol === "chrome-extension:" && url.hostname === extensionId ? route.continue() : route.abort();
  });
  await context.routeWebSocket("**/*", socket => { if (new URL(socket.url()).origin.replace("ws:", "http:") === origin) socket.connectToServer(); else socket.close(); });
  page = context.pages()[0] ?? await context.newPage();
  let credentialLeak = false;
  const leaked = (value: string) => /offline-(?:other-)?account|fixture-session-secret/.test(value);
  page.on("console", message => { if (leaked(message.text())) credentialLeak = true; });
  page.on("request", request => { if (leaked(request.url())) credentialLeak = true; });
  await page.addInitScript(({ request, result }) => {
    Reflect.set(window, "__offlineSafeEvents", true);
    for (const type of [request, result]) document.addEventListener(type, event => {
      const detail: unknown = Reflect.get(event, "detail");
      const allowed: Record<string, true> = { version: true, attemptId: true, profileId: true, revision: true, ok: true, status: true, code: true };
      if (!detail || typeof detail !== "object" || Object.keys(detail).some(key => !allowed[key])) Reflect.set(window, "__offlineSafeEvents", false);
    }, true);
  }, { request: requestEvent, result: resultEvent });
  const wireHeaders = new Map<string, { origin?: string; site?: string; observed: boolean }>();
  const wireImports: string[] = [];
  const dashboardCdp = await context.newCDPSession(page);
  dashboardCdp.on("Network.requestWillBeSent", event => {
    if (event.request.method === "POST" && event.request.url === `${origin}/api/providers/chatgpt-web/runtime/session/import`) wireImports.push(event.requestId);
  });
  dashboardCdp.on("Network.requestWillBeSentExtraInfo", event => {
    // ExtraInfo observes the network-service headers, including browser-generated
    // forbidden headers omitted from Playwright's intercepted Request view.
    // Extract two safe fields only; never retain Cookie or Authorization headers.
    let actualOrigin: string | undefined, actualSite: string | undefined;
    for (const [name, value] of Object.entries(event.headers)) {
      if (name.toLowerCase() === "origin" && typeof value === "string") {
        try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol) && url.origin === value) actualOrigin = value; } catch {}
      }
      if (name.toLowerCase() === "sec-fetch-site" && typeof value === "string" && ["same-origin", "same-site", "cross-site", "none"].includes(value)) actualSite = value;
    }
    wireHeaders.set(event.requestId, { origin: actualOrigin, site: actualSite, observed: true });
  });
  await dashboardCdp.send("Network.enable");
  page.on("request", request => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/runtime/login/start") || request.url().endsWith("/runtime/browser/view")) nativeStarts++;
    if (request.url().endsWith("/runtime/session/import")) {
      const item: { status?: number; origin?: string; site?: string } = {};
      imports.push(item);
      importRequests.set(request, item);
      void request.allHeaders().then(headers => { item.origin = headers.origin; item.site = headers["sec-fetch-site"]; });
    }
  });
  page.on("response", response => {
    const item = importRequests.get(response.request());
    if (item) item.status = response.status();
  });
  rootCdp = await context.browser()!.newBrowserCDPSession();
  await rootCdp.send("Target.setDiscoverTargets", { discover: true });
  const browserDownloads = new Map<string, { name: string; completed: boolean }>();
  const downloadDir = join(root, "downloads"); mkdirSync(downloadDir, { mode: 0o700 });
  await rootCdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  rootCdp.on("Browser.downloadWillBegin", event => { downloads++; browserDownloads.set(event.guid, { name: event.suggestedFilename, completed: false }); });
  rootCdp.on("Browser.downloadProgress", event => { const download = browserDownloads.get(event.guid); if (download && event.state === "completed") download.completed = true; });
  const workerTargets = (await rootCdp.send("Target.getTargets")).targetInfos.filter((target: { url: string }) => target.url === worker.url());
  assert.equal(workerTargets.length, 1);
  const workerCdp = await attach(workerTargets[0].targetId);
  // Debugger observes the actual cookie API invocation without replacing any
  // chrome API, changing permissions, or injecting a fake cookie response.
  let workerScriptId = "", cookieBreakpoint = "", collectedBreakpoint = "", debuggerFailure: unknown;
  workerCdp.onEvent = (method, params) => {
    if (method === "Debugger.scriptParsed") {
      const script = z.object({ scriptId: z.string(), url: z.string() }).passthrough().parse(params);
      if (script.url === worker.url()) workerScriptId = script.scriptId;
    }
    if (method !== "Debugger.paused") return;
    const paused = z.object({ hitBreakpoints: z.array(z.string()).optional() }).passthrough().parse(params);
    if (paused.hitBreakpoints?.includes(cookieBreakpoint)) collectionCalls++;
    void (async () => {
      try {
        if (paused.hitBreakpoints?.includes(collectedBreakpoint)) { const action = onCollected; onCollected = undefined; await action?.(); }
      } catch (error) { debuggerFailure = error; }
      finally { await workerCdp.send("Debugger.resume"); }
    })();
  };
  await workerCdp.send("Debugger.enable");
  const functionObject = await workerCdp.send("Runtime.evaluate", { expression: "chrome.cookies.getAll", returnByValue: false });
  assert(functionObject.result?.objectId);
  cookieBreakpoint = z.string().parse((await workerCdp.send("Debugger.setBreakpointOnFunctionCall", { objectId: functionObject.result.objectId })).breakpointId);
  await until(() => !!workerScriptId, "Bundled worker script not discovered");
  const source = await workerCdp.send("Debugger.getScriptSource", { scriptId: workerScriptId }); assert(source.scriptSource);
  const lines = source.scriptSource.split("\n");
  const collectionLine = lines.findIndex(line => /session\s*=\s*await collectChatGptSession\(\)/.test(line));
  const confirmationLine = lines.findIndex((line, index) => index > collectionLine && /checked\s*=\s*await inspect\(\)/.test(line));
  assert(collectionLine >= 0 && confirmationLine > collectionLine, "Bundled post-collection confirmation must be observable");
  collectedBreakpoint = z.string().parse((await workerCdp.send("Debugger.setBreakpoint", { location: { scriptId: workerScriptId, lineNumber: confirmationLine } })).breakpointId);
  await login(page); await context.addCookies(cookies()); await openConnection();
  await record("popup opened before target recovers with read-only refresh", async () => {
    const target = await prepare(), before = imports.length, collects = collectionCalls;
    // Withhold only public target metadata in the actual dashboard document to
    // reproduce the preparation/hydration race. Chrome APIs and the packaged
    // popup remain untouched. The old one-shot probe cannot pass this case.
    const holder = page.locator(targetSelector);
    await holder.evaluate(element => element.removeAttribute("data-9router-chatgpt-session-target"));
    const action = await popup();
    assert(await action.evaluate<boolean>("document.querySelector('#connect').disabled"));
    await action.send("Page.enable");
    const blocked = await action.send("Page.captureScreenshot"); assert(blocked.data);
    writeFileSync(join(proof, "extension-popup-unprepared.png"), Buffer.from(blocked.data, "base64"), { mode: 0o600 });
    await assistant().locator("input[data-9router-chatgpt-session-file]").evaluate((input, target) => input.parentElement!.setAttribute("data-9router-chatgpt-session-target", JSON.stringify(target)), target);
    // No focus/check click: recovery must come from the visible read-only timer.
    await until(async () => action.evaluate<boolean>("!document.querySelector('#connect').disabled"), "One-shot popup recovery failed: prepared target never became selectable");
    assert(!await action.evaluate<boolean>("document.querySelector('#check').disabled"));
    assert.equal(await action.evaluate<string>("document.querySelector('#origin').textContent"), origin);
    assert.equal(await action.evaluate<string>("document.querySelector('#profile-id').textContent"), target.profileId);
    assert.equal(collectionCalls, collects, "Read-only recovery must not collect cookies");
    await noPost(before); assert.equal(physicalSends, 0); await action.close();
  });
  await record("visible popup expires consent without cookies or handoff", async () => {
    await prepare(); const before = imports.length, collects = collectionCalls;
    const action = await popup();
    await until(async () => action.evaluate<boolean>("!document.querySelector('#connect').disabled"), "Expiry fixture needs a confirmed target before shortening its public metadata");
    // Shorten this synthetic public consent snapshot, never the runtime's lease
    // or Chrome clock. This exercises the actual popup expiry timer/validator.
    await page.locator(targetSelector).evaluate(element => {
      const target = JSON.parse(element.getAttribute("data-9router-chatgpt-session-target")!);
      target.expiresAt = new Date(Date.now() + 3500).toISOString();
      element.setAttribute("data-9router-chatgpt-session-target", JSON.stringify(target));
    });
    await until(async () => action.evaluate<boolean>("document.querySelector('#connect').disabled && /expired/i.test(document.querySelector('#target-help').textContent)"), "Visible expired popup must revoke consent immediately");
    assert.equal(collectionCalls, collects); await noPost(before); await action.close(); await openConnection();
  });
  await record("Extension to Paste or File and back prepares a fresh idle target", async () => {
    const initial = await prepare(), before = imports.length, collects = collectionCalls;
    let chooserCount = 0;
    const onChooser = () => { chooserCount++; };
    page.on("filechooser", onChooser);
    try {
      await showImportMethod("paste");
      await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(transfer()));
      assert.equal(await page.locator(targetSelector).count(), 0);
      await showImportMethod("extension");
      await page.locator(targetSelector).waitFor();
      const afterPaste = await readTarget(); assert.notEqual(afterPaste.attemptId, initial.attemptId);
      await clearDraft();
      await showImportMethod("file");
      await page.locator(inputSelector).setInputFiles({ name: "offline-session.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(transfer())) });
      assert.equal(await page.locator(targetSelector).count(), 0);
      await showImportMethod("extension");
      await page.locator(targetSelector).waitFor();
      const afterFile = await readTarget(); assert.notEqual(afterFile.attemptId, afterPaste.attemptId);
      await clearDraft(); assert.equal(chooserCount, 0, "Extension and mode choice must not open a file chooser");
      assert.equal(collectionCalls, collects); await noPost(before); assert.equal(physicalSends, 0);
    } finally { page.off("filechooser", onChooser); }
  });
  await record("runtime action invalidates old extension consent without Send", async () => {
    const target = await prepare(), before = imports.length, collects = collectionCalls;
    await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
    assert.equal(await page.locator(targetSelector).count(), 0, "Leaving Connection must invalidate consent");
    const restarted = page.waitForResponse(response => response.url().endsWith("/runtime/browser/restart") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Restart browser", exact: true }).click();
    // This unauthenticated fixture may fail the post-restart session probe.
    // Consent must still be invalidated independently of probe success.
    await restarted;
    await until(async () => page.getByRole("tab", { name: "Connection", exact: true }).isEnabled(), "Runtime action must settle before returning to Connection", 120000);
    await page.getByRole("tab", { name: "Connection", exact: true }).click();
    const renewed = await prepare(); assert.notEqual(renewed.attemptId, target.attemptId);
    assert.equal(collectionCalls, collects); await noPost(before); assert.equal(physicalSends, 0); await clearDraft();
  });
  await record("dashboard five-minute expiry requires explicit preparation", async () => {
    const target = await prepare(), before = imports.length, collects = collectionCalls;
    const action = await popup();
    await until(async () => {
      const metadata = await assistant().getAttribute("data-9router-chatgpt-session-assistant");
      return await page.locator(targetSelector).count() === 0 && !!metadata && JSON.parse(metadata).reason === "expired";
    }, "Dashboard must invalidate its actual expired target", Math.max(15000, Date.parse(target.expiresAt) - Date.now() + 15000));
    await until(async () => action.evaluate<boolean>("document.querySelector('#connect').disabled"), "Popup must reject dashboard expiry");
    assert.equal(collectionCalls, collects); await noPost(before); await action.close();
    await showImportMethod("paste"); await showImportMethod("extension");
    await Bun.sleep(1100);
    assert.equal(await page.locator(targetSelector).count(), 0, "Method switching must not renew an expired attempt automatically");
    const renewed = await prepare(); assert.notEqual(renewed.attemptId, target.attemptId);
    await clearDraft(); await noPost(before); assert.equal(physicalSends, 0);
  });
  await record("direct authenticated multipart import", async () => {
    const target = await prepare(), before = imports.length, collects = collectionCalls;
    activeCase = "direct authenticated multipart import: opening settled action popup";
    const action = await popup();
    activeCase = "direct authenticated multipart import: checking actual consent origin";
    const actualOrigin = await action.evaluate<string>("document.querySelector('#origin').textContent");
    // Only the actual origin is allowlisted for diagnostics. Never surface arbitrary
    // popup text/backend errors: their messages could include submitted input.
    let diagnosticOrigin = "unavailable";
    try { const url = new URL(actualOrigin); if (["http:", "https:"].includes(url.protocol) && url.origin === actualOrigin) diagnosticOrigin = actualOrigin; } catch {}
    safeFailureMetadata = { actualOrigin: diagnosticOrigin, expectedOrigin: origin };
    assert.equal(actualOrigin, origin);
    safeFailureMetadata = undefined;
    activeCase = "direct authenticated multipart import: checking consent metadata";
    assert((await action.evaluate<string>("document.querySelector('#connection-name').textContent")).includes(connection.name));
    assert((await action.evaluate<string>("document.querySelector('#profile-id').textContent")).includes(target.profileId));
    assert.equal(collectionCalls, collects, "Opening the popup must not collect cookies");
    await action.send("Page.enable");
    const screenshot = await action.send("Page.captureScreenshot"); assert(screenshot.data); writeFileSync(join(proof, "extension-popup-desktop.png"), Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
    await page.screenshot({ path: join(proof, "dashboard-assistant-desktop.png"), fullPage: true });
    activeCase = "direct authenticated multipart import: submitting once and observing result";
    await clickPopup(action, "connect"); await outcome(action, /Session import completed/i); await action.close();
    assert.equal(imports.length, before + 1); assert.equal(imports.at(-1)!.status, 200);
    activeCase = "direct authenticated multipart import: observing actual browser security headers";
    await until(() => wireImports.length === 1 && wireHeaders.get(wireImports[0])?.observed === true, "Network-service import headers were not observed");
    const actualHeaders = wireHeaders.get(wireImports[0])!;
    safeFailureMetadata = { actualOrigin: actualHeaders.origin ?? "missing", expectedOrigin: origin, actualSite: actualHeaders.site ?? "missing", headerSource: "Network.requestWillBeSentExtraInfo" };
    assert.equal(actualHeaders.origin, origin);
    assert.equal(actualHeaders.site, "same-origin");
    safeFailureMetadata = undefined;
    activeCase = "direct authenticated multipart import: verifying persisted runtime evidence";
    await page.getByText("Connected and ready.", { exact: true }).waitFor();
    assert(runtime.profiles.ready(target.profileId));
    const saved = await (await runtime.profiles.manager(target.profileId).ensureContext()).cookies();
    for (const fixture of cookies()) assert(saved.some(cookie => cookie.name === fixture.name && cookie.value === fixture.value && cookie.httpOnly && cookie.secure));
    const rows = await (await page.request.get(`${origin}/api/providers`)).json();
    assert.equal(rows.connections.find((row: { id: string }) => row.id === connection.id).testStatus, "active");
    const catalog = await (await page.request.get(`${origin}/api/providers/${connection.id}/models`)).json();
    assert(catalog.models.some((model: { id: string }) => model.id === "chatgpt-web/gpt-5.6-sol"));
    await clearDraft(); assert.equal(downloads, 0); assert.equal(nativeStarts, 0);
    activeCase = "direct authenticated multipart import: consumed attempt requires explicit preparation";
    await showSignInMethod("browser");
    await showSignInMethod("extension");
    await assistant().waitFor(); await showImportMethod("extension");
    assert.equal(await page.locator(targetSelector).count(), 0, "Reopening assistant must not mint a fresh consumed attempt");
    const renewed = await prepare(); assert.notEqual(renewed.attemptId, target.attemptId);
    assert.equal(renewed.profileId, target.profileId); await noPost(before + 1); await clearDraft();
  });
  await record("desktop mobile accessibility and credential boundary", async () => {
    await prepare(); await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement !== document.body), "Keyboard focus must reach an assistant control");
    await showImportMethod("paste"); assert.equal(await page.getByRole("textbox", { name: "Session JSON", exact: true }).getAttribute("autocomplete"), "off");
    await showImportMethod("extension");
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile controls overflow");
    await page.screenshot({ path: join(proof, "dashboard-assistant-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const exposed = await page.evaluate(() => ({ text: document.body.innerText, textNodes: [...document.querySelectorAll("*")].flatMap(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent?.trim() ?? "")), attributes: [...document.querySelectorAll("*")].flatMap(element => [...element.attributes].map(attribute => attribute.value)) }));
    assert(!JSON.stringify(exposed).includes("offline-account"));
    assert(!exposed.textNodes.includes("-import") && !exposed.attributes.includes("-import"), "Multipart cookie value must not be a DOM text/attribute value");
    assert(!/["']value["']\s*:\s*["']-import["']/.test(exposed.text + exposed.attributes.join("\n")), "Serialized multipart cookie credentials must not appear in DOM");
  });
  const localReject = async (mutate: () => Promise<void>) => {
    await prepare(); const action = await popup(), before = imports.length, collects = collectionCalls;
    await mutate();
    const currentTargets = await rootCdp!.send("Target.getTargets");
    if (!currentTargets.targetInfos.some(target => target.targetId === action.targetId)) {
      // Navigation/focus changes can natively dismiss action popups. That is a
      // rejected consent boundary, not an observer error to evaluate/replay.
      // Only this precheck-mutation scenario accepts observed native dismissal.
      action.detachClosedDocument();
      await noPost(before); assert.equal(collectionCalls, collects, "Dismissed consent must not collect cookies");
      return;
    }
    if (!await action.evaluate<boolean>("document.querySelector('#connect').disabled")) {
      await clickPopup(action, "connect");
      await until(async () => action.evaluate<boolean>("document.querySelector('#connect').disabled && [document.querySelector('#status'), document.querySelector('#target-help')].some(element => element.textContent.trim() !== '' && element.textContent.trim() !== 'Checking the active dashboard tab…')"), "Rejected precheck must revoke consent", 135000);
    }
    await noPost(before); assert.equal(collectionCalls, collects, "Failed precheck must not collect cookies"); await action.close();
  };
  await record("missing and ambiguous targets", async () => {
    await localReject(async () => { await page.locator(targetSelector).evaluate(element => element.removeAttribute("data-9router-chatgpt-session-target")); });
    await openConnection();
    await localReject(async () => { await page.locator(targetSelector).evaluate(element => { const clone = element.cloneNode(true); document.body.append(clone); }); });
    await openConnection();
  });
  await record("active turn and draining gates never collect", async () => {
    const manager = runtime.profiles.manager(connection.providerSpecificData.profileId);
    const { promise, resolve: settle } = Promise.withResolvers<void>();
    let turn: Promise<void> | undefined;
    try {
      await localReject(async () => { turn = manager.run("offline-connect-active", () => promise); await Promise.resolve(); });
    } finally { settle(); await turn; }
    await openConnection();
    const operation = `offline-connect-${randomUUID()}`;
    try { await localReject(async () => { runtime.state.drain(operation); }); }
    finally { await runtime.state.resume(operation, () => runtime.profiles.initialize()); }
    await openConnection();
  });
  await record("expired nonce and stale revision before consent", async () => {
    await localReject(async () => { await page.locator(targetSelector).evaluate(element => { const target = JSON.parse(element.getAttribute("data-9router-chatgpt-session-target")!); target.expiresAt = new Date(Date.now() - 1000).toISOString(); element.setAttribute("data-9router-chatgpt-session-target", JSON.stringify(target)); }); });
    await openConnection();
    await localReject(async () => { const current = runtime.state.profile(connection.providerSpecificData.profileId); runtime.state.patchProfile(current.profileId, current.revision, current.settings); });
    await openConnection();
  });
  await record("navigation and import mode switch between consent and handoff", async () => {
    await localReject(async () => { await page.goto(`${origin}/dashboard`); });
    await openConnection();
    await localReject(async () => { await showImportMethod("paste"); });
    await openConnection();
  });
  await record("changing selected profile draft invalidates consent", async () => {
    await localReject(async () => {
      const advanced = disclosure("Connection details");
      if (!(await advanced.evaluate(element => (element as HTMLDetailsElement).open))) await advanced.locator("summary").click();
      await advanced.locator("select").filter({ has: page.locator('option[value="offline-switch"]') }).selectOption("offline-switch");
    });
    const untouched = await (await runtime.profiles.manager("offline-switch").ensureContext()).cookies();
    assert.equal(untouched.filter(cookie => cookie.domain.endsWith("chatgpt.com")).length, 0);
    await openConnection();
  });
  await record("app rejects mismatched request metadata and clears File", async () => {
    const target = await prepare(), before = imports.length;
    await page.locator(inputSelector).setInputFiles({ name: "not-trusted.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(transfer())) });
    await page.evaluate(({ target, request, result }) => {
      document.addEventListener(result, event => {
        const detail: unknown = Reflect.get(event, "detail");
        if (!detail || typeof detail !== "object" || !("attemptId" in detail) || detail.attemptId !== target.attemptId) return;
        Reflect.set(window, "__offlineRejectedMetadata", detail);
      }, { once: true });
      document.dispatchEvent(new CustomEvent(request, { detail: { version: 1, attemptId: target.attemptId, profileId: target.profileId, revision: target.revision + 1 } }));
    }, { target, request: requestEvent, result: resultEvent });
    await until(async () => page.evaluate(() => Reflect.has(window, "__offlineRejectedMetadata")), "Rejected handoff needs result metadata");
    const rejected = z.object({ version: z.literal(1), attemptId: z.string(), profileId: z.string(), revision: z.number(), ok: z.literal(false), status: z.number(), code: z.string().regex(/^[a-z0-9_]{1,64}$/) }).strict().parse(await page.evaluate(() => Reflect.get(window, "__offlineRejectedMetadata")));
    assert.equal(rejected.attemptId, target.attemptId); await noPost(before); await clearDraft();
    await page.evaluate(() => Reflect.deleteProperty(window, "__offlineRejectedMetadata")); await openConnection();
  });
  await record("unauthenticated dashboard never collects", async () => {
    await localReject(async () => {
      const gatewayCookies = (await context!.cookies(origin)).map(cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path }));
      for (const cookie of gatewayCookies) await context!.clearCookies(cookie);
    });
    await login(page); await openConnection();
  });
  await record("remote HTTP target rejected", async () => {
    const remote = `http://untrusted.invalid:${port}`;
    await context!.route(`${remote}/**`, route => route.fulfill({ contentType: "text/html", body: `<div data-9router-chatgpt-session-target='${JSON.stringify({ version: 1, attemptId: randomUUID(), profileId: connection.providerSpecificData.profileId, revision: runtime.state.profile(connection.providerSpecificData.profileId).revision, connectionName: connection.name, expiresAt: new Date(Date.now() + 300000).toISOString() })}'><input type=file data-9router-chatgpt-session-file></div>` }));
    await page.goto(`${remote}/dashboard/providers/chatgpt-web`);
    const before = imports.length, collects = collectionCalls, action = await popup();
    await until(async () => action.evaluate<boolean>("document.querySelector('#connect').disabled"), "Remote HTTP direct must be disabled");
    await noPost(before); assert.equal(collectionCalls, collects); await action.close(); await openConnection();
  });
  await record("target change after collection rejects before handoff", async () => {
    await prepare(); const before = imports.length, collects = collectionCalls, action = await popup();
    let revoked = false;
    onCollected = async () => { await page.locator(targetSelector).evaluate(element => element.removeAttribute("data-9router-chatgpt-session-target")); revoked = true; };
    await clickPopup(action, "connect");
    await until(() => revoked || !!debuggerFailure, "Post-collection barrier must invalidate the target before the second authenticated confirmation");
    assert(!debuggerFailure);
    await outcome(action, /session_target_unavailable|prepare|dashboard/i);
    await noPost(before); assert.equal(collectionCalls, collects + 1); await action.close(); await clearDraft(); await openConnection();
  });
  await record("closing popup during authenticated readonly precheck does not cancel", async () => {
    await prepare(); const action = await popup(), before = imports.length;
    const { promise: arrived, resolve: enter } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    await page.route("**/runtime/profiles", async route => { const response = await route.fetch(); enter(); await gate; await route.fulfill({ response }); }, { times: 1 });
    try {
      await clickPopup(action, "connect");
      await Promise.race([arrived, Bun.sleep(15000).then(() => { throw new Error("Readonly precheck was not observed"); })]);
      await action.close(); release();
      await until(() => imports.length === before + 1 && imports.at(-1)!.status === 200, "Worker must continue independently of popup", 120000);
      await until(async () => page.getByRole("button", { name: "Verify saved session", exact: true }).isEnabled(), "Popup-close importer must release app busy state", 120000);
      await clearDraft();
    } finally { release(); }
  });
  await record("duplicate request and popup close do not replay", async () => {
    const target = await prepare(), action = await popup(), before = imports.length;
    const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    // Hold the existing offline /api/auth/session fixture response while the real
    // authenticated gateway POST is inside runtime import maintenance. No public
    // probe wrapper is substituted: import uses its private maintenance probe.
    authSessionGate = { entered, settled: gate };
    try {
      await clickPopup(action, "connect");
      await Promise.race([waiting, Bun.sleep(15000).then(() => { throw new Error("Runtime import authentication probe was not observed"); })]);
      assert.equal(await action.evaluate<boolean>("document.querySelector('#connect').disabled"), true, "Repeated Connect is locked synchronously");
      const repeated = await action.evaluate<{ x: number; y: number }>("(()=>{const r=document.querySelector('#connect').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await action.send("Input.dispatchMouseEvent", { type: "mousePressed", ...repeated, button: "left", clickCount: 2 });
      await action.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...repeated, button: "left", clickCount: 2 });
      await page.evaluate(({ target, event }) => {
        document.dispatchEvent(new CustomEvent(event, { detail: { version: 1, attemptId: target.attemptId, profileId: target.profileId, revision: target.revision } }));
      }, { target, event: requestEvent });
      await action.close(); release();
      await until(() => imports.length === before + 1 && imports.at(-1)!.status === 200, "Owned importer must finish after popup closes", 120000);
      await until(async () => page.getByRole("button", { name: "Verify saved session", exact: true }).isEnabled(), "App-owned import must settle busy state before the next attempt", 120000);
      await page.getByText("Connected and ready.", { exact: true }).waitFor({ timeout: 120000 });
      assert.equal(imports.length, before + 1); await clearDraft();
    } finally { authSessionGate = undefined; release(); }
  });
  await record("runtime revision race rejects once with no replay", async () => {
    await prepare(); const before = imports.length, action = await popup();
    await page.route("**/runtime/session/import", async route => {
      const current = runtime.state.profile(connection.providerSpecificData.profileId); runtime.state.patchProfile(current.profileId, current.revision, current.settings);
      await route.continue();
    }, { times: 1 });
    await clickPopup(action, "connect"); await outcome(action, /profile changed|profile_revision_conflict/i); await action.close();
    await until(() => imports[before]?.status !== undefined, "Revision-race POST response must be observed", 120000);
    safeFailureMetadata = { expectedImports: before + 1, actualImports: imports.length, expectedStatus: 409, actualStatus: imports[before]?.status ?? null };
    assert.equal(imports.length, before + 1); assert.equal(imports[before]?.status, 409);
    safeFailureMetadata = undefined;
    await until(async () => page.getByRole("button", { name: "Verify saved session", exact: true }).isEnabled(), "Revision-race importer must settle busy state", 120000);
    await noPost(before + 1); await clearDraft();
    await openConnection();
  });
  await record("account mismatch restores account and cookies", async () => {
    const id = connection.providerSpecificData.profileId;
    const identity = runtime.state.profile(id), saved = await (await runtime.profiles.manager(id).ensureContext()).cookies();
    await context!.clearCookies({ domain: "chatgpt.com" }); await context!.addCookies(cookies("offline-other-account"));
    await prepare(); const before = imports.length, action = await popup();
    await clickPopup(action, "connect"); await outcome(action, /session_account_mismatch|dashboard/i); await action.close();
    assert.equal(imports.length, before + 1); assert.equal(imports.at(-1)!.status, 409);
    assert.deepEqual(runtime.state.profile(id), identity); assert.deepEqual(await (await runtime.profiles.manager(id).ensureContext()).cookies(), saved);
    assert.equal(runtime.profiles.ready(id), false); await clearDraft();
    const verify = page.waitForResponse(response => response.url().endsWith("/runtime/session/verify") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Verify saved session", exact: true }).click(); assert.equal((await verify).status(), 200); assert(runtime.profiles.ready(id));
    await context!.clearCookies({ domain: "chatgpt.com" }); await context!.addCookies(cookies());
  });
  await record("copy paste and denied clipboard are explicit actions", async () => {
    await prepare(); const action = await popup(), before = imports.length;
    activeCase = "copy paste and denied clipboard: explicit Copy Session JSON";
    await context!.grantPermissions(["clipboard-read", "clipboard-write"]);
    await clickPopup(action, "copy"); await outcome(action, /copied/i);
    const json = await page.evaluate(() => navigator.clipboard.readText()); assert.equal(JSON.parse(json).format, "9router-chatgpt-session");
    await action.close(); await showImportMethod("paste");
    await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(json); await noPost(before);
    await page.getByRole("button", { name: "Import pasted session", exact: true }).click();
    activeCase = "copy paste and denied clipboard: paste response and app-owned cleanup settling";
    await until(() => imports.length === before + 1 && imports[before]?.status === 200, "Paste must use the same importer", 120000);
    await clearDraft();
    await page.getByText("Connected and ready.", { exact: true }).waitFor();
    await context!.clearPermissions();
    activeCase = "copy paste and denied clipboard: unfocused shipped extension document";
    // Privileged extension pages bypass clipboard permission settings, but Blink
    // still rejects unfocused documents before that exemption. Open the same
    // downloaded popup module as a stable tab because action popups disappear
    // when focus leaves. No script/API/manifest mutation is involved.
    const deniedPage = await context!.newPage();
    await deniedPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await deniedPage.locator("details > summary").click();
    await deniedPage.getByRole("button", { name: "Copy Session JSON", exact: true }).waitFor();
    const targets = (await rootCdp!.send("Target.getTargets")).targetInfos.filter((target: { url: string }) => target.url === `chrome-extension://${extensionId}/popup.html`);
    assert.equal(targets.length, 1, "Only the owned packaged extension document may handle the denied Copy");
    const denied = await attach(targets[0].targetId), downloadsBefore = downloads, importBefore = imports.length;
    // Undo Playwright's synthetic always-focused page emulation; leave the
    // browser's actual tab focus and clipboard focus policy authoritative.
    await denied.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await page.bringToFront();
    const marker = `CGW_CLIPBOARD_FOCUS_${randomUUID().replaceAll("-", "")}`;
    await page.evaluate(marker => { document.title = marker; }, marker);
    let focusWindow = "";
    await until(() => {
      const result = spawnSync("xdotool", ["search", "--onlyvisible", "--name", marker], { cwd: worktree, encoding: "utf8" });
      const matches = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (!matches.length) return false;
      assert.equal(matches.length, 1, "Clipboard fixture may focus only the owned dashboard window"); focusWindow = matches[0]; return true;
    }, "Owned dashboard clipboard-focus window unavailable");
    assert.equal(spawnSync("xdotool", ["windowfocus", "--sync", focusWindow], { cwd: worktree }).status, 0);
    await until(async () => denied.evaluate<boolean>("!document.hasFocus()"), "Clipboard rejection must use a genuinely unfocused extension document");
    // Deliberately no synthetic user-activation grant: invoke the real Copy
    // handler in its unfocused document and let navigator.clipboard reject.
    await denied.evaluate<void>("document.querySelector('#copy').click()");
    await outcome(denied, /clipboard|permission|file|export/i);
    assert(!/copied/i.test(await denied.evaluate<string>("document.querySelector('#status').textContent")));
    assert.equal(downloads, downloadsBefore); await noPost(importBefore); await denied.close(); await context!.clearPermissions();
  });
  await record("export select explicit upload and draft cleanup", async () => {
    await prepare(); const action = await popup(), before = imports.length;
    activeCase = "export select explicit upload: actual Export button gesture";
    const beforeDownloads = downloads; await clickPopup(action, "export");
    activeCase = "export select explicit upload: observing real completed browser download";
    await until(() => downloads === beforeDownloads + 1 && [...browserDownloads.values()].at(-1)?.completed === true, "Export must produce a real browser download");
    const download = [...browserDownloads.values()].at(-1)!; assert.equal(download.name, "chatgpt-session.json");
    const path = join(downloadDir, download.name); assert(existsSync(path)); await action.close();
    activeCase = "export select explicit upload: selecting session file without mutation";
    await showImportMethod("file");
    const choosing = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "Choose session file", exact: true }).click(); await (await choosing).setFiles(path); await noPost(before);
    activeCase = "export select explicit upload: explicit file import and app-owned cleanup";
    await page.getByRole("button", { name: "Import selected session", exact: true }).click();
    await until(() => imports.length === before + 1 && imports.at(-1)!.status === 200, "Selected file import failed", 120000); await clearDraft();
    await page.locator(inputSelector).setInputFiles(path); await showImportMethod("paste"); await clearDraft();
    await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(transfer()));
    await showImportMethod("file"); await clearDraft(); await noPost(before + 1);
  });
  await record("invalid manual formats sizes UTF8 and expired cookies never POST", async () => {
    const values = ["raw-access-token", JSON.stringify({ accessToken: "offline-token", user: { id: "offline" } }), "{", JSON.stringify({ ...transfer(), cookies: cookies().map(cookie => ({ ...cookie, expires: 1 })) }), "x".repeat(262145)];
    for (const value of values) {
      await prepare(); await showImportMethod("paste"); const before = imports.length;
      await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(value);
      await page.getByRole("button", { name: "Import pasted session", exact: true }).click();
      await until(async () => await page.getByRole("textbox", { name: "Session JSON", exact: true }).inputValue() === "", "Rejected paste must be cleared"); await noPost(before); await clearDraft();
      await showImportMethod("file");
      await page.locator(inputSelector).setInputFiles({ name: "invalid-session.json", mimeType: "application/json", buffer: Buffer.from(value) });
      await page.getByRole("button", { name: "Import selected session", exact: true }).click();
      await until(async () => await page.locator(inputSelector).evaluate((element: HTMLInputElement) => !element.files?.length), "Rejected file must be cleared");
      await noPost(before); await clearDraft();
    }
    await showImportMethod("file"); const before = imports.length;
    await page.locator(inputSelector).setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from([0xff, 0xfe]) });
    await page.getByRole("button", { name: "Import selected session", exact: true }).click();
    await until(async () => await page.locator(inputSelector).evaluate((element: HTMLInputElement) => !element.files?.length), "Invalid UTF8 file must be cleared"); await noPost(before);
    await page.locator(inputSelector).setInputFiles({ name: "pending.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(transfer())) });
    await showImportMethod("extension"); await noPost(before); await clearDraft();
    await showImportMethod("paste"); await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(transfer()));
    await showImportMethod("extension"); await noPost(before); await clearDraft();
    await showImportMethod("paste");
    await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(transfer()));
    await showSignInMethod("browser"); await noPost(before);
    await showSignInMethod("extension"); await showImportMethod("paste"); await clearDraft();
    await page.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(transfer()));
    await page.getByRole("button", { name: "Close", exact: true }).last().click(); await noPost(before); await openConnection(); await showImportMethod("paste"); await clearDraft();
  });
  await record("spoofed success does not confer readiness", async () => {
    const id = connection.providerSpecificData.profileId; runtime.profiles.invalidate(id, "login_required");
    await openConnection(); const target = await prepare(), before = imports.length;
    await page.evaluate(({ target, event }) => document.dispatchEvent(new CustomEvent(event, { detail: { version: 1, attemptId: target.attemptId, profileId: target.profileId, revision: target.revision, ok: true, status: 200, code: null } })), { target, event: resultEvent });
    await noPost(before); assert.equal(runtime.profiles.ready(id), false); assert.equal(await page.getByText("Connected and ready.", { exact: true }).count(), 0);
  });
  await record("lost response is unknown and never replayed", async () => {
    await prepare(); const action = await popup(), before = imports.length;
    await page.route("**/runtime/session/import", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
    await clickPopup(action, "connect"); await outcome(action, /import_result_unknown|dashboard|saved session/i); await action.close();
    assert.equal(imports.length, before + 1); await clearDraft();
    await openConnection();
    await until(async () => {
      const metadata = await assistant().getAttribute("data-9router-chatgpt-session-assistant");
      return !!metadata && JSON.parse(metadata).reason === "consumed";
    }, "Unknown import recovery fence must survive dashboard remount without a new target");
    assert.equal(await page.locator(targetSelector).count(), 0);
    await noPost(before + 1);
    const advanced = disclosure("Connection details");
    if (!(await advanced.evaluate(element => (element as HTMLDetailsElement).open))) await advanced.locator("summary").click();
    await page.getByRole("button", { name: "Verify saved session", exact: true }).waitFor();
    const verify = page.waitForResponse(response => response.url().endsWith("/runtime/session/verify") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Verify saved session", exact: true }).click(); assert.equal((await verify).status(), 200);
    assert.equal(imports.length, before + 1);
  });
  await record("lost result observer returns unknown without replay", async () => {
    await clearDraft(); await openConnection();
    const target = await prepare(), action = await popup(), before = imports.length;
    await page.evaluate(({ event, attemptId }) => {
      document.addEventListener(event, message => {
        const detail: unknown = Reflect.get(message, "detail");
        if (detail && typeof detail === "object" && "attemptId" in detail && detail.attemptId === attemptId) message.stopImmediatePropagation();
      }, { capture: true, once: true });
    }, { event: resultEvent, attemptId: target.attemptId });
    await clickPopup(action, "connect"); await outcome(action, /result is unknown|saved session|import_result_unknown/i); await action.close();
    assert.equal(imports.length, before + 1); assert.equal(imports.at(-1)!.status, 200); assert(runtime.profiles.ready(target.profileId)); await clearDraft();
  });
  assert.equal(providerSends, 0); assert.equal(physicalSends, 0); assert.equal(nativeStarts, 0); assert(!debuggerFailure);
  assert.equal(credentialLeak, false, "Session values must not appear in console or URLs");
  const finalRows = await (await page.request.get(`${origin}/api/providers`)).json();
  assert.equal(finalRows.connections.filter((row: { provider: string }) => row.provider === "chatgpt-web").length, 1, "No boundary or replay may create a second connection");
  await clearDraft(); await page.screenshot({ path: join(proof, "dashboard-connected-desktop.png"), fullPage: true });
  const result = { event: "cgw_session_connect_smoke_passed", cases, authenticatedImports: imports.length, providerRequestsSent: providerSends, inferenceSubmits: physicalSends, clipboardRejectionCondition: "unfocused-shipped-extension-document", gatewayEntry: flags.has("--gateway-entry") ? "standalone" : "production", architecture: process.arch };
  writeFileSync(join(proof, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) {
  // Error text from a browser, backend or extension may contain submitted input.
  // Keep proof metadata fixed and never screenshot an uncleared credential draft.
  const location = error instanceof Error ? error.stack?.split("\n").find(line => /^\s*at .*session-connect-smoke\.ts:\d+:\d+\)?$/.test(line))?.trim() : undefined;
  writeFileSync(join(proof, "failure.json"), JSON.stringify({ event: "cgw_session_connect_smoke_failed", completedCases: cases, failedCase: activeCase, location, metadata: safeFailureMetadata, cdpFailure, outcomeFailure }), { mode: 0o600 });
  throw new Error(`Offline session-connect gate failed: ${activeCase}${location ? ` (${location})` : ""}${safeFailureMetadata ? ` ${JSON.stringify(safeFailureMetadata)}` : ""}${cdpFailure ? ` ${JSON.stringify(cdpFailure)}` : ""}${outcomeFailure ? ` ${JSON.stringify(outcomeFailure)}` : ""}`);
} finally {
  try { await bootstrap?.close(); } finally {
    try { await context?.close(); } finally {
      try { if (ownedGateway) { ownedGateway.kill(); await ownedGateway.exited; } } finally {
        try { await ownedRuntime?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }
}
