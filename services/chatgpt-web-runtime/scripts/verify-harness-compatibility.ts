import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../src/config";
import { UPSTREAM_REVISION } from "../protocol.js";

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native Linux amd64/arm64 compatibility gate required; Windows/emulation is not a pass");
if (Bun.version !== "1.4.0") throw new Error("Runtime compatibility gate requires Bun 1.4.0");
if (!process.env.CGW_CHROMIUM_EXECUTABLE) throw new Error("Pinned native sandboxed Chromium executable required");
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error("Usage: bun scripts/verify-harness-compatibility.ts <private build-evidence-output-json>");
const root = mkdtempSync(join(tmpdir(), "cgw-build-compatibility-"));
const env = { ...process.env, CGW_DATA_DIR: root, DATA_DIR: root, HOME: root, USERPROFILE: root, APPDATA: root, ENABLE_REQUEST_LOGS: "false" };
const gates = [
  ["test", "./tests/mcp-native.test.ts", "./tests/authority.test.ts", "./tests/companion-lineage.test.ts", "./tests/runtime-state.test.ts", "./tests/compaction-idle.test.ts", "./tests/chatgpt-web-markdown.test.ts", "./tests/browser-login-dom.test.ts"],
  ["scripts/image-smoke.ts", "--arch", process.arch === "arm64" ? "arm64" : "amd64"],
  ["scripts/smoke-offline.ts"], ["scripts/smoke-harness-offline.ts"], ["scripts/smoke-approval-offline.ts"], ["scripts/smoke-profile-ownership.ts"],
];
try {
  for (const args of gates) {
    const child = Bun.spawn([process.execPath, ...args], { cwd: resolve(import.meta.dir, ".."), env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    const status = await child.exited;
    clearTimeout(timeout);
    if (status !== 0) throw new Error(`Native compatibility gate failed: ${args[0]} (exit ${status}); no evidence was emitted`);
  }
  atomicWriteFile(resolve(output), JSON.stringify({ protocolVersion: 1, upstreamRevision: UPSTREAM_REVISION,
    nativeToolLoop: true, namespacedTools: true, freeformTools: true, compatibilityV1: true,
    nestedSubagents: true, profileConcurrency: true, approvalOnceOnly: true, requestScopeIsolation: true }));
  console.info(JSON.stringify({ gate: "native-build-compatibility", nativeArch: process.arch, gates: gates.length,
    emittedBuildEvidence: true, liveChatGpt: false, realCodex: false, productionActivationAllowed: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
