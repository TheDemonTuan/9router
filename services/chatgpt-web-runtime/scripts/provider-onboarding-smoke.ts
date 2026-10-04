import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { startRuntime } from "../src/server";
import type { BrowserTurnLease } from "../src/browser/manager";
import type { BrowserContext } from "playwright-core";

// Native Chrome signs into a local website with real desktop input. No CDP or
// Playwright connection touches that browser until explicit login confirmation.
const gateway = process.env.CGW_ONBOARDING_GATEWAY;
const proof = process.env.CGW_ONBOARDING_PROOF_DIR;
const chromiumExecutable = process.env.CGW_CHROMIUM_EXECUTABLE;
if (!gateway || !proof || !chromiumExecutable || process.platform !== "linux") throw new Error("Owned gateway, Chromium and proof directory required");
interface Box { x: number; y: number; width: number; height: number; }
interface NativeGeometry { x: number; y: number; outerHeight: number; innerHeight: number; input: Box; button: Box; activeId: string; focused: boolean; value: string; webdriver: boolean; }
const geometry = new Map<string, NativeGeometry>();
const signedIn = new Set<string>();
const persisted = new Set<string>();
const preparedManagers = new WeakSet<object>();
const preparedContexts = new WeakSet<BrowserContext>();
const html = readFileSync(join(import.meta.dir, "../tests/fixtures/chatgpt-runtime.html"), "utf8");
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
  return new Response(`<!doctype html><html><body style="margin:0;padding:50px;font:24px sans-serif;background:#eef6ff"><h1>${authenticated ? "Signed in to the offline account" : "Offline ChatGPT sign-in"}</h1><form method="post" action="/sign-in/${id}"><label for="identity">Fixture identity</label><input id="identity" name="identity" autofocus style="display:block;margin:20px 0;font:24px sans-serif;width:400px;height:40px"><input id="webdriver" type="hidden" name="webdriver"><button id="signin" style="font:24px sans-serif;padding:16px">Sign in to fixture</button></form><p>Human browser; no automation session during sign-in.</p><script>document.querySelector('#webdriver').value=String(navigator.webdriver);function report(){const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};fetch('/geometry/${id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:screenX,y:screenY+outerHeight-innerHeight,outerHeight,innerHeight,input:box('identity'),button:box('signin'),activeId:document.activeElement.id,focused:document.hasFocus(),value:document.querySelector('#identity').value,webdriver:navigator.webdriver})}).catch(()=>{});}setInterval(report,100);report();</script></body></html>`, { headers: { "content-type": "text/html" } });
} });
const nativeOrigin = `http://127.0.0.1:${native.port}`;
const runtime = startRuntime({ dataDir: "/data", host: "0.0.0.0", port: 17841, chromiumExecutable,
  runtimeToken: Buffer.from("offline-viewer-data-token".repeat(4)), adminToken: Buffer.from("offline-viewer-admin-token".repeat(4)) });
