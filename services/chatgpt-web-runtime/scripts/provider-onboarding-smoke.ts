import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { startRuntime } from "../src/server";
import type { BrowserTurnLease } from "../src/browser/manager";

// Disposable Docker-only smoke. ChatGPT's network surface is intercepted; the
// provider API, profile state, desktop, VNC and dashboard all remain real.
const gateway = process.env.CGW_ONBOARDING_GATEWAY;
const proof = process.env.CGW_ONBOARDING_PROOF_DIR;
const chromiumExecutable = process.env.CGW_CHROMIUM_EXECUTABLE;
if (!gateway || !proof || !chromiumExecutable || process.platform !== "linux") throw new Error("Owned gateway, Chromium and proof directory required");
const runtime = startRuntime({ dataDir: "/data", host: "0.0.0.0", port: 17841,
  chromiumExecutable,
  runtimeToken: Buffer.from("offline-viewer-data-token".repeat(4)),
  adminToken: Buffer.from("offline-viewer-admin-token".repeat(4)) });
const prepared = new Set<string>();
const authenticated = new Set<string>();
const typed = new Map<string, string>();
const ensure = runtime.profiles.ensureProfileBrowser.bind(runtime.profiles);
const html = readFileSync(join(import.meta.dir, "../tests/fixtures/chatgpt-runtime.html"), "utf8");
const prepare = async (id: string) => {
  const manager = await ensure(id);
  if (!prepared.has(id)) {
    const context = await manager.ensureContext();
    await context.exposeBinding("offlineSignIn", (_source, input: string) => {
      typed.set(id, input);
      if (input === "viewer-keyboard-proof") authenticated.add(id);
      return authenticated.has(id);
    });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://chatgpt.com") return route.abort();
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: authenticated.has(id)
        ? { expires: new Date(Date.now() + 3600000).toISOString(), user: { id: "offline-account" } }
        : {} });
      return route.fulfill({ contentType: "text/html", body: authenticated.has(id) ? html
        : `<!doctype html><html><body style="font:24px sans-serif;background:#eef6ff;padding:50px"><h1>Offline ChatGPT sign-in</h1><label for="identity">Fixture identity</label><input id="identity" style="display:block;margin:20px 0;font:24px sans-serif;width:400px"><button id="signin" style="font:24px sans-serif;padding:16px">Sign in to fixture</button><p id="status">Waiting for keyboard and pointer input</p><script>document.querySelector('#signin').onclick=async()=>{const ok=await window.offlineSignIn(document.querySelector('#identity').value);if(ok)location.reload();else document.querySelector('#status').textContent='Enter the fixture identity';};</script></body></html>` });
    });
    prepared.add(id);
  }
  return manager;
};
const viewer = runtime.profiles.startViewer.bind(runtime.profiles);
runtime.profiles.startViewer = async (id, login, trace) => { await prepare(id); return viewer(id, login, trace); };
let inspection: BrowserTurnLease | undefined;
try {
  await runtime.initialized;
  runtime.state.createProfile("ui-inspection");
  const manager = await ensure("ui-inspection");
  inspection = await manager.leaseTurn({ traceId: "provider-ui-inspection", modelIdentity: "offline-ui" });
  const page = inspection.page;
  const session = await page.request.post(`${gateway}/api/auth/login`, { data: { password: "Offline-Provider-UI-Fixture-20261004" } });
  assert.equal(session.status(), 200);
  await page.goto(`${gateway}/dashboard/providers/chatgpt-web`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Add Connection/ }).click();
  const name = page.getByRole("textbox", { name: "Connection name", exact: true });
  await name.fill("Offline integrated account");
  assert.equal(await page.getByPlaceholder("personal", { exact: true }).count(), 0);
  const opening = page.waitForResponse(response => response.url().endsWith("/api/providers/chatgpt-web/runtime/login/start") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Add Connection and Sign In", exact: true }).click();
  const opened = await opening;
  assert.equal(opened.status(), 200);
  const loginLease = await opened.json();
  await page.locator("canvas").waitFor({ timeout: 90000 });
  await page.getByText(/Connected.*browser|Browser.*connected|Private browser connected/i).waitFor({ timeout: 30000 });
  const response = await page.request.get(`${gateway}/api/providers`);
  assert.equal(response.status(), 200);
  const connections = (await response.json()).connections.filter((row: { provider: string }) => row.provider === "chatgpt-web");
  assert.equal(connections.length, 1);
  const id = connections[0].providerSpecificData.profileId;
  assert.match(id, /^cgw-[a-f0-9-]+$/);
  assert.equal(connections[0].testStatus, "login_required");
  assert.equal(loginLease.profileId, id);
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.locator("canvas").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "View Browser", exact: true }).click();
  await page.locator("canvas").waitFor({ timeout: 30000 });
  await page.getByText(/Connected.*browser/i).waitFor({ timeout: 30000 });
  const resumed = await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/login/session?loginId=${loginLease.loginId}`);
  assert.equal(resumed.status(), 200);
  const resumedLease = await resumed.json();
  assert.equal(resumedLease.loginId, loginLease.loginId);
  assert.equal(resumedLease.profileId, id);
  const privateAddress = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === "IPv4")?.address;
  assert(privateAddress, "Owned Docker network address required");
  const exposed = await new Promise<boolean>(resolve => {
    const socket = connect({ host: privateAddress, port: 5900 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
  assert.equal(exposed, false, "Private VNC must refuse nonloopback connections");
  const account = runtime.profiles.manager(id);
  const accountPage = await account.maintenancePage();
  // Fullscreen removes Openbox/Chrome decorations from fixture coordinates; real
  // input still travels through the dashboard canvas, RFB and the owned desktop.
  const desktop = await accountPage.context().newCDPSession(accountPage);
  const { windowId } = await desktop.send("Browser.getWindowForTarget");
  await desktop.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await desktop.detach();
  await accountPage.waitForFunction(() => window.outerHeight === window.innerHeight, undefined, { timeout: 5000 });
  const input = await accountPage.locator("#identity").boundingBox();
  const button = await accountPage.locator("#signin").boundingBox();
  assert(input && button);
  const frame = await accountPage.evaluate(() => ({ x: window.screenX, y: window.screenY + window.outerHeight - window.innerHeight }));
  const canvas = page.locator("canvas");
  const size = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height }));
  console.log(JSON.stringify({ gate: "viewer-pointer-target", frame, framebuffer: size, input }));
  const clickDesktop = async (box: { x: number; y: number; width: number; height: number }) => {
    const bounds = await canvas.boundingBox(); assert(bounds);
    await page.mouse.click(bounds.x + (frame.x + box.x + box.width / 2) * bounds.width / size.width,
      bounds.y + (frame.y + box.y + box.height / 2) * bounds.height / size.height);
  };
  await clickDesktop(input);
  await accountPage.waitForFunction(() => document.hasFocus() && document.activeElement?.id === "identity", undefined, { timeout: 5000 });
  await page.keyboard.type("viewer-keyboard-proof");
  await accountPage.waitForFunction(() => document.querySelector<HTMLInputElement>("#identity")?.value === "viewer-keyboard-proof", undefined, { timeout: 5000 });
  assert.equal(await accountPage.locator("#identity").inputValue(), "viewer-keyboard-proof");
  mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: join(proof, "provider-embedded-login.png"), fullPage: true });
  await clickDesktop(button);
  await page.getByText("Login completed. Browser verification is ready.", { exact: true }).waitFor({ timeout: 60000 });
  const until = Date.now() + 60000;
  while (!runtime.profiles.ready(id) && Date.now() < until) await Bun.sleep(200);
  assert(runtime.profiles.ready(id), "Actual browser authentication and catalog probe did not settle");
  assert.equal(typed.get(id), "viewer-keyboard-proof");
  const models = await page.request.get(`${gateway}/api/providers/${connections[0].id}/models`);
  assert.equal(models.status(), 200);
  const catalog = await models.json();
  assert(catalog.models.some((row: { id: string }) => row.id.includes("gpt-5.6-sol")));
  const runtimeSession = await page.request.get(`${gateway}/api/providers/chatgpt-web/runtime/login/session?loginId=${loginLease.loginId}`);
  assert.equal(runtimeSession.status(), 404);
  const second = await page.request.post(`${gateway}/api/providers`, { data: { provider: "chatgpt-web", name: "Offline independent account" } });
  assert.equal(second.status(), 201);
  const secondConnection = (await second.json()).connection;
  assert.notEqual(secondConnection.providerSpecificData.profileId, id);
  assert.equal(secondConnection.testStatus, "login_required");
  await page.screenshot({ path: join(proof, "provider-connected-ready.png"), fullPage: true });
  writeFileSync(join(proof, "result.json"), JSON.stringify({ gate: "provider-onboarding-ui", automaticProfile: true,
    providerConnectionPersisted: true, actualEmbeddedRfb: true, keyboardAndPointerForwarded: true,
    readyAfterBrowserSignIn: true, liveCatalog: true, closedViewerRejected: true, sameLeaseResume: true, distinctProfiles: true, loopbackOnlyVnc: true, liveChatGpt: false }));
  console.log("CGW_PROVIDER_ONBOARDING_SMOKE_OK");
} catch (error) {
  console.error("CGW_PROVIDER_ONBOARDING_SMOKE_FAILED", error);
  if (inspection) await inspection.page.screenshot({ path: join(proof, "provider-failed.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (inspection) await inspection.release();
  await runtime.close();
}
