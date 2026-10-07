import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { startRuntime } from "../src/server";
import type { BrowserTurnLease } from "../src/browser/manager";
import type { BrowserContext } from "playwright-core";
import { MAX_SESSION_TRANSFER_BYTES, parseChatGptWebSessionTransfer } from "../session-transfer.js";

// Native Chrome signs into a local website with real desktop input. No CDP or
// Playwright connection touches that browser until explicit login confirmation.
const gateway = process.env.CGW_ONBOARDING_GATEWAY;
const proof = process.env.CGW_ONBOARDING_PROOF_DIR;
const chromiumExecutable = process.env.CGW_CHROMIUM_EXECUTABLE;
const sessionFile = process.env.CGW_ONBOARDING_SESSION_FILE;
if (!gateway || !proof || !chromiumExecutable || !sessionFile || process.platform !== "linux") throw new Error("Owned gateway, Chromium, synthetic session and proof directory required");
const sessionBytes = readFileSync(sessionFile);
assert(sessionBytes.byteLength <= MAX_SESSION_TRANSFER_BYTES, "Synthetic session fixture exceeds limit");
const session = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sessionBytes));
const sessionCookies = parseChatGptWebSessionTransfer(session);
assert(session.cookies.length === 2 && sessionCookies.length === 2 && sessionCookies.some(cookie => cookie.name === "cgw_fixture_session.0" && cookie.value === "offline-account") && sessionCookies.some(cookie => cookie.name === "cgw_fixture_session.1" && cookie.value === "-import"), "Synthetic exporter session required");
interface Box { x: number; y: number; width: number; height: number; }
interface NativeGeometry { pageId: string; sequence: number; authenticated: boolean; x: number; y: number; outerHeight: number; innerHeight: number; input: Box; button: Box; activeId: string; focused: boolean; value: string; webdriver: boolean; }
const geometry = new Map<string, NativeGeometry>();
const signedIn = new Set<string>();
const persisted = new Set<string>();
let currentId = "";
const preparedManagers = new WeakSet<object>();
const preparedContexts = new WeakSet<BrowserContext>();
const html = readFileSync(join(import.meta.dir, "../tests/fixtures/chatgpt-runtime.html"), "utf8");
let providerSends = 0;
let physicalSends = 0;
const native = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  const [, action, id] = url.pathname.split("/");
  if (!id || !/^[a-z0-9-]+$/.test(id)) return new Response(null, { status: 404 });
  if (action === "geometry" && request.method === "POST") {
    geometry.set(id, await request.json() as NativeGeometry);
    return new Response(null, { status: 204 });
  }
  if (action === "sign-in" && request.method === "POST") {
    const form = await request.formData();
    if (form.get("identity") !== "viewer-keyboard-proof" || form.get("webdriver") !== "false") return new Response("Human browser sign-in required", { status: 403 });
    return new Response(null, { status: 303, headers: { Location: `/login/${id}`, "Set-Cookie": `offline_account=${id}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax` } });
  }
  if (action !== "login") return new Response(null, { status: 404 });
  const authenticated = request.headers.get("cookie")?.split("; ").includes(`offline_account=${id}`) === true;
  if (authenticated) signedIn.add(id);
  return new Response(`<!doctype html><html><body style="margin:0;padding:50px;font:24px sans-serif;background:#eef6ff"><h1>${authenticated ? "Signed in to the offline account" : "Offline ChatGPT sign-in"}</h1><form method="post" action="/sign-in/${id}"><label for="identity">Fixture identity</label><input id="identity" name="identity" autofocus style="display:block;margin:20px 0;font:24px sans-serif;width:400px;height:40px"><input id="webdriver" type="hidden" name="webdriver"><button id="signin" style="font:24px sans-serif;padding:16px">Sign in to fixture</button></form><p>Human browser; no automation session during sign-in.</p><script>const pageId=${JSON.stringify(randomUUID())};let sequence=0;document.querySelector('#webdriver').value=String(navigator.webdriver);function report(){const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};fetch('/geometry/${id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId,sequence:++sequence,authenticated:${authenticated},x:screenX,y:screenY+outerHeight-innerHeight,outerHeight,innerHeight,input:box('identity'),button:box('signin'),activeId:document.activeElement.id,focused:document.hasFocus(),value:document.querySelector('#identity').value,webdriver:navigator.webdriver})}).catch(()=>{});}setInterval(report,100);report();</script></body></html>`, { headers: { "content-type": "text/html" } });
} });
const nativeOrigin = `http://127.0.0.1:${native.port}`;
const runtime = startRuntime({ dataDir: "/data", host: "0.0.0.0", port: 17841, chromiumExecutable,
  runtimeToken: Buffer.from("offline-viewer-data-token".repeat(4)), adminToken: Buffer.from("offline-viewer-admin-token".repeat(4)) });
