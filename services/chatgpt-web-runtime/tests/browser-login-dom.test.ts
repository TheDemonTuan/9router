import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chromium, type Page } from "playwright-core";
import { probeBrowserLoginSession } from "../src/browser-login";
import { activateChatGptEffortMenu, detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { assertChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeProfiles } from "../src/profiles";
import { RuntimeState } from "../src/runtime-state";
import type { BrowserManager } from "../src/browser/manager";
const executablePath = process.env.CGW_CHROMIUM_EXECUTABLE;
const html = await Bun.file(new URL("./fixtures/chatgpt-runtime.html", import.meta.url)).text();
const salt = new TextEncoder().encode("synthetic-login-salt");
const capabilities = { solAvailable: true, extraHighAvailable: false, proAvailable: false };
const validSession = { user: { id: "synthetic-account" }, expires: new Date(Date.now() + 3600_000).toISOString() };
type FixtureOptions = { composerDelayMs?: number; pointerOnly?: boolean; semanticSlider?: boolean; headerOnlyModel?: boolean };
async function fixture(options: FixtureOptions, run: (page: Page) => Promise<void>, session: unknown = validSession) {
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const context = await browser.newContext();
  try {
    await context.addInitScript(config => { Object.assign(window, { __cgwLoginFixture: config }); }, options);
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === "https://chatgpt.com" && url.pathname === "/api/auth/session") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(session) });
      } else if (url.origin === "https://chatgpt.com" && url.pathname === "/" && route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body: html });
      } else await route.abort();
    });
    const page = await context.newPage();
    await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded" });
    await run(page);
    expect(await page.evaluate(() => {
      const state: unknown = Reflect.get(window, "fixture");
      if (!state || typeof state !== "object" || !("sends" in state)) throw new Error("Missing synthetic submit counter");
      return state.sends;
    })).toBe(0);
  } finally { await context.close(); await browser.close(); }
}
async function menu(page: Page) {
  return activateChatGptEffortMenu(page, page.locator("button[aria-haspopup]"));
}
async function high(page: Page) {
  const surface = await menu(page);
  const owner = surface.slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
  await owner.press("ArrowRight"); await owner.press("ArrowRight");
  return surface;
}

