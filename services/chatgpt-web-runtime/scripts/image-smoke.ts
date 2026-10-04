import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";

// Run INSIDE the built image under the same cap/seccomp/no-new-privileges policy as staging.
// This is a native Chromium/packaging gate, not live ChatGPT or outer Codex tool E2E.
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--arch" && ["amd64", "arm64"].includes(args[1]!),
  "Usage: bun scripts/image-smoke.ts --arch amd64|arm64");
const arch = args[1] as "amd64" | "arm64";
assert.equal(process.platform, "linux", "Native Linux required");
assert.equal(process.arch, arch === "amd64" ? "x64" : "arm64", "Native process architecture mismatch");
assert.equal(process.getuid?.(), 10001, "Runtime must not run as root");
assert.equal(process.getgid?.(), 10001, "Runtime group mismatch");
assert.equal(Bun.version, "1.4.0", "Bun baseline changed");
assert.equal(readFileSync("/proc/1/comm", "utf8").trim(), "tini", "Tini must own PID 1");
assert.match(readFileSync("/etc/os-release", "utf8"), /VERSION_ID="13"/, "Debian 13 required");
const processStatus = readFileSync("/proc/self/status", "utf8");
assert.match(processStatus, /^NoNewPrivs:\s+1$/m, "Docker no-new-privileges required");
assert.match(processStatus, /^CapEff:\s+0+$/m, "Docker cap_drop ALL required");
assert.match(processStatus, /^Seccomp:\s+2$/m, "Docker seccomp filter required");
const hostCpu = readFileSync("/proc/cpuinfo", "utf8");
assert.match(hostCpu, arch === "amd64" ? /^cpu family\s*:/m : /^CPU architecture\s*:\s*8$/m,
  "Host CPU does not match native image architecture; emulation is not accepted");
const manifest = JSON.parse(readFileSync(new URL("../image-build-manifest.json", import.meta.url), "utf8"));
const build = manifest.tunnel.sourceBuild;
const proof = JSON.parse(readFileSync(build.provenanceFile, "utf8"));
assert.equal(proof.schemaVersion, 1);
assert.equal(proof.architecture, `linux/${arch}`);
assert.equal(proof.nativeBuild, true);
assert.equal(proof.flavor, "full");
assert.equal(proof.cgoEnabled, false);
assert.match(proof.appRevision, /^[a-f0-9]{40}$/);
assert.equal(proof.inputLockSha256, build.inputLockSha256);
assert.equal(proof.buildHelperSha256, build.buildHelperSha256);
assert.equal(proof.tunnelRevision, manifest.tunnel.revision);
assert.equal(proof.cloudflaredRevision, manifest.tunnel.cloudflared.release_commit);
assert.equal(proof.goVersion, manifest.buildToolchain.version);
assert.equal(proof.goArchiveSha256, manifest.buildToolchain.platforms[arch].sha256);
assert.deepEqual(proof.sourceArchives, build.sourceArchives);
assert.deepEqual(proof.dependencyVersions, build.dependencyVersions);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
for (const name of ["bun", "tunnel-client", "cloudflared"]) {
  const bytes = readFileSync(`/usr/local/bin/${name}`);
  assert.equal(bytes.subarray(0, 6).toString("hex"), "7f454c460201", `${name}: ELF64 little-endian required`);
  assert.equal(bytes.readUInt16LE(18), arch === "amd64" ? 62 : 183, `${name}: wrong ELF machine`);
  assert.equal(hash(bytes), name === "bun" ? manifest.bun.platforms[arch].binarySha256
    : proof.files[`bin/${name}`], `${name}: installed binary checksum changed`);
}
assert.equal(hash(readFileSync(new URL("../security/seccomp.json", import.meta.url))), manifest.seccomp.packagedSha256,
  "Packaged seccomp profile changed without manifest review");
