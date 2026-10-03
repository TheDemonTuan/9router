import { z } from "zod";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCompanionConfig, createCompanion } from "../src/companion/main";
import { validateProfileId } from "../protocol.js";

if (process.env.CGW_LIVE !== "1") throw new Error("Live staging requires explicit CGW_LIVE=1");
const configFile = process.env.CGW_STAGING_CONFIG_FILE;
if (!configFile) throw new Error("CGW_STAGING_CONFIG_FILE is required; staging gate is blocked, not skipped");
const config = z.object({ stagingOnly: z.literal(true), codexExecutable: z.string().min(1), companionConfigFile: z.string().min(1),
  profileId: z.string().min(1), model: z.string().regex(/^cgw\/chatgpt-web\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/), reasoning: z.enum(["medium", "high", "xhigh", "max"]),
  runtimeUrl: z.string().url(), adminTokenFile: z.string().min(1), preservePrivateState: z.boolean().default(false) }).strict().parse(JSON.parse(readFileSync(configFile, "utf8")));
validateProfileId(config.profileId);
const args = process.argv.slice(2); if (args.length !== 2 || args[0] !== "--profile" || args[1] !== config.profileId) throw new Error("Usage: smoke:live -- --profile <operator staging profile>");
if (!existsSync(config.codexExecutable)) throw new Error("Configured compatible Codex executable is unavailable");
const version = spawnSync(config.codexExecutable, ["--version"], { encoding: "utf8", timeout: 15000 });
if (version.status !== 0) throw new Error("Compatible Codex version probe failed");
const companionConfig = loadCompanionConfig(config.companionConfigFile);
const home = companionConfig.codexHome;
if (existsSync(home) && readdirSync(home).length) throw new Error("Live smoke requires a new empty disposable Codex home, never an existing user auth/config/rollout directory");
mkdirSync(home, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(tmpdir(), "cgw-private-staging-"));
const workspace = join(root, "workspace"); mkdirSync(workspace, { mode: 0o700 });
writeFileSync(join(workspace, "fixture.mjs"), "export const add=(left,right)=>left-right;\n");
writeFileSync(join(workspace, "fixture.test.mjs"), "import assert from 'node:assert/strict';import {add} from './fixture.mjs';assert.equal(add(2,3),5);\n");
const admin = readFileSync(config.adminTokenFile, "utf8").trim();
const runtime = new URL(config.runtimeUrl); if (!["https:", "http:"].includes(runtime.protocol) || runtime.username || runtime.password || runtime.search || runtime.hash) throw new Error("Invalid staging runtime URL");
const probe = await fetch(new URL("/admin/profiles", runtime), { headers: { authorization: `Bearer ${admin}` }, redirect: "error" });
if (!probe.ok) throw new Error("Authenticated staging runtime diagnostics unavailable");
const diagnostics = await probe.json();
const profile = diagnostics.profiles?.find((profile: { profileId: string }) => profile.profileId === config.profileId);
if (!profile || profile.state !== "ready" || profile.settings.mode !== "full" || !profile.connectorReady) throw new Error("Staging profile must already have private login, Full connector and tunnel readiness");
writeFileSync(join(home, "config.toml"), [
  'model_provider = "openai"', `model = ${JSON.stringify(config.model)}`, `openai_base_url = "http://127.0.0.1:${companionConfig.listenPort}/v1"`,
  `model_reasoning_effort = ${JSON.stringify(config.reasoning)}`, 'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"',
  '[features]', 'multi_agent = true', 'multi_agent_v2 = false', '[agents]', 'max_depth = 2', '',
].join("\n"), { mode: 0o600, flag: "wx" });
const companion = createCompanion(companionConfig);
const rolloutFiles = (directory: string): string[] => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name); return entry.isDirectory() ? rolloutFiles(path) : entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
}) : [];
const prompt = [
  "This is a private synthetic staging acceptance task. Work only in this disposable workspace.",
  "Read fixture.mjs and fixture.test.mjs using your local tools. Fix add using apply_patch; run node fixture.test.mjs and verify exit zero.",
  "Spawn exactly two Compatibility V1 children using the SAME current model and reasoning. One independently reads and checks the fixed function. The other spawns one nested child to run the harmless local test; wait for those exact agents with wait_agent timeout_ms=30000 and collect their evidence.",
  "Use send_input/resume/close only as supported by actual inventory. Do not use fallback models, encrypted V2, external network, credentials or files outside this fixture.",
  "After the local test and child/grandchild tools settle, return CGW_LIVE_FIXTURE_OK. Do not claim evidence unavailable in actual tool output.",
].join(" ");
try {
  const child = Bun.spawn([config.codexExecutable, "exec", "--skip-git-repo-check", "--json", "--sandbox", "workspace-write", "--model", config.model, prompt],
    { cwd: workspace, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "companion-replaces-this-synthetic-value" }, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
  const [status, stdout, _stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); clearTimeout(timeout);
  if (status !== 0) throw new Error("Real Codex staging fixture did not complete; inspect private local state (not chat/artifacts)");
  const sessions = rolloutFiles(join(home, "sessions")).map(path => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
  const records = sessions.flat();
  const metas = records.filter(record => record.type === "session_meta");
  const contexts = records.filter(record => record.type === "turn_context");
  const functionCalls = records.filter(record => record.type === "response_item" && ["function_call", "custom_tool_call"].includes(record.payload?.type));
  const outputs = records.filter(record => record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(record.payload?.type));
  const depth = (meta: { payload?: { source?: { subagent?: { thread_spawn?: { depth?: number } } } } }) => meta.payload?.source?.subagent?.thread_spawn?.depth || 0;
  if (metas.filter(meta => depth(meta) === 1).length < 2 || !metas.some(meta => depth(meta) >= 2)) throw new Error("Real root/two-child/grandchild lineage not observed");
  if (contexts.some(context => context.payload?.model !== config.model || context.payload?.multi_agent_version !== "v1")) throw new Error("Real Codex changed model or collaboration protocol");
  if (!functionCalls.some(record => record.payload?.name === "apply_patch") || !outputs.length) throw new Error("Native local patch/tool output round not observed");
  if (!functionCalls.some(record => record.payload?.name === "wait_agent" && JSON.parse(record.payload.arguments || "{}").timeout_ms === 30000)) throw new Error("Bounded native wait_agent traffic not observed");
  const test = spawnSync("node", ["fixture.test.mjs"], { cwd: workspace, encoding: "utf8", timeout: 15000 });
  if (test.status !== 0 || !stdout.includes("CGW_LIVE_FIXTURE_OK")) throw new Error("Local fixture or final acceptance marker failed");
  console.info(JSON.stringify({ gate: "private-live-codex-fixture", profile: config.profileId, upstreamRevision: "fa2d2c6c24926078b46eedb2186f69f2e8d548d7", codexVersion: version.stdout.trim(),
    localFixtureFixed: true, localTest: "passed", children: 2, nestedChild: true, nativePatchAndOutputs: true, compatibility: "v1", productionActivationAllowed: false,
    remainingManualGates: ["live compaction/multipart 2/6", "five-minute progress", "approval false/true", "retained/fresh/saved actual state", "cancel/disconnect/session/browser/tunnel faults", "sixth slot", "gateway blue/green", "runtime upgrade/rollback"] }));
} finally {
  await companion.stop(true);
  if (!config.preservePrivateState) { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}