const ensure = runtime.profiles.ensureProfileBrowser.bind(runtime.profiles);
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
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== "https://chatgpt.com") return route.abort();
          const cookiePresent = (await context.cookies(nativeOrigin)).some(cookie => cookie.name === "offline_account" && cookie.value === id);
          const authenticated = signedIn.has(id) && cookiePresent;
          if (authenticated) persisted.add(id);
          if (url.pathname === "/api/auth/session") return route.fulfill({ json: authenticated ? { expires: new Date(Date.now() + 3600000).toISOString(), user: { id: "offline-account" } } : {} });
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
const until = async (condition: () => boolean, label: string, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await Bun.sleep(50);
  assert(condition(), label);
};
let inspection: BrowserTurnLease | undefined;
try {
  await runtime.initialized;
  runtime.state.createProfile("ui-inspection");
  const inspector = await ensure("ui-inspection");
  inspection = await inspector.leaseTurn({ traceId: "provider-ui-inspection", modelIdentity: "offline-ui" });
  const page = inspection.page;
  await page.setViewportSize({ width: 1440, height: 1024 });
  const session = await page.request.post(`${gateway}/api/auth/login`, { data: { password: "Offline-Provider-UI-Fixture-20261004" } });
  assert.equal(session.status(), 200);
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
  const resumed = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/runtime/login/session") && r.request().method() === "GET");
  await page.getByRole("button", { name: "Open Browser", exact: true }).click();
  const resumedSession = await resumed; assert.equal(resumedSession.status(), 200);
  assert.equal(new URL(resumedSession.url()).searchParams.get("loginId"), loginLease.loginId);
  await waitViewer();
  // Premature verification must restore the human browser under the same lease.
  const premature = page.waitForResponse(r => r.url().endsWith("/runtime/login/complete") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish Sign In", exact: true }).click();
  assert((await premature).status() >= 400);
  await waitViewer();
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
  await page.getByRole("button", { name: "Actual Size", exact: true }).click();
  const clickNative = async (kind: "input" | "button") => {
    const target = geometry.get(id)!; const box = target[kind]; const rect = await canvas.boundingBox(); assert(rect);
    const size = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }));
    await page.mouse.click(rect.x + (target.x + box.x + box.width / 2) * rect.width / size.width, rect.y + (target.y + box.y + box.height / 2) * rect.height / size.height);
    await Bun.sleep(100);
  };
  await clickNative("input");
  await until(() => geometry.get(id)?.activeId === "identity" && geometry.get(id)?.focused === true, "Real desktop input did not receive keyboard focus");
  await page.keyboard.type("viewer-keyboard-proof");
  await until(() => geometry.get(id)?.value === "viewer-keyboard-proof", "Keyboard input did not reach native Chrome");
  mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: join(proof, "provider-embedded-login.png"), fullPage: true });
  await page.getByRole("button", { name: "Fit to Window", exact: true }).click();
  await clickNative("button");
  await until(() => signedIn.has(id), "Native human sign-in form did not accept input");
  assert.equal(runtime.profiles.ready(id), false, "Login completion requires explicit verification");
  const completed = page.waitForResponse(r => r.url().endsWith("/runtime/login/complete") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Finish Sign In", exact: true }).click();
  const finished = await completed;
  assert.equal(finished.status(), 200); assert.equal((await finished.json()).state, "completed");
  await until(() => runtime.profiles.ready(id), "Authenticated catalog probe did not settle", 60000);
  assert(persisted.has(id), "Native login cookie did not survive the same-profile verification restart");
  await canvas.waitFor({ state: "detached" });
  await page.getByText("Signed in. Connection is ready.", { exact: true }).waitFor();
  const models = await page.request.get(`${gateway}/api/providers/${connections[0].id}/models`); assert.equal(models.status(), 200);
  assert((await models.json()).models.some((row: { id: string }) => row.id.includes("gpt-5.6-sol")));
  assert.equal((await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/login/session?loginId=${loginLease.loginId}`)).status(), 404);
  const second = await page.request.post(`${gateway}/api/providers`, { data: { provider: "chatgpt-web", name: "Offline independent account" } }); assert.equal(second.status(), 201);
  const secondConnection = (await second.json()).connection; assert.notEqual(secondConnection.providerSpecificData.profileId, id); assert.equal(secondConnection.testStatus, "login_required");
  await page.screenshot({ path: join(proof, "provider-connected-ready.png"), fullPage: true });
  writeFileSync(join(proof, "result.json"), JSON.stringify({ gate: "provider-onboarding-ui", automaticProfile: true, providerConnectionPersisted: true, actualEmbeddedRfb: true, keyboardAndPointerForwarded: true, fullWindowWorkspace: true, actualSizeInput: true, sameLeaseResume: true, humanOnlyLogin: true, explicitLoginVerification: true, prematureVerificationRestored: true, persistedNativeCookie: true, readyAfterBrowserSignIn: true, liveCatalog: true, closedViewerRejected: true, distinctProfiles: true, loopbackOnlyVnc: true, liveChatGpt: false }));
  console.log("CGW_PROVIDER_ONBOARDING_SMOKE_OK");
} catch (error) {
  console.error("CGW_PROVIDER_ONBOARDING_SMOKE_FAILED", error);
  if (inspection) await inspection.page.screenshot({ path: join(proof, "provider-failed.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (inspection) await inspection.release();
  await runtime.close(); await native.stop();
}