for (const [path, expected] of Object.entries(proof.files)) {
  assert(!path.split("/").some(part => part === ".." || part === ""), "Unsafe build provenance path");
  assert(path.startsWith("bin/") || path.startsWith("share/licenses/tunnel-client/"), "Unexpected build provenance path");
  assert.equal(hash(readFileSync(`/usr/local/${path}`)), expected, `${path}: missing or changed build provenance`);
}
for (const path of build.sbomFiles) {
  const sbom = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert(sbom.packages.some((pkg: { name: string; versionInfo: string }) => pkg.name === "stdlib"
    && pkg.versionInfo === manifest.buildToolchain.version.slice(2)), "Go standard library omitted from SBOM");
}
function command(binary: string, argv: string[]) {
  const result = Bun.spawnSync([binary, ...argv], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `${binary} could not execute natively`);
  return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
}
assert.match(command("ldd", ["--version"]), /GLIBC|GNU libc/, "glibc required (not musl)");
assert.match(command("tunnel-client", ["--version"]), /\b0\.0\.15\b/, "Pinned tunnel version mismatch");
assert.match(command("cloudflared", ["--version"]), /\b2026\.8\.2\b/, "Pinned child version mismatch");
const chromiumVersion = command("/usr/bin/chromium", ["--version"]).trim();
assert(chromiumVersion.includes(manifest.debian.chromiumVersion.split("-")[0]), "Pinned Chromium version mismatch");
const root = mkdtempSync(join(tmpdir(), "cgw-image-smoke-"));
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  '<!doctype html><html><body><button id="send">Send</button><p id="answer"></p><script>'
  + 'document.querySelector("#send").onclick=()=>document.querySelector("#answer").textContent="native sandbox fixture completed"'
  + '</script></body></html>', { headers: { "content-type": "text/html" } }),
});
let context: BrowserContext | undefined;
try {
  // Failure on an unsupported host is intentional. Never retry with a weaker sandbox.
  context = await chromium.launchPersistentContext(root, {
    executablePath: "/usr/bin/chromium", chromiumSandbox: true, headless: true,
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${fixture.port}`);
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector("#answer")?.textContent === "native sandbox fixture completed");
  const sandbox = await context.newPage();
  await sandbox.goto("chrome://sandbox");
  const status = await sandbox.locator("body").innerText();
  assert(/Namespace Sandbox\s+Yes/i.test(status)
    || (/PID namespaces\s+Yes/i.test(status) && /Network namespaces\s+Yes/i.test(status)),
  "Chromium namespace sandbox is not active");
  assert(/Seccomp-BPF sandbox\s+Yes/i.test(status), "Chromium renderer seccomp-BPF sandbox is not active");
  let rendererCount = 0;
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    let cmdline: string;
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline.includes("chromium")) continue;
    const flags = cmdline.split("\0");
    for (const forbidden of ["--no-sandbox", "--disable-namespace-sandbox", "--disable-seccomp-filter-sandbox"]) {
      assert(!flags.includes(forbidden), `Chromium sandbox weakened: ${forbidden}`);
    }
    if (!flags.includes("--type=renderer")) continue;
    rendererCount++;
    let renderer: string;
    try { renderer = readFileSync(`/proc/${pid}/status`, "utf8"); }
    catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error
        && ["EACCES", "EPERM", "ENOENT"].includes(String(error.code))) continue;
      throw error;
    }
    assert.match(renderer, /^Seccomp:\s+2$/m, "Renderer is unsandboxed");
    assert.match(renderer, /^NoNewPrivs:\s+1$/m, "Renderer lost no-new-privileges");
    assert.match(renderer, /^CapEff:\s+0+$/m, "Renderer has effective capabilities");
  }
  assert(rendererCount > 0 || /Seccomp-BPF sandbox\s+Yes/i.test(status), "No physical Chromium renderer or Seccomp-BPF sandbox observed");
  console.info(JSON.stringify({ gate: "native-image-sandbox", arch, uid: 10001, gid: 10001,
    bun: Bun.version, chromium: chromiumVersion, tunnel: manifest.tunnel.version,
    cloudflared: manifest.tunnel.cloudflared.version, namespaceSandbox: true, rendererSeccomp: true,
    rendererCount, nativeElfChecksums: true, liveChatGpt: false }));
} finally {
  await context?.close();
  await fixture.stop(true);
  rmSync(root, { recursive: true, force: true });
}
