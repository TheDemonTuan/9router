import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(() => { throw new Error("not found"); }),
  execFile: vi.fn(() => ({ toString: () => "[object Object]" })),
  execFileSync: vi.fn(() => Buffer.from(JSON.stringify([
    { name: "headroom-ai", version: "0.26.0" },
    { name: "tree-sitter", version: "0.25.0" },
  ]))),
}));

vi.mock("child_process", () => ({
  execSync: mocks.execSync,
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

import { findPython310, getHeadroomStatus, getInstalledHeadroomExtras, isLoopbackHeadroomUrl } from "../../src/lib/headroom/detect.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("headroom detect", () => {
  it("detects installed headroom version and extras from pip list", () => {
    const result = getInstalledHeadroomExtras("python3");

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "python3",
      ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
      expect.objectContaining({ windowsHide: true, timeout: 8000 }),
    );
    expect(result).toEqual({
      installed: true,
      version: "0.26.0",
      extras: { code: true, ml: false },
    });
  });

  it("prefers the interpreter that actually has headroom-ai installed", () => {
    // headroom binary lives in a bin dir; the python next to it has headroom-ai.
    const windows = process.platform === "win32";
    const binPython = windows ? "C:\\opt\\hr\\bin\\python.exe" : "/opt/hr/bin/python3";
    mocks.execSync.mockImplementation((cmd) => {
      if (String(cmd).includes("where") || String(cmd).includes("which")) return Buffer.from(windows ? "C:\\opt\\hr\\bin\\headroom.exe\n" : "/opt/hr/bin/headroom\n");
      if (String(cmd).includes("--version")) return Buffer.from("Python 3.13.0\n");
      throw new Error("unexpected execSync");
    });
    mocks.execFileSync.mockImplementation((py, args) => {
      if (args.join(" ") === "-m pip show headroom-ai") {
        if (py === binPython) return Buffer.from("Name: headroom-ai\nVersion: 0.26.0\n");
        throw new Error(`not installed in ${py}`);
      }
      throw new Error(`unexpected execFileSync: ${py} ${args.join(" ")}`);
    });

    expect(findPython310()).toBe(binPython);
  });

  it("keeps top-level installed flag true when extras are readable", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    mocks.execSync.mockImplementation((cmd) => {
      if (String(cmd).includes("where") || String(cmd).includes("which")) return Buffer.from("C:/Python/Scripts/headroom.exe\n");
      if (String(cmd).includes("python3 --version")) return Buffer.from("Python 3.13.0\n");
      if (String(cmd).includes("python --version")) return Buffer.from("Python 3.13.0\n");
      throw new Error("unexpected execSync");
    });
    mocks.execFileSync.mockImplementation((py, args) => {
      if (py === "python3" && args.join(" ") === "-m pip show headroom-ai") throw new Error("not installed in python3");
      if (py === "python" && args.join(" ") === "-m pip show headroom-ai") return Buffer.from("Name: headroom-ai\nVersion: 0.26.0\n");
      if (py === "python" && args.join(" ").startsWith("-m pip list ")) return Buffer.from(JSON.stringify([
        { name: "headroom-ai", version: "0.26.0" },
        { name: "tree-sitter", version: "0.25.0" },
      ]));
      throw new Error(`unexpected execFileSync: ${py} ${args.join(" ")}`);
    });

    const status = await getHeadroomStatus("http://localhost:8787");

    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.26.0");
    expect(status.extras).toEqual({ code: true, ml: false });
  });

  it("treats a reachable external proxy as running without local CLI", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    mocks.execSync.mockImplementation((cmd) => {
      if (String(cmd).includes("where") || String(cmd).includes("which")) throw new Error("not found");
      throw new Error("unexpected execSync");
    });
    mocks.execFileSync.mockImplementation(() => { throw new Error("pip unavailable"); });

    const status = await getHeadroomStatus("http://headroom:8787");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(true);
    expect(status.localUrl).toBe(false);
    expect(status.canStart).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/health", expect.any(Object));
  });

  it("recognizes loopback URLs for managed local mode", () => {
    expect(isLoopbackHeadroomUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://headroom:8787")).toBe(false);
    expect(isLoopbackHeadroomUrl("not-a-url")).toBe(false);
  });

  it("extracts compression executor metrics from /health response", async () => {
    const healthPayload = {
      version: "0.38.0",
      runtime: {
        compression_executor: {
          max_workers: 1,
          queued: 0,
          queued_max: 3,
          queue_timeouts_total: 0,
          queue_wait_seconds_total: 0.12,
          queue_wait_seconds_max: 0.084,
          running: 1,
          in_flight: 1,
          in_flight_max: 1,
          run_seconds_total: 1.25,
          run_seconds_max: 0.62,
          leaked_threads_total: 0,
          quarantine_active: false,
          timed_out_workers: 0,
          timed_out_workers_max: 0,
          quarantine_activations_total: 0,
          quarantine_skips_total: 0,
        },
      },
    };
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith("/health")) return new Response(JSON.stringify(healthPayload), { status: 200 });
      return new Response("ok", { status: 200 });
    });
    mocks.execSync.mockImplementation(() => { throw new Error("not found"); });
    mocks.execFileSync.mockImplementation(() => { throw new Error("pip unavailable"); });

    const status = await getHeadroomStatus("http://headroom-metrics-test:8787");
    expect(status.compressionExecutor).toBeDefined();
    expect(status.compressionExecutor.max_workers).toBe(1);
    expect(status.compressionExecutor.queued_max).toBe(3);
    expect(status.compressionExecutor.run_seconds_max).toBe(0.62);
    expect(status.compressionExecutor.quarantine_active).toBe(false);
  });
});
