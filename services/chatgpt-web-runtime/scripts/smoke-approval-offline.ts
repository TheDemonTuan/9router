import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatGptToolConfirmation } from "../src/adapters/chatgpt-web/browser-worker";
const executable = process.env.CGW_CHROMIUM_EXECUTABLE;
if (!executable) throw new Error("CGW_CHROMIUM_EXECUTABLE required for actual approval DOM smoke");
const root = mkdtempSync(join(tmpdir(), "cgw-approval-dom-"));
const context = await chromium.launchPersistentContext(root, { executablePath: executable, headless: true, chromiumSandbox: true });
const page = context.pages()[0]!;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const render = async (connector = "Codex Native2", once = true) => {
  await page.setContent(`<div role="dialog">Allow ChatGPT to use ${connector}?${once ? '<button id="once">Allow once</button>' : ''}<button id="always">Allow always</button></div><script>window.onceClicks=0;window.alwaysClicks=0;document.querySelector('#once')?.addEventListener('click',()=>{window.onceClicks++;document.querySelector('[role=dialog]').remove();});document.querySelector('#always').onclick=()=>window.alwaysClicks++;</script>`);
};
try {
  await render(); let diagnostic = "";
  const pending = resolveChatGptToolConfirmation(page, "Codex Native2", false, undefined, 5000, instance => { diagnostic = instance; });
  await page.waitForFunction(() => document.querySelector("#once") !== null);
  assert(await page.evaluate(() => Reflect.get(window, "onceClicks")) === 0, "Default false automatically approved a prompt");
  await page.locator("#once").click(); assert(await pending === true && diagnostic.startsWith("approval_"), "Manual Allow once did not continue the exact prompt");
  await render(); assert(await resolveChatGptToolConfirmation(page, "Codex Native2", true) === true, "Opt-in Allow once failed");
  assert(await page.evaluate(() => Reflect.get(window, "onceClicks")) === 1 && await page.evaluate(() => Reflect.get(window, "alwaysClicks")) === 0, "Opt-in granted permanent approval");
  await render("Other connector"); assert(await resolveChatGptToolConfirmation(page, "Codex Native2", true) === false, "Unrelated connector approved");
  await render(); let terminal: unknown;
  try { await resolveChatGptToolConfirmation(page, "Codex Native2", false, undefined, 50); } catch (error) { terminal = error; }
  assert(terminal && typeof terminal === "object" && "code" in terminal && terminal.code === "waiting_for_chatgpt_tool_approval", "Manual approval timeout silently hung or changed terminal code");
  assert(await page.evaluate(() => Reflect.get(window, "alwaysClicks")) === 0, "Permanent approval clicked");
  console.info(JSON.stringify({ gate: "offline-approval-dom", actualChromium: true, defaultFalseNoClick: true, manualOnceContinues: true, optInOnlyOnce: true, unrelatedConnectorDenied: true, timeoutTerminal: "waiting_for_chatgpt_tool_approval", liveChatGpt: false }));
} finally { await context.close(); rmSync(root, { recursive: true, force: true }); }
