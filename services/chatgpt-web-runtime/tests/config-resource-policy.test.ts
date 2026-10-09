import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROFILE_SETTINGS,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  loadRuntimeResourceLimits,
  resolveProfileBrowserMode,
  type BrowserPurpose,
} from "../src/config";

describe("runtime resource policy", () => {
  test("defaults are conservative and independently copied", () => {
    const limits = loadRuntimeResourceLimits({});
    expect(limits).toEqual(DEFAULT_RUNTIME_RESOURCE_LIMITS);
    limits.maxGlobalBrowsers = 3;
    expect(DEFAULT_RUNTIME_RESOURCE_LIMITS.maxGlobalBrowsers).toBe(2);
  });

  test("strictly rejects malformed numeric and boolean configuration", () => {
    for (const value of ["", " 2", "2 ", "02", "2.0", "2e0", "-1", "NaN", "33"]) {
      expect(() => loadRuntimeResourceLimits({ CGW_MAX_GLOBAL_BROWSERS: value })).toThrow();
    }
    for (const value of ["", "1", "0", "TRUE", "False", " true"]) {
      expect(() => loadRuntimeResourceLimits({ CGW_ADAPTIVE_DOM_POLLING: value })).toThrow();
    }
    expect(() => loadRuntimeResourceLimits({ CGW_BROWSER_MODE: "headless" })).toThrow();
    expect(() => loadRuntimeResourceLimits({ CGW_MAX_GLOBAL_TABS: "4" })).toThrow();
    expect(() => loadRuntimeResourceLimits({ CGW_MAX_RETAINED_TABS_PER_PROFILE: "6" })).toThrow();
    expect(() => loadRuntimeResourceLimits({ CGW_QUEUE_TIMEOUT_MS: "999" })).toThrow();
  });

  test("accepts explicit zero queue and the bounded policy extrema", () => {
    expect(loadRuntimeResourceLimits({
      CGW_MAX_GLOBAL_BROWSERS: "32", CGW_MAX_GLOBAL_TURNS: "64", CGW_MAX_GLOBAL_TABS: "160",
      CGW_MAX_RETAINED_TABS_PER_PROFILE: "1", CGW_MAX_QUEUE_SIZE: "0",
      CGW_QUEUE_TIMEOUT_MS: "120000", CGW_BROWSER_IDLE_TTL_MS: "3600000",
      CGW_BROWSER_MODE: "headless-text", CGW_ADAPTIVE_DOM_POLLING: "true",
    })).toEqual({
      maxGlobalBrowsers: 32, maxGlobalTurns: 64, maxGlobalTabs: 160,
      maxRetainedTabsPerProfile: 1, maxQueueSize: 0, queueTimeoutMs: 120000,
      browserIdleTtlMs: 3600000, browserMode: "headless-text", adaptiveDomPolling: true,
    });
  });

  test("only browser-only inference and inspection can opt into headless", () => {
    const purposes: BrowserPurpose[] = ["inference", "inspection", "login", "viewer", "connector"];
    for (const purpose of purposes) {
      expect(resolveProfileBrowserMode(DEFAULT_PROFILE_SETTINGS, purpose, "headed")).toBe("headed");
      expect(resolveProfileBrowserMode({ ...DEFAULT_PROFILE_SETTINGS, mode: "full" }, purpose, "headless-text")).toBe("headed");
      expect(resolveProfileBrowserMode(DEFAULT_PROFILE_SETTINGS, purpose, "headless-text"))
        .toBe(purpose === "inference" || purpose === "inspection" ? "headless" : "headed");
    }
  });
});