const ensure = runtime.profiles.ensureProfileBrowser.bind(runtime.profiles);
const probe = runtime.profiles.probe.bind(runtime.profiles);
runtime.profiles.probe = async (...args) => {
  const result = await probe(...args);
  const manager = args[3] ?? runtime.profiles.manager(args[0]);
  await (await manager.maintenancePage()).evaluate(() => {
    const fixture: unknown = Reflect.get(window, "fixture");
    if (!fixture || typeof fixture !== "object" || !("sends" in fixture) || fixture.sends !== 0) {
      throw new Error("Login verification submitted a synthetic prompt");
    }
  });
  return result;
};
const prepare = async (id: string) => {
  const manager = await ensure(id);
  if (!preparedManagers.has(manager)) {
    const manual = manager.startManualLogin.bind(manager);
    manager.startManualLogin = (_url, onExit) => manual(`${nativeOrigin}/login/${id}`, onExit);
    const restore = manager.restoreManualLogin.bind(manager);
    manager.restoreManualLogin = (_url, onExit) => restore(`${nativeOrigin}/login/${id}`, onExit);
    const automated = manager.ensureContext.bind(manager);
    manager.ensureContext = async () => {
      const context = await automated();
      if (!preparedContexts.has(context)) {
        await context.exposeBinding("syntheticObserveSend", () => { physicalSends++; });
        await context.addInitScript(() => {
          Object.assign(window, { __cgwLoginFixture: { composerDelayMs: 500, pointerOnly: true, semanticSlider: true, headerOnlyModel: true } });
          document.addEventListener("submit", () => {
            const observer = Reflect.get(window, "syntheticObserveSend");
            if (typeof observer === "function") void observer();
          }, true);
        });
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== "https://chatgpt.com") return route.abort();
          if (route.request().method() === "POST") providerSends++;
          const cookiePresent = (await context.cookies(nativeOrigin)).some(cookie => cookie.name === "offline_account" && cookie.value === id);
          const cookies = await context.cookies("https://chatgpt.com");
          const importedIdentity = ["cgw_fixture_session.0", "cgw_fixture_session.1"].map(name => cookies.find(cookie => cookie.name === name)?.value || "").join("");
          const identity = importedIdentity === "offline-account-import" ? importedIdentity : signedIn.has(id) && cookiePresent ? "offline-account" : null;
          const authenticated = identity !== null;
          if (authenticated) persisted.add(id);
          if (url.pathname === "/api/auth/session") return route.fulfill({ json: authenticated ? { expires: new Date(Date.now() + 3600000).toISOString(), user: { id: identity } } : {} });
          return route.fulfill({ contentType: "text/html", body: authenticated ? html : "<!doctype html><html><body><h1>Sign in required</h1></body></html>" });
        });
        preparedContexts.add(context);
      }
      return context;
    };
    preparedManagers.add(manager);
  }
  return manager;
};
const viewer = runtime.profiles.startViewer.bind(runtime.profiles);
runtime.profiles.startViewer = async (id, login, trace) => { await prepare(id); return viewer(id, login, trace); };
runtime.profiles.ensureProfileBrowser = prepare;
const importSession = runtime.profiles.importSession.bind(runtime.profiles);
runtime.profiles.importSession = async (id, revision, session) => { await prepare(id); return importSession(id, revision, session); };
const verifySession = runtime.profiles.verifySession.bind(runtime.profiles);
runtime.profiles.verifySession = async (id, revision) => { await prepare(id); return verifySession(id, revision); };
const until = async (condition: () => boolean, label: string, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await Bun.sleep(50);
  assert(condition(), `${label}: ${JSON.stringify(geometry.get(currentId))}`);
};
let inspection: BrowserTurnLease | undefined;
try {
  await runtime.initialized;
  // A typed UI failure during initialization must not poison other profiles or admin APIs.
  runtime.state.createProfile("startup-ui-error"); runtime.state.createProfile("startup-ready");
  const failedContext = await (await prepare("startup-ui-error")).ensureContext();
  await failedContext.addCookies(sessionCookies);
  await failedContext.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector("form");
    if (form) { form.hidden = false; form.after(form.cloneNode(true)); }
  }));
  await (await (await prepare("startup-ready")).ensureContext()).addCookies(sessionCookies);
  await runtime.profiles.initialize();
  assert.equal(runtime.profiles.ready("startup-ui-error"), false);
  assert.equal(runtime.profiles.ready("startup-ready"), true);
  const failedStatus = runtime.profiles.status("startup-ui-error") as { lastError: string };
  assert.equal(failedStatus.lastError, "profile_probe_failed");
  await runtime.profiles.manager("startup-ui-error").close();
  await runtime.profiles.manager("startup-ready").close();
  runtime.state.createProfile("ui-inspection");
  const inspector = await ensure("ui-inspection");
  inspection = await inspector.leaseTurn({ traceId: "provider-ui-inspection", modelIdentity: "offline-ui" });
  const page = inspection.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  const loginResponse = await page.request.post(`${gateway}/api/auth/login`, { data: { password: "Offline-Provider-UI-Fixture-20261004" } });
  assert.equal(loginResponse.status(), 200);
  await page.goto(`${gateway}/dashboard/providers/chatgpt-web`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Add Connection/ }).click();
  await page.getByRole("textbox", { name: "Connection name", exact: true }).fill("Offline integrated account");
  assert.equal(await page.getByPlaceholder("personal", { exact: true }).count(), 0);
  const creation = page.waitForResponse(r => r.url().endsWith("/api/providers") && r.request().method() === "POST");
  const opening = page.waitForResponse(r => r.url().endsWith("/runtime/login/start") && r.request().method() === "POST");
  void opening.catch(() => {});
  await page.getByRole("button", { name: "Add Connection and Sign In", exact: true }).click();
  assert.equal((await creation).status(), 201);
  const opened = await opening; assert.equal(opened.status(), 200);
  const loginLease = await opened.json();
  assert.equal(loginLease.manualLogin, true);
  const id = loginLease.profileId;
  currentId = id;
  const waitViewer = async () => {
    await page.locator("canvas").waitFor({ timeout: 30000 });
    await page.getByText(/Connected.*browser|Browser.*connected|Private browser connected/i).first().waitFor({ timeout: 30000 });
  };
  await waitViewer();
  await until(() => geometry.has(id), "Native login page did not load");
  assert.equal(geometry.get(id)!.webdriver, false, "Google sign-in must not run in an automated browser");
  const bounds = await page.locator("canvas").boundingBox(); assert(bounds);
  assert(bounds.width > 850 && bounds.height > 600, "Browser must occupy the full-window workspace, not the connection modal");
  const viewport = page.viewportSize()!;
  assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, "Browser must be visible without nested modal scrolling");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Offline integrated account — Browser", exact: true }).count(), 1, "Browser Escape must not dismiss the connection");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWorkspace = await page.getByRole("dialog", { name: "Offline integrated account — Browser", exact: true }).boundingBox(); assert(mobileWorkspace);
  assert.equal(mobileWorkspace.width, 390); assert.equal(mobileWorkspace.height, 844);
  const mobileFinish = await page.getByRole("button", { name: "Finish Sign In", exact: true }).boundingBox(); assert(mobileFinish);
  assert(mobileFinish.x >= 0 && mobileFinish.x + mobileFinish.width <= 390 && mobileFinish.y + mobileFinish.height < 200, "Mobile sign-in controls must remain visible");
  await page.getByRole("button", { name: "Actual Size", exact: true }).click();
  await page.getByRole("button", { name: "Pan Browser", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Pan Browser", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Fit to Window", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1024 });
  const response = await page.request.get(`${gateway}/api/providers`); assert.equal(response.status(), 200);
  const connections = (await response.json()).connections.filter((row: { provider: string }) => row.provider === "chatgpt-web");
  assert.equal(connections.length, 1); assert.equal(connections[0].testStatus, "login_required");
  assert.equal(connections[0].providerSpecificData.profileId, id); assert.match(id, /^cgw-[a-f0-9-]+$/);
  await page.getByRole("button", { name: "Back to Connection", exact: true }).click();
  await page.locator("canvas").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Import Chrome Session", exact: true }).click();
  const waitingAssistant = page.getByRole("region", { name: "Connect ChatGPT session", exact: true });
  assert.equal(await waitingAssistant.locator("[data-9router-chatgpt-session-target]").count(), 0);
  await waitingAssistant.getByRole("tab", { name: "Upload file", exact: true }).click();
  assert.equal(await waitingAssistant.getByRole("button", { name: "Choose session file", exact: true }).isEnabled(), false);
  await waitingAssistant.getByRole("tab", { name: "Paste JSON", exact: true }).click();
  assert.equal(await waitingAssistant.getByRole("button", { name: "Import pasted session", exact: true }).isEnabled(), false);
  const resumed = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/runtime/login/session") && r.request().method() === "GET");
  await waitingAssistant.getByRole("button", { name: "Use private browser instead", exact: true }).click();
  const resumedSession = await resumed; assert.equal(resumedSession.status(), 200);
  assert.equal(new URL(resumedSession.url()).searchParams.get("loginId"), loginLease.loginId);
  await waitViewer();
  // Premature verification must restore the human browser under the same lease.
  const previousPageId = geometry.get(id)!.pageId;
  const premature = page.waitForResponse(r => r.url().endsWith("/runtime/login/complete") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish Sign In", exact: true }).click();
  assert((await premature).status() >= 400);
  await waitViewer();
  await until(() => geometry.get(id)?.pageId !== previousPageId, "Restored native login document did not load");
  assert.equal(runtime.profiles.ready(id), false);
  const restored = await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/login/status?loginId=${loginLease.loginId}`);
  assert.equal(restored.status(), 200);
  const restoredLease = await restored.json();
  assert.equal(restoredLease.loginId, loginLease.loginId); assert.equal(restoredLease.profileId, id); assert.equal(restoredLease.state, "waiting"); assert.equal(restoredLease.manualLogin, true);
  const privateAddress = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === "IPv4")?.address; assert(privateAddress);
  const exposed = await new Promise<boolean>(resolve => { const socket = connect({ host: privateAddress, port: 5900 }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); }); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); });
  assert.equal(exposed, false, "Private VNC must refuse nonloopback connections");
  const canvas = page.locator("canvas");
  await canvas.click();
  await until(() => geometry.get(id)?.focused === true, "Native browser did not receive focus");
  const clickNative = async (kind: "input" | "button") => {
    const target = geometry.get(id)!; const box = target[kind]; const rect = await canvas.boundingBox(); assert(rect);
    const size = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }));
    await page.mouse.click(rect.x + (target.x + box.x + box.width / 2) * rect.width / size.width, rect.y + (target.y + box.y + box.height / 2) * rect.height / size.height);
    await until(() => { const observed = geometry.get(id)!; return observed.pageId !== target.pageId || observed.sequence > target.sequence; }, "Native pointer observation did not advance");
  };
  await clickNative("input");
  await until(() => geometry.get(id)?.activeId === "identity" && geometry.get(id)?.focused === true, "Real desktop input did not receive keyboard focus");
  // Send each key once; wait for the native document to observe it, not an arbitrary delay.
  await canvas.focus();
  let typed = "";
  for (const character of "viewer-keyboard-proof") {
    await canvas.press(character);
    typed += character;
    await until(() => geometry.get(id)?.value === typed, "Keyboard input did not reach native Chrome");
  }
  mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: join(proof, "provider-embedded-login.png"), fullPage: true });
  await clickNative("button");
  await until(() => signedIn.has(id) && geometry.get(id)?.authenticated === true, "Native human sign-in document did not settle");
  assert.equal(runtime.profiles.ready(id), false, "Login completion requires explicit verification");
  const completed = page.waitForResponse(r => r.url().endsWith("/runtime/login/complete") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish Sign In", exact: true }).click();
  const finished = await completed;
  const finishedBody = await finished.json();
  assert.equal(finished.status(), 200, JSON.stringify(finishedBody)); assert.equal(finishedBody.state, "completed");
  await until(() => runtime.profiles.ready(id), "Authenticated catalog probe did not settle", 60000);
  assert(persisted.has(id), "Native login cookie did not survive the same-profile verification restart");
  await canvas.waitFor({ state: "detached" });
  await page.getByText("Connected and ready.", { exact: true }).waitFor();
  const reconciled = await page.request.get(`${gateway}/api/providers`);
  assert.equal((await reconciled.json()).connections.find((row: { id: string }) => row.id === connections[0].id).testStatus, "active");
  const models = await page.request.get(`${gateway}/api/providers/${connections[0].id}/models`); assert.equal(models.status(), 200);
  const catalog = (await models.json()).models as { id: string }[];
  assert(catalog.some(row => row.id === "chatgpt-web/gpt-5.6-sol-instant"));
  assert(catalog.some(row => row.id === "chatgpt-web/gpt-5.6-sol"));
  const profilesResponse = await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/profiles`);
  assert.equal(profilesResponse.status(), 200);
  const profileCatalog = (await profilesResponse.json()).profiles.find((row: { profileId: string }) => row.profileId === id);
  assert(profileCatalog);
  const sol = profileCatalog.models.find((row: { id: string }) => row.id === "chatgpt-web/gpt-5.6-sol");
  assert(sol); assert.deepEqual(sol.supported_reasoning_levels, ["medium", "high"]); assert.equal(sol.default_reasoning_level, "high");
  assert.equal((await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/login/session?loginId=${loginLease.loginId}`)).status(), 404);
  await page.screenshot({ path: join(proof, "provider-connected-ready.png"), fullPage: true });
  await page.locator("section[aria-label='ChatGPT Web connection'] summary").click();
  const verified = page.waitForResponse(r => r.url().endsWith("/runtime/session/verify") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Use Saved Session", exact: true }).click();
  assert.equal((await verified).status(), 200);
  assert.equal(await page.locator("canvas").count(), 0);
  const manualIdentity = runtime.state.profile(id);
  await page.getByRole("button", { name: "Import Chrome Session", exact: true }).click();
  const assistant = page.getByRole("region", { name: "Connect ChatGPT session", exact: true });
  await assistant.getByRole("tab", { name: "Upload file", exact: true }).click();
  const choosingMismatch = page.waitForEvent("filechooser");
  await assistant.getByRole("button", { name: "Choose session file", exact: true }).click();
  await (await choosingMismatch).setFiles(sessionFile);
  const mismatch = page.waitForResponse(r => r.url().endsWith("/runtime/session/import") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Import selected session", exact: true }).click();
  const rejectedImport = await mismatch;
  assert.equal(rejectedImport.status(), 409);
  assert.equal((await rejectedImport.json()).error.code, "session_account_mismatch");
  assert.deepEqual(runtime.state.profile(id), manualIdentity);
  assert.equal(await page.locator("canvas").count(), 0);
  const reverified = page.waitForResponse(r => r.url().endsWith("/runtime/session/verify") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Use Saved Session", exact: true }).click();
  assert.equal((await reverified).status(), 200);
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: /^(?:add\s+)?Add$/i }).click();
  await page.getByRole("textbox", { name: "Connection name", exact: true }).fill("Offline imported account");
  const creatingImport = page.waitForResponse(r => r.url().endsWith("/api/providers") && r.request().method() === "POST");
  let nativeStarts = 0, uploads = 0;
  const observeActions = (request: { url(): string; method(): string }) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/runtime/login/start") || request.url().endsWith("/runtime/browser/view")) nativeStarts++;
    if (request.url().endsWith("/runtime/session/import")) uploads++;
  };
  page.on("request", observeActions);
  await page.getByRole("button", { name: "Add Connection and Import Session", exact: true }).click();
  const createdImport = await creatingImport; assert.equal(createdImport.status(), 201);
  const secondConnection = (await createdImport.json()).connection;
  const importedId = secondConnection.providerSpecificData.profileId;
  assert.notEqual(importedId, id);
  await assistant.waitFor();
  await assistant.getByRole("link", { name: "Download Chrome helper", exact: true }).waitFor();
  await assistant.getByRole("tab", { name: "Upload file", exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await assistant.getByRole("button", { name: "Choose session file", exact: true }).click();
  await (await choosing).setFiles(sessionFile);
  assert.equal(uploads, 0, "Selecting a file must not read or submit credentials");
  const importing = page.waitForResponse(r => r.url().endsWith("/runtime/session/import") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Import selected session", exact: true }).click();
  const importedResponse = await importing; assert.equal(importedResponse.status(), 200);
  assert.equal((await importedResponse.json()).state, "ready");
  await page.getByText("Connected and ready.", { exact: true }).waitFor();
  assert.equal(nativeStarts, 0); assert.equal(uploads, 1); assert.equal(await page.locator("canvas").count(), 0);
  const importModels = await page.request.get(`${gateway}/api/providers/${secondConnection.id}/models`);
  assert.equal(importModels.status(), 200);
  assert((await importModels.json()).models.some((row: { id: string }) => row.id === "chatgpt-web/gpt-5.6-sol"));
  await page.getByRole("button", { name: "Import Chrome Session", exact: true }).click();
  await assistant.getByRole("tab", { name: "Paste JSON", exact: true }).click();
  await assistant.getByRole("textbox", { name: "Session JSON", exact: true }).fill(JSON.stringify(session));
  assert.equal(uploads, 1, "Pasting JSON must not submit credentials");
  const pasted = page.waitForResponse(r => r.url().endsWith("/runtime/session/import") && r.request().method() === "POST");
  await assistant.getByRole("button", { name: "Import pasted session", exact: true }).click();
  assert.equal((await pasted).status(), 200);
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session JSON"]')?.value === "");
  await page.getByText("Connected and ready.", { exact: true }).waitFor();
  assert.equal(await assistant.getByRole("textbox", { name: "Session JSON", exact: true }).inputValue(), "");
  assert.equal(nativeStarts, 0); assert.equal(uploads, 2);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(proof, "provider-import-ready.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(proof, "provider-import-mobile.png"), fullPage: true });
  const importBounds = await page.getByRole("button", { name: "Import Chrome Session", exact: true }).boundingBox(); assert(importBounds);
  assert(importBounds.x >= 0 && importBounds.x + importBounds.width <= 390, "Mobile import control must fit the viewport");
  await runtime.profiles.manager(importedId).close();
  runtime.profiles.invalidate(importedId, "login_required");
  const refreshProfiles = page.waitForResponse(r => r.url().endsWith("/runtime/profiles"));
  await page.locator("section[aria-label='ChatGPT Web connection'] summary").click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await refreshProfiles;
  const reused = page.waitForResponse(r => r.url().endsWith("/runtime/session/verify") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Use Saved Session", exact: true }).click();
  assert.equal((await reused).status(), 200);
  assert.equal(runtime.profiles.ready(importedId), true);
  assert.equal(nativeStarts, 0); assert.equal(uploads, 2); assert.equal(providerSends, 0); assert.equal(physicalSends, 0);
  const importedPage = await runtime.profiles.manager(importedId).maintenancePage();
  assert.equal(await importedPage.evaluate(() => Reflect.get(window, "fixture").sends), 0);
  page.off("request", observeActions);
  const verificationSends = physicalSends;
  const importedConnections = await page.request.get(`${gateway}/api/providers`);
  assert.equal((await importedConnections.json()).connections.find((row: { id: string }) => row.id === secondConnection.id).testStatus, "active");
  const keyResponse = await page.request.post(`${gateway}/api/keys`, { data: { name: "offline-cgw-generic" } });
  assert.equal(keyResponse.status(), 201);
  const keyBody = await keyResponse.json();
  assert.equal(typeof keyBody.key, "string");
  // This disposable key is never logged, persisted in proof artifacts or used for real traffic.
  await page.goto(`${gateway}/dashboard/providers/chatgpt-web`, { waitUntil: "networkidle" });
  await page.getByText("Browser Session", { exact: true }).first().waitFor();
  assert.equal(await page.getByText(/No verified ChatGPT Web models/).count(), 0, "Recovered catalog kept a stale model warning");
  const fixtureAnswer = "Offline answer first paragraph.\n\nOffline answer second paragraph.";
  const modelTest = page.waitForResponse(r => new URL(r.url()).pathname === "/api/models/test" && r.request().method() === "POST", { timeout: 120000 });
  const beforeTest = physicalSends;
  await page.getByRole("button", { name: "Test cgw/chatgpt-web/gpt-5.6-sol", exact: true }).click();
  const tested = await modelTest;
  assert.equal(tested.status(), 200);
  const result = await tested.json();
  assert.equal(result.ok, true);
  assert.equal(result.completionText, fixtureAnswer);
  assert(connections.concat([secondConnection]).some((row: { id: string }) => row.id === result.connectionId), "Dashboard test did not report its actual connection");
  assert.equal(physicalSends, beforeTest + 1, "Dashboard model test did not perform exactly one browser Send");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(proof, "provider-model-test.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(proof, "provider-model-test-mobile.png"), fullPage: true });
  const inferenceSends = physicalSends - verificationSends;
  writeFileSync(join(proof, "result.json"), JSON.stringify({ gate: "provider-onboarding-ui", automaticProfile: true, providerConnectionPersisted: true, actualEmbeddedRfb: true, keyboardAndPointerForwarded: true, fullWindowWorkspace: true, actualSizeInput: true, sameLeaseResume: true, humanOnlyLogin: true, explicitLoginVerification: true, prematureVerificationRestored: true, persistedNativeCookie: true, readyAfterBrowserSignIn: true, liveCatalog: true, closedViewerRejected: true, distinctProfiles: true, loopbackOnlyVnc: true, savedSessionReused: true, actualExporterImport: true, accountMismatchPreserved: true, startupProfileIsolated: true, importedContextReopened: true, importWithoutNativeLogin: true, connectionReadinessReconciled: true, staleCatalogWarningCleared: true, dashboardModelInference: true, probeSends: verificationSends, inferenceSends, liveChatGpt: false }));
  console.log("CGW_PROVIDER_ONBOARDING_SMOKE_OK");
} catch (error) {
  console.error("CGW_PROVIDER_ONBOARDING_SMOKE_FAILED", error);
  if (inspection) await inspection.page.screenshot({ path: join(proof, "provider-failed.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  // These are synthetic offline fixtures, not real-account screenshots or credentials.
  for (const name of ["result.json", "provider-failed.png", "provider-embedded-login.png", "provider-connected-ready.png", "provider-import-ready.png", "provider-import-mobile.png", "provider-model-test.png", "provider-model-test-mobile.png"]) {
    const path = join(proof, name);
    if (existsSync(path)) chmodSync(path, 0o644);
  }
  if (inspection) await inspection.release();
  await runtime.close(); await native.stop();
}
