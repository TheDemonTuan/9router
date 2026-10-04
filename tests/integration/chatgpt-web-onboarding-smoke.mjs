#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, chmodSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(["--gateway-image", "--runtime-image", "--browser-volume", "--proof-dir"].includes(key) && process.argv[i + 1] && !Object.hasOwn(flags, key), "Invalid onboarding smoke options");
  flags[key] = process.argv[i + 1];
}
assert(process.platform === "linux", "Native Linux Docker required");
for (const key of ["--gateway-image", "--runtime-image", "--browser-volume"]) assert(flags[key], `${key} required`);
const root = mkdtempSync(join(tmpdir(), "cgw-onboarding-"));
const proofs = join(root, "proofs"); mkdirSync(proofs); chmodSync(root, 0o755); chmodSync(proofs, 0o777);
const secrets = join(root, "secrets"); mkdirSync(secrets); chmodSync(secrets, 0o755);
writeFileSync(join(secrets, "admin-token"), "offline-viewer-admin-token".repeat(4));
writeFileSync(join(secrets, "data-token"), "offline-viewer-data-token".repeat(4));
const suffix = randomUUID().replaceAll("-", "");
const network = `cgw-onboarding-${suffix}`, gateway = `cgw-onboarding-gateway-${suffix}`, runtime = `cgw-onboarding-browser-${suffix}`;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let createdNetwork = false, createdGateway = false;
function command(args, timeout = 30000) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 && flags["--proof-dir"]) {
    const destination = resolve(flags["--proof-dir"]); mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "failure.log"), `${result.stdout || ""}\n${result.stderr || ""}`, { mode: 0o600 });
    for (const name of ["provider-failed.png", "provider-embedded-login.png"]) {
      if (existsSync(join(proofs, name))) copyFileSync(join(proofs, name), join(destination, name));
    }
  }
  assert(result.status === 0, `Owned Docker smoke operation failed: ${args[0]} (private command output not emitted)`);
  return result.stdout.trim();
}
let result;
try {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  assert(arch && command(["info", "--format", "{{.OSType}}"] ) === "linux", "Native Docker platform required");
  for (const image of [flags["--gateway-image"], flags["--runtime-image"]]) assert.equal(command(["image", "inspect", "--format", "{{.Architecture}}", image]), arch);
  // Reproduce the operator's root:10001/0640 mounts, not UID-owned tmp tokens.
  command(["run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
    "-v", `${secrets}:/secrets:Z`, "--entrypoint", "/bin/sh", flags["--gateway-image"], "-c", "chown 0:10001 /secrets/* && chmod 0640 /secrets/*"]);
  command(["network", "create", "--internal", network]); createdNetwork = true;
  command(["run", "-d", "--name", gateway, "--network", network, "--group-add", "10001", "--read-only", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
    "--security-opt", "no-new-privileges:true", "--cpus", "1", "--memory", "2g", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
    "--tmpfs", "/app/data:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/app/data-home:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
    "-e", "INITIAL_PASSWORD=Offline-Provider-UI-Fixture-20261004", "-e", "CHATGPT_WEB_RUNTIME_URL=http://127.0.0.1:17841",
    "-v", `${secrets}:/run/cgw-secrets:ro,Z`, "-e", "CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE=/run/cgw-secrets/admin-token", "-e", "CHATGPT_WEB_RUNTIME_TOKEN_FILE=/run/cgw-secrets/data-token",
    "-e", "ENABLE_REQUEST_LOGS=false", flags["--gateway-image"]]);
  createdGateway = true;
  command(["exec", gateway, "bun", "-e", "const end=Date.now()+30000;for(;;){try{const r=await fetch('http://127.0.0.1:20128/api/health');if(r.ok)break;}catch{}if(Date.now()>end)process.exit(1);await Bun.sleep(200);}"], 45000);
  command(["run", "--rm", "--name", runtime, "--network", `container:${gateway}`, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${join(repository, "services/chatgpt-web-runtime/security/seccomp.json")}`,
    "--cpus", "1", "--memory", "2g", "--shm-size", "1g", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/data:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700",
    "--mount", `type=volume,src=${flags["--browser-volume"]},dst=/opt/cgw-browser,readonly`,
    "-v", `${proofs}:/proof:Z`, "-e", "CGW_ONBOARDING_GATEWAY=http://127.0.0.1:20128", "-e", "CGW_ONBOARDING_PROOF_DIR=/proof",
    flags["--runtime-image"], "bun", "scripts/provider-onboarding-smoke.ts"], 180000);
  command(["run", "--rm", "--network", "none", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "-v", `${proofs}:/proof:Z`,
    "--entrypoint", "bun", flags["--runtime-image"], "-e", "const fs=require('node:fs');for(const name of fs.readdirSync('/proof'))fs.chmodSync('/proof/'+name,0o644);"]);
  result = JSON.parse(readFileSync(join(proofs, "result.json"), "utf8"));
  assert.equal(result.gate, "provider-onboarding-ui");
  if (flags["--proof-dir"]) {
    const destination = resolve(flags["--proof-dir"]); mkdirSync(destination, { recursive: true });
    for (const name of ["result.json", "provider-embedded-login.png", "provider-connected-ready.png"]) copyFileSync(join(proofs, name), join(destination, name));
  }
} finally {
  spawnSync("docker", ["rm", "-f", runtime], { stdio: "ignore", timeout: 30000 });
  if (createdGateway) spawnSync("docker", ["rm", "-f", gateway], { stdio: "ignore", timeout: 30000 });
  if (createdNetwork) assert(spawnSync("docker", ["network", "rm", network], { stdio: "ignore", timeout: 30000 }).status === 0, "Owned network cleanup failed");
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, ownedResourcesCleaned: true }));