describe.skipIf(!executablePath)("Chromium login DOM", () => {
  test("startup isolates a real authenticated UI failure and keeps the other catalog ready", async () => {
    await fixture({}, async page => {
      const root = mkdtempSync(join(tmpdir(), "cgw-startup-dom-"));
      const state = new RuntimeState(root);
      const profiles = new RuntimeProfiles({ dataDir: root, host: "127.0.0.1", port: 0,
        chromiumExecutable: executablePath!, runtimeToken: Buffer.from("fixture-runtime"), adminToken: Buffer.from("fixture-admin") }, state);
      const display = spyOn(profiles as unknown as { ensureDisplay(id: string): Promise<void> }, "ensureDisplay").mockResolvedValue();
      const diagnostics = spyOn(console, "error").mockImplementation(() => {});
      const spies: { mockRestore(): void }[] = [];
      const originalProbe = profiles.probe.bind(profiles);
      try {
        for (const id of ["broken", "healthy"]) {
          const original = state.createProfile(id);
          state.observeAccount(id, createHmac("sha256", state.accountSalt).update("synthetic-account").digest("hex"), original.revision);
          const manager = profiles.manager(id);
          spies.push(spyOn(manager, "ensureContext").mockResolvedValue(page.context()));
          spies.push(spyOn(manager, "maintenancePage").mockResolvedValue(page));
        }
        spies.push(spyOn(profiles, "probe").mockImplementation(async (id, _navigate, initializing) => {
          if (id === "broken") await page.evaluate(() => {
            const clone = document.querySelector("form")!.cloneNode(true) as HTMLElement;
            clone.id = "ambiguous-fixture"; document.body.append(clone);
          });
          else await page.locator("#ambiguous-fixture").evaluate(element => element.remove());
          return originalProbe(id, false, initializing);
        }));
        await profiles.initialize();
        expect(profiles.status("broken")).toMatchObject({ state: "error", lastError: "profile_probe_failed", models: [] });
        expect(profiles.ready("healthy")).toBe(true);
        expect(profiles.catalog("healthy")).toMatchObject({ profile_id: "healthy" });
        const event = JSON.parse(String(diagnostics.mock.calls[0]![0]));
        expect(event).toMatchObject({ event: "cgw_profile_probe_failed", profileId: "broken", stage: "composer", code: "profile_probe_failed" });
      } finally {
        for (const spy of spies) spy.mockRestore();
        diagnostics.mockRestore(); display.mockRestore(); await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true });
      }
    });
  }, 90_000);

  test("navigation failure is typed and diagnostics never emit secret causes", async () => {
    await fixture({}, async page => {
      const root = mkdtempSync(join(tmpdir(), "cgw-navigation-dom-"));
      const state = new RuntimeState(root);
      const profiles = new RuntimeProfiles({ dataDir: root, host: "127.0.0.1", port: 0,
        chromiumExecutable: executablePath!, runtimeToken: Buffer.from("fixture-runtime"), adminToken: Buffer.from("fixture-admin") }, state);
      const display = spyOn(profiles as unknown as { ensureDisplay(id: string): Promise<void> }, "ensureDisplay").mockResolvedValue();
      const diagnostics = spyOn(console, "error").mockImplementation(() => {});
      const marker = "fixture-SECRET-session-cookie-identity";
      const navigation = spyOn(page, "goto").mockRejectedValue(Object.assign(new Error(marker, { cause: { session: marker } }), { name: "TimeoutError" }));
      state.createProfile("synthetic");
      const manager = profiles.manager("synthetic");
      const maintenancePage = spyOn(manager, "maintenancePage").mockResolvedValue(page);
      try {
        await expect(profiles.probe("synthetic")).rejects.toMatchObject({ code: "profile_probe_failed", status: 502, retryable: false });
        expect(profiles.ready("synthetic")).toBe(false);
        expect(state.profile("synthetic").revision).toBe(1);
        const serialized = JSON.stringify(diagnostics.mock.calls);
        expect(serialized).not.toContain(marker);
        expect(JSON.parse(String(diagnostics.mock.calls[0]![0]))).toMatchObject({ stage: "navigation", errorName: "ChatGptWebAdapterError", code: "profile_probe_failed" });
        expect(Object.keys(JSON.parse(String(diagnostics.mock.calls[0]![0]))).sort()).toEqual(["code", "elapsedMs", "errorName", "event", "profileId", "stage"]);
      } finally { maintenancePage.mockRestore(); navigation.mockRestore(); diagnostics.mockRestore(); display.mockRestore(); await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }, 90_000);
  test("production profile probe verifies Instant and High through semantic keyboard owner", async () => {
    await fixture({ composerDelayMs: 500, pointerOnly: true, semanticSlider: true, headerOnlyModel: true }, async page => {
      const root = mkdtempSync(join(tmpdir(), "cgw-catalog-dom-"));
      const state = new RuntimeState(root);
      const profiles = new RuntimeProfiles({ dataDir: root, host: "127.0.0.1", port: 0,
        chromiumExecutable: executablePath!, runtimeToken: Buffer.from("fixture-runtime"), adminToken: Buffer.from("fixture-admin") }, state);
      // Only display/process ownership is substituted; production probe reads real Chromium DOM.
      const display = spyOn(profiles as unknown as { ensureDisplay(id: string): Promise<void> }, "ensureDisplay").mockResolvedValue();
      const manager = {
        maintenance: async (_label: string, run: () => Promise<unknown>) => run(),
        maintenancePage: async () => page,
      } as unknown as BrowserManager;
      try {
        const profile = state.createProfile("synthetic");
        state.observeAccount("synthetic", createHmac("sha256", state.accountSalt).update("synthetic-account").digest("hex"), profile.revision);
        const result = await profiles.probe("synthetic", false, false, manager);
        expect(result.models.find(model => model.id === "chatgpt-web/gpt-5.6-sol-instant")).toMatchObject({ default_reasoning_level: "low" });
        expect(result.models.find(model => model.id === "chatgpt-web/gpt-5.6-sol")).toMatchObject({ supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high" });
        expect(profiles.ready("synthetic")).toBe(true);
      } finally { display.mockRestore(); state.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }, 90_000);
  test("delayed composer preserves session fingerprint without sending", async () => {
    await fixture({ composerDelayMs: 500 }, async page => {
      const stages: string[] = [];
      const result = await probeBrowserLoginSession(page, salt, false, stage => { stages.push(stage); });
      expect(result.accountFingerprint).toBe(createHmac("sha256", salt).update("synthetic-account").digest("hex"));
      expect(result.capabilities).toEqual(capabilities);
      expect(stages).toEqual(["session", "composer", "surface", "capabilities"]);
    });
  }, 90_000);
  for (const pointerOnly of [false, true]) {
    test(`capability activation supports ${pointerOnly ? "primary pointerdown without Enter" : "legacy click"}`, async () => {
      await fixture({ pointerOnly, semanticSlider: true }, async page => {
        if (pointerOnly) {
          await page.locator("button[aria-haspopup]").press("Enter");
          expect(await page.locator("#picker").isVisible()).toBe(false);
        }
        expect(await detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 1000, stableAbsenceMs: 100 })).toEqual(capabilities);
        expect(await page.locator("#picker").isVisible()).toBe(false);
      });
    }, 90_000);
  }
  test("semantic slider keyboard owner selects High and verifies header-only family", async () => {
    await fixture({ pointerOnly: true, semanticSlider: true, headerOnlyModel: true }, async page => {
      const surface = await high(page);
      expect(await surface.slider.isVisible()).toBe(false);
      expect(await surface.slider.getAttribute("aria-valuenow")).toBe("2");
      await assertChatGptModelFamily(surface, "5.6", "high", 2);
    });
  }, 90_000);
  test("legacy ARIA family remains supported", async () => {
    await fixture({}, async page => { await assertChatGptModelFamily(await high(page), "5.6", "high", 2); });
  }, 90_000);
  test("Latest Pro needs visible version 6 header", async () => {
    await fixture({ headerOnlyModel: true }, async page => {
      const surface = await menu(page);
      await page.evaluate(() => {
        const slider = document.querySelector('[role="slider"]')!;
        slider.setAttribute("aria-valuemax", "4"); slider.setAttribute("aria-valuenow", "4");
        document.querySelector('[role="menuitemradio"]')!.textContent = "Latest";
        document.querySelector("#announcement")!.textContent = "Pro, 5 of 5";
        document.querySelector("[data-menu-row-content]")!.replaceChildren(document.createTextNode("6"), document.createTextNode(" Pro"));
      });
      await assertChatGptModelFamily(surface, "6", "max", 4);
    });
  }, 90_000);
  for (const variant of ["future", "hidden", "inert", "duplicate", "conflict", "other-menu"]) {
    test(`model evidence rejects ${variant} header`, async () => {
      await fixture({ headerOnlyModel: true }, async page => {
        const surface = await high(page);
        await page.evaluate(variant => {
          const header = document.querySelector("[data-model-picker-view-toggle]") as HTMLElement;
          if (variant === "future") header.textContent = "7 Sol High";
          if (variant === "hidden") header.hidden = true;
          if (variant === "inert") header.inert = true;
          if (variant === "duplicate") header.after(header.cloneNode(true));
          if (variant === "conflict") { header.textContent = "6 Pro"; document.querySelector("#announcement")!.textContent = "5.6 Sol High, 3 of 3"; }
          if (variant === "other-menu") { const other = document.createElement("div"); other.setAttribute("role", "menu"); header.replaceWith(other); other.append(header); }
        }, variant);
        await expect(assertChatGptModelFamily(surface, "5.6", "high", 2)).rejects.toThrow();
      });
    }, 90_000);
  }
  for (const session of [{}, { user: { id: "synthetic-account" }, expires: "2000-01-01T00:00:00Z" }]) {
    test(`invalid session ${JSON.stringify(session)} is login_required`, async () => {
      await fixture({}, async page => { await expect(probeBrowserLoginSession(page, salt, false)).rejects.toMatchObject({ code: "login_required" }); }, session);
    }, 90_000);
  }
  test("ambiguous composers fail with typed UI diagnostic", async () => {
    await fixture({}, async page => {
      await page.evaluate(() => document.querySelector("form")!.after(document.querySelector("form")!.cloneNode(true)));
      await expect(probeBrowserLoginSession(page, salt, false)).rejects.toMatchObject({ code: "profile_probe_failed", status: 502 });
    });
  }, 90_000);
  for (const variant of ["aria", "ticks"]) {
    test(`invalid ${variant} fails closed without caching capabilities`, async () => {
      await fixture({}, async page => {
        await menu(page);
        await page.evaluate(variant => {
          if (variant === "aria") document.querySelector('[role="slider"]')!.setAttribute("aria-valuenow", "NaN");
          else document.querySelector("[data-selected]")!.remove();
        }, variant);
        await expect(detectChatGptAccountCapabilities(page, { selectorTimeoutMs: 1000, stableAbsenceMs: 100 })).rejects.toThrow();
        expect(await page.locator("#picker").isVisible()).toBe(false);
      });
    }, 90_000);
  }
  test("absent composer has bounded typed verification failure", async () => {
    await fixture({}, async page => {
      await page.locator("form").evaluate(form => form.remove());
      const start = Date.now();
      await expect(probeBrowserLoginSession(page, salt, false)).rejects.toMatchObject({ code: "profile_probe_failed", status: 502 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(29_000);
      expect(Date.now() - start).toBeLessThan(35_000);
    });
  }, 45_000);
});
