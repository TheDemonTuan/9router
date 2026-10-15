import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
const cliRequire = createRequire(new URL("../../cli/package.json", import.meta.url));
const installed = cliRequire.resolve("bun/package.json");
const binary = path.resolve(path.dirname(installed), JSON.parse(fs.readFileSync(installed)).bin.bun);
let root, hooks, pkg, source, data;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-bun-"));
  hooks = path.join(root, "hooks"); pkg = path.join(root, "node_modules", "bun"); data = path.join(root, "data");
  fs.mkdirSync(hooks); fs.mkdirSync(pkg, { recursive: true });
  for (const file of ["runtime.js", "bunRuntime.js", "appRuntime.js"]) fs.copyFileSync(new URL(`../../cli/hooks/${file}`, import.meta.url), path.join(hooks, file));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "1.4.3", bin: { bun: "bun.exe" } }));
  source = path.join(pkg, "bun.exe");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const env = () => ({ ...process.env, DATA_DIR: data });
const script = 'console.log(require("./hooks/bunRuntime").ensureBunRuntime())';
function run() { return execFileSync("node", ["-e", script], { cwd: root, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function realBinary() { fs.copyFileSync(binary, source); }

it("fails closed when package binary is missing or a lifecycle placeholder", () => {
  expect(run).toThrow(/Bun 1.4.3 runtime unavailable/);
  fs.writeFileSync(source, "lifecycle scripts were disabled");
  expect(run).toThrow(/Bun 1.4.3 runtime unavailable/);
});
it("rejects an unexpected dependency version", () => {
  realBinary();
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "1.4.2", bin: { bun: "bun.exe" } }));
  expect(run).toThrow(/wrong version/);
});
it("uses an immutable cache and rejects corruption without repairing over it", () => {
  realBinary(); const cached = run();
  expect(cached.startsWith(data)).toBe(true);
  expect(execFileSync(cached, ["--version"], { encoding: "utf8" }).trim()).toBe("1.4.3");
  expect(run()).toBe(cached);
  fs.writeFileSync(cached, "corrupt");
  expect(run).toThrow(/checksum mismatch/);
  expect(fs.readFileSync(cached, "utf8")).toBe("corrupt");
});
it("publishes the same verified winner under concurrent preparation", async () => {
  realBinary();
  const prepare = () => new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", script], { cwd: root, env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(Error(stderr)));
  });
  const paths = await Promise.all([prepare(), prepare(), prepare()]);
  expect(new Set(paths).size).toBe(1);
  expect(execFileSync(paths[0], ["--version"], { encoding: "utf8" }).trim()).toBe("1.4.3");
});
it("rejects a cache symlink even if it targets the valid binary", ({ skip }) => {
  realBinary(); const cached = run(); fs.unlinkSync(cached);
  try { fs.symlinkSync(source, cached); } catch (error) {
    if (error.code === "EPERM") { skip("File symlinks require OS permission"); return; }
    throw error;
  }
  expect(run).toThrow(/Not a regular file/);
});

it("retains the running build across package replacement and rejects incomplete snapshots", () => {
  const app = path.join(root, "app");
  const dist = path.join(app, ".next-cli-build");
  fs.mkdirSync(dist, { recursive: true });
  for (const name of ["server.js", "custom-server.js", "chatgpt-web-viewer-proxy.cjs"]) fs.writeFileSync(path.join(app, name), "old-build");
  fs.writeFileSync(path.join(dist, "BUILD_ID"), "old-build");
  const snapshot = () => execFileSync("node", ["-e", 'console.log(require("./hooks/appRuntime").ensureAppRuntime())'], { cwd: root, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const old = snapshot();
  fs.writeFileSync(path.join(app, "server.js"), "new-build");
  fs.writeFileSync(path.join(dist, "BUILD_ID"), "new-build");
  const current = snapshot();
  expect(current).not.toBe(old);
  expect(fs.readFileSync(path.join(old, "server.js"), "utf8")).toBe("old-build");
  expect(fs.readFileSync(path.join(current, "server.js"), "utf8")).toBe("new-build");
  fs.unlinkSync(path.join(current, ".9router-ready"));
  expect(snapshot).toThrow();
});
