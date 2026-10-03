#!/usr/bin/env bun
/**
 * Offline actual Next + companion + runtime + persistent Chromium + MCP stdio.
 * Usage: bun tests/integration/chatgpt-web-runtime-smoke.mjs
 *   --runtime-url http://127.0.0.1:17841 --gateway-port 21127
 *   --runtime-bun /absolute/path/to/bun-1.4.0 --chromium /absolute/path/to/chromium
 * Or: --image cgw-runtime:check --gateway-port 21127 (native Linux Docker only).
 * Requires gateway Bun 1.4.2, runtime dependencies installed with its frozen lock,
 * and an existing gateway build. When BUILD_ID is absent, isolated Next dev builds
 * are used and explicitly reported. No account, production DB, Codex auth or live
 * tunnel is used. Outer tools execute only inside the newly owned fixture workspace.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(["--runtime-url", "--gateway-port", "--image", "--runtime-bun", "--chromium"].includes(key), "Unknown smoke flag");
  assert(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), "Smoke flag requires a value");
  assert(!Object.hasOwn(options, key), "Duplicate smoke flag"); options[key] = process.argv[index + 1];
}
assert(globalThis.Bun?.version === "1.4.2", "BLOCKED: gateway smoke driver requires Bun 1.4.2");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimePackage = join(repository, "services/chatgpt-web-runtime");
const gatewayPort = Number(options["--gateway-port"] || 21127);
assert(Number.isInteger(gatewayPort) && gatewayPort > 1024 && gatewayPort < 65534, "Invalid gateway port");
assert(!(options["--image"] && options["--runtime-url"]), "Select --image OR --runtime-url");
const runtimeUrl = new URL(options["--runtime-url"] || "http://127.0.0.1:17841");
assert(runtimeUrl.protocol === "http:" && runtimeUrl.hostname === "127.0.0.1" && runtimeUrl.pathname === "/" && runtimeUrl.port && !runtimeUrl.search && !runtimeUrl.hash && !runtimeUrl.username && !runtimeUrl.password, "Runtime fixture URL must be exact loopback HTTP with port");
const root = mkdtempSync(join(tmpdir(), "9router-cgw-gateway-"));
const children = [], logFiles = [], devDirectories = [];
const resources = { container: null, extraction: null, network: null, volume: null };
const suffix = randomUUID().replaceAll("-", "");
const previousEnvironment = { ...process.env };
let stage = "prerequisites";
const runAbort = new AbortController();
const interruptRun = () => runAbort.abort(new Error("Owned offline smoke interrupted"));
process.on("SIGINT", interruptRun); process.on("SIGTERM", interruptRun);
const deadlineSignal = ms => AbortSignal.any([runAbort.signal, AbortSignal.timeout(ms)]);
const dataToken = randomBytes(48).toString("base64url"), adminToken = randomBytes(48).toString("base64url");
const clientId = "offline-client", keyId = "offline-key";
const secret = (name, value) => { const path = join(root, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
const dataFile = join(root, "runtime-data.key"), adminFile = join(root, "runtime-admin.key");
const privateFile = join(root, "companion-private.pem"), publicFile = join(root, "companion-public.pem"), clientKeysFile = join(root, "client-keys.json");
let pair, provisioned;
const workspace = join(root, "workspace"), codexHome = join(root, "codex");
const isolated = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, DATA_DIR: join(root, "gateway-data"), CGW_DATA_DIR: join(root, "runtime-data"), CODEX_HOME: codexHome,
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", ENABLE_REQUEST_LOGS: "false", NEXT_TELEMETRY_DISABLED: "1",
  JWT_SECRET: "", XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"), LOCALAPPDATA: root,
  CGW_TUNNEL_PROFILES_FILE: "" };
Object.assign(process.env, isolated);
function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: repository, env: isolated, encoding: "utf8", timeout: 120000 });
  assert(result.status === 0, `BLOCKED: ${binary === "docker" ? "Docker native prerequisite/operation" : "runtime executable prerequisite"} failed`);
  return result.stdout.trim();
}
function start(binary, args, env = isolated, name = "process", input) {
  const fd = openSync(join(root, `${name}.private.log`), "w", 0o600); logFiles.push(fd);
  const child = spawn(binary, args, { cwd: repository, env, stdio: [input === undefined ? "ignore" : "pipe", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
  child.on("error", error => { child.spawnFailure = error; }); children.push(child);
  if (input !== undefined) child.stdin.end(input);
  return child;
}
async function freePort(preferred = 0) {
  const server = createServer(); await new Promise((ok, fail) => { server.once("error", fail); server.listen(preferred, "127.0.0.1", ok); });
  const port = server.address().port; await new Promise(ok => server.close(ok)); return port;
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function waitFor(url, init, owner, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    runAbort.signal.throwIfAborted();
    assert(!owner?.spawnFailure && owner?.exitCode == null, `Owned process exited during ${stage}; private logs are not emitted`);
    try { const result = await fetch(url, { ...init, signal: deadlineSignal(2000) }); if (result.ok) { await result.arrayBuffer(); return; } await result.arrayBuffer(); } catch {}
    await sleep(200);
  }
  throw new Error(`Readiness deadline at ${stage}`);
}
async function json(response, label) {
  const body = await response.json();
  assert(response.ok, `${label}: HTTP ${response.status} (${body.error?.code || body.error?.type || "unknown"})`); return body;
}
function post(base, path, body, extra = {}) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body), signal: deadlineSignal(120000), redirect: "error" });
}
function responseFromSse(text) {
  const events = text.split(/\r?\n\r?\n/).flatMap(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6))).filter(data => data !== "[DONE]").map(data => JSON.parse(data));
  const terminals = events.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type));
  const codes = terminals.map(event => event.response?.error?.code || event.response?.incomplete_details?.reason || event.type).filter(value => typeof value === "string" && /^[a-z0-9_.-]{1,100}$/i.test(value));
  assert(terminals.length === 1 && terminals[0].type === "response.completed", `Responses stream must have exactly one completed terminal (${codes.join(",") || "missing"})`);
  assert(events.some(event => event.type === "response.output_text.delta") || terminals[0].response.output.some(item => ["function_call", "custom_tool_call"].includes(item.type)), "Stream did not carry incremental text/native calls");
  return terminals[0].response;
}
const threads = new Map();
function nativeRequest({ child = false, parentThreadId, tools, name = "root" } = {}) {
  const threadId = randomUUID(), turnId = randomUUID();
  const metadata = { request_kind: "turn", thread_id: threadId, turn_id: turnId, agent_name: child ? "/root/reviewer" : "/root", sandbox_mode: "danger-full-access", workspaces: { [workspace]: {} },
    ...(child ? { parent_thread_id: parentThreadId, subagent_kind: "thread_spawn" } : {}) };
  const session = { type: "session_meta", payload: { id: threadId, source: child ? { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1, agent_path: "/root/reviewer" } } } : "cli",
    ...(child ? { parent_thread_id: parentThreadId, thread_source: "subagent", agent_path: "/root/reviewer" } : {}) } };
  const context = { type: "turn_context", payload: { turn_id: turnId, cwd: workspace, workspace_roots: [workspace], sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } };
  const file = join(codexHome, "sessions", "2026", "09", "04", `rollout-2026-09-04T15-30-36-${threadId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, [session, context].map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o400 });
  const request = { model: "cgw/chatgpt-web/gpt-5.6-sol", stream: true, reasoning: { effort: "high" }, client_metadata: { "x-codex-turn-metadata": metadata },
    ...(tools ? { tools } : {}), input: [{ type: "message", id: `${name}-task`, role: "user", content: [{ type: "input_text", text: "Synthetic offline fixture task" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }] };
  threads.set(threadId, { file, turnId }); return request;
}
let runtimeBun, gatewayMode, controlUrl, runtimeOwner, closeDatabase, outcome;
try {
  secret("runtime-data.key", dataToken); secret("runtime-admin.key", adminToken);
  mkdirSync(workspace, { recursive: true, mode: 0o700 }); mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(workspace, "synthetic.txt"), "synthetic fixture input\n", { mode: 0o600 });
  mkdirSync(isolated.DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(isolated.DATA_DIR, "jwt-secret"), randomBytes(32).toString("hex"), { mode: 0o600 });
  await freePort(gatewayPort); await freePort(gatewayPort + 1);
  const controlPort = await freePort(); controlUrl = `http://127.0.0.1:${controlPort}`;
  stage = "native runtime prerequisites";
  if (options["--image"]) {
    assert(process.platform === "linux", "BLOCKED: --image requires native Linux Docker; no WSL/emulation fallback");
    assert(["x64", "arm64"].includes(process.arch), "BLOCKED: unsupported native architecture");
    assert(command("docker", ["info", "--format", "{{.OSType}}"] ) === "linux", "BLOCKED: Docker server must be Linux");
    const arch = process.arch === "x64" ? "amd64" : "arm64";
    assert(command("docker", ["image", "inspect", "--format", "{{.Architecture}}", options["--image"]]) === arch, "BLOCKED: native image architecture mismatch");
    const hardening = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      ...(process.platform === "linux" ? ["--security-opt", "apparmor=unconfined"] : []),
      "--security-opt", `seccomp=${join(runtimePackage, "security/seccomp.json")}`, "--shm-size", "1g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700"];
    command("docker", ["run", "--rm", ...hardening, "--network", "none", "--tmpfs", "/data:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700", options["--image"], "bun", "scripts/image-smoke.ts", "--arch", arch]);
    resources.extraction = `cgw-extract-${suffix}`;
    command("docker", ["create", "--name", resources.extraction, options["--image"]]);
    runtimeBun = join(root, "bun-1.4.0"); command("docker", ["cp", `${resources.extraction}:/usr/local/bin/bun`, runtimeBun]); chmodSync(runtimeBun, 0o700);
    command("docker", ["rm", resources.extraction]); resources.extraction = null;
    resources.network = `cgw-offline-${suffix}`; resources.volume = `cgw-state-${suffix}`; resources.container = `cgw-runtime-${suffix}`;
    command("docker", ["network", "create", "--internal", resources.network]); command("docker", ["volume", "create", resources.volume]);
    const port = await freePort(); runtimeUrl.port = String(port);
    runtimeOwner = start("docker", ["run", "--rm", "-i", "--name", resources.container, ...hardening, "--network", resources.network, "--mount", `type=volume,src=${resources.volume},dst=/data`,
      "-p", `127.0.0.1:${port}:17841`, "-p", `127.0.0.1:${controlPort}:17843`, options["--image"], "bun", "scripts/gateway-smoke-fixture.ts", "--stdin-config"], isolated, "container",
      JSON.stringify({ CGW_RUNTIME_TOKEN_FILE: dataToken, CGW_ADMIN_TOKEN_FILE: adminToken, CGW_FIXTURE_CONTROL_PORT: "17843", ENABLE_REQUEST_LOGS: "false" }));
  } else {
    runtimeBun = options["--runtime-bun"] || process.env.CGW_RUNTIME_BUN;
    assert(runtimeBun && existsSync(runtimeBun), "BLOCKED: set CGW_RUNTIME_BUN or --runtime-bun to an installed Bun 1.4.0 executable");
    const chromium = options["--chromium"] || process.env.CGW_CHROMIUM_EXECUTABLE;
    assert(chromium && existsSync(chromium), "BLOCKED: set CGW_CHROMIUM_EXECUTABLE or --chromium to an installed sandbox-capable Chromium");
    await freePort(Number(runtimeUrl.port));
    runtimeOwner = start(runtimeBun, [join(runtimePackage, "scripts/gateway-smoke-fixture.ts")], { ...isolated,
      CGW_RUNTIME_TOKEN_FILE: dataFile, CGW_ADMIN_TOKEN_FILE: adminFile, CGW_PORT: runtimeUrl.port, CGW_FIXTURE_CONTROL_PORT: String(controlPort), CGW_CHROMIUM_EXECUTABLE: chromium }, "runtime");
  }
  assert(command(runtimeBun, ["--version"]) === "1.4.0", "BLOCKED: runtime/companion require Bun 1.4.0");
  stage = "companion keygen and provisioning";
  command(runtimeBun, [join(runtimePackage, "src/companion/keygen.ts"), privateFile, publicFile]);
  pair = { privateKey: readFileSync(privateFile, "utf8"), publicKey: readFileSync(publicFile, "utf8") };
  provisioned = { version: 1, clients: [{ clientId, keyId, publicKeyPem: pair.publicKey, enabled: true }] };
  writeFileSync(clientKeysFile, JSON.stringify(provisioned), { mode: 0o600 });
  await waitFor(`${controlUrl}/evidence`, { headers: { authorization: `Bearer ${adminToken}` } }, runtimeOwner);
  stage = "disposable gateway database";
  // Intentional module-load boundary: DB modules may only initialize after DATA_DIR,
  // HOME, USERPROFILE and APPDATA have been replaced with this owned temporary root.
  const db = await import(join(repository, "src/lib/db/index.js"));
  const driver = await import(join(repository, "src/lib/db/driver.js"));
  closeDatabase = driver.resetAdapterForTest;
  const apiKey = (await db.createApiKey("offline-cgw", "offline-machine")).key;
  const apiFile = secret("gateway-api.key", apiKey);
  await db.updateSettings({ requireLogin: false, requireApiKey: false });
  const connections = [];
  for (const [index, profileId] of ["browser-only-fixture", "fixture", "fixture"].entries()) {
    connections.push(await db.createProviderConnection({ provider: "chatgpt-web", authType: "bridge", name: `offline-row-${index}`, priority: index + 1, isActive: true, testStatus: "active", providerSpecificData: { profileId } }));
  }
  const gatewayEnv = { ...isolated, CHATGPT_WEB_RUNTIME_URL: runtimeUrl.origin, CHATGPT_WEB_RUNTIME_TOKEN_FILE: dataFile, CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE: adminFile, CHATGPT_WEB_CLIENT_KEYS_FILE: clientKeysFile };
  gatewayMode = existsSync(join(repository, process.env.NEXT_DIST_DIR || ".next", "BUILD_ID")) ? "production-custom-server" : "next-dev-build-missing";
  const gateways = [];
  for (const [index, color] of ["blue", "green"].entries()) {
    const env = { ...gatewayEnv, PORT: String(gatewayPort + index), HOSTNAME: "127.0.0.1" };
    let args;
    if (gatewayMode === "production-custom-server") args = [join(repository, "custom-server.js"), "-p", env.PORT, "-H", "127.0.0.1"];
    else {
      const directory = `.next-cgw-${suffix}-${color}`; env.NEXT_DIST_DIR = directory; devDirectories.push(join(repository, directory));
      args = [join(repository, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-p", env.PORT, "-H", "127.0.0.1"];
    }
    stage = `${color} actual Next startup`; const owner = start(process.execPath, args, env, color);
    const base = `http://127.0.0.1:${gatewayPort + index}`; await waitFor(base + "/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }, owner);
    gateways.push({ base, owner });
  }
  const companions = [];
  for (let index = 0; index < 2; index++) {
    const port = await freePort(); const configFile = secret(`companion-${index}.json`, JSON.stringify({ gatewayUrl: gateways[index].base, apiKeyFile: apiFile, privateKeyFile: privateFile, clientId, keyId, codexHome, listenPort: port }));
    const owner = start(runtimeBun, [join(runtimePackage, "src/companion/main.ts")], { ...isolated, CGW_COMPANION_CONFIG_FILE: configFile }, `companion-${index}`);
    const base = `http://127.0.0.1:${port}`; stage = "actual companion startup"; await waitFor(base + "/v1/models", {}, owner); companions.push(base);
  }
  const control = (path = "/evidence", method = "GET") => fetch(controlUrl + path, { method, headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(120000) }).then(response => json(response, "fixture evidence"));
  stage = "public catalog";
  const models = await json(await fetch(companions[0] + "/v1/models"), "public models");
  const sol = models.data.find(model => model.id === "cgw/chatgpt-web/gpt-5.6-sol");
  assert(sol?.supported_reasoning_levels.includes("high") && !sol.supported_reasoning_levels.includes("xhigh") && sol.model_family === "5.6", "Dotted route/effort/family lost through public Next/companion catalog");
  const auth = { authorization: `Bearer ${apiKey}` };
  const { parseRequest } = await import(join(runtimePackage, "src/responses/parser.ts"));
  const { resolveCompanionAuthority } = await import(join(runtimePackage, "src/companion/local-authority.ts"));
  const { signAuthority, sha256 } = await import(join(runtimePackage, "src/authority.ts"));
  const sign = (request, path = "/v1/responses") => {
    const parsed = parseRequest(request); if (path.endsWith("/compact")) parsed._compactionRequest = true;
    const proof = resolveCompanionAuthority(parsed, codexHome), { tools: _tools, ...environment } = proof.environment, { promptCacheKey: _cache, ...identity } = proof.identity;
    return signAuthority({ privateKeyPem: pair.privateKey, keyId, claims: { purpose: path.endsWith("/compact") ? "compact" : "responses", clientId, method: "POST", path, bodySha256: sha256(JSON.stringify(request)), ...identity, pathFlavor: proof.pathFlavor, environment, ...(proof.sourceTurnId ? { sourceTurnId: proof.sourceTurnId } : {}) } });
  };
  stage = "authority rejects before Send";
  const deniedWire = nativeRequest({ name: "denied" }); const raw = JSON.stringify(deniedWire); const signature = sign(deniedWire);
  const beforeDenied = (await control()).physicalSends;
  for (const [label, path, body, assertion, expected] of [
    ["unsigned", "/v1/responses", raw, null, 400],
    ["tampered-body", "/v1/responses", raw + " ", signature, 403],
    ["tampered-model", "/v1/responses", raw.replace("gpt-5.6-sol", "gpt-6-pro"), signature, 403],
    ["tampered-path", "/v1/responses/compact", raw, signature, 403],
  ]) {
    const response = await post(gateways[0].base, path, body, { ...auth, ...(assertion ? { "x-9router-cgw-attestation": assertion } : {}) });
    assert(response.status === expected && response.headers.get("x-9router-no-fallback") === "true", `${label} did not fail closed without fallback`); await response.arrayBuffer();
  }
  writeFileSync(clientKeysFile, JSON.stringify({ ...provisioned, clients: [{ ...provisioned.clients[0], enabled: false }] }), { mode: 0o600 });
  const revoked = await post(gateways[1].base, "/v1/responses", raw, { ...auth, "x-9router-cgw-attestation": sign(deniedWire) }); assert(revoked.status === 403, "Revoked provisioned key accepted"); await revoked.arrayBuffer();
  writeFileSync(clientKeysFile, JSON.stringify(provisioned), { mode: 0o600 });
  const noKey = await post(gateways[0].base, "/v1/responses", raw, { authorization: "Bearer invalid", "x-9router-cgw-attestation": sign(deniedWire) }); assert(noKey.status === 401, "API key bypass with local mode"); await noKey.arrayBuffer();
  const missing = nativeRequest({ name: "missing" }); rmSync(threads.get(missing.client_metadata["x-codex-turn-metadata"].thread_id).file);
  const missingResponse = await post(companions[0], "/v1/responses", missing); assert(missingResponse.status === 400 && (await missingResponse.json()).error.code === "codex_authority_unavailable", "Missing canonical rollout accepted");
  const poisoned = structuredClone(deniedWire); poisoned.client_metadata["x-codex-turn-metadata"].workspaces = { [join(root, "forged")]: {} };
  const poisonResponse = await post(companions[0], "/v1/responses", poisoned); assert(poisonResponse.status === 400 && (await poisonResponse.json()).error.code === "codex_authority_unavailable", "Poisoned canonical environment accepted");
  assert((await control()).physicalSends === beforeDenied, "Authority rejection reached physical Send");
  stage = "normal companion browser stream";
  const rootWire = nativeRequest();
  const normal = await post(companions[0], "/v1/responses", rootWire); assert(normal.ok && normal.headers.get("content-type").includes("text/event-stream"), "Normal native SSE request rejected");
  const normalResult = responseFromSse(await normal.text());
  const normalText = normalResult.output.filter(item => item.type === "message").flatMap(item => item.content).map(item => item.text || "").join("");
  assert(normalText.includes("Offline answer first paragraph.") && normalText.includes("Offline answer second paragraph."), "Actual DOM answer not preserved in native output");
  stage = "child canonical authority";
  const childWire = nativeRequest({ child: true, parentThreadId: rootWire.client_metadata["x-codex-turn-metadata"].thread_id, name: "child" });
  const forgedChild = structuredClone(childWire); forgedChild.client_metadata["x-codex-turn-metadata"].agent_name = "/root/forged";
  const childRejected = await post(companions[1], "/v1/responses", forgedChild); assert(childRejected.status === 400, "Forged child lineage accepted"); await childRejected.arrayBuffer();
  const childResponse = await post(companions[1], "/v1/responses", childWire); assert(childResponse.ok, "Canonical child rejected"); responseFromSse(await childResponse.text());
  stage = "compact signature before gateway rewrite";
  const compactWire = nativeRequest({ name: "compact" }); compactWire.stream = false;
  const compactMetadata = compactWire.client_metadata["x-codex-turn-metadata"]; delete compactWire.client_metadata;
  const compact = await post(companions[0], "/v1/responses/compact", compactWire, { "x-codex-turn-metadata": JSON.stringify(compactMetadata) });
  const compactResult = await json(compact, "signed header-only compact");
  assert(compactResult.output[0].id === "compact-task" && compactResult.output.at(-1).role === "user", "Compact did not return unary replacement history");
  stage = "signed interrupt after canonical rollout removal";
  const interruptIdentity = rootWire.client_metadata["x-codex-turn-metadata"];
  rmSync(threads.get(interruptIdentity.thread_id).file);
  const interrupt = await json(await post(companions[1], "/v1/cgw/interrupt-turn", { threadId: interruptIdentity.thread_id, turnId: interruptIdentity.turn_id }), "signed interrupt");
  assert(Number.isInteger(interrupt.cancelled), "Signed interrupt response missing settlement count");
  stage = "offline actual browser MCP transport injection";
  await control("/harness", "POST");
  // Let the public profile-keyed catalog TTL expire; no private gateway cache bypass.
  await sleep(31000);
  const tools = [{ type: "namespace", name: "fixture", tools: [{ type: "function", name: "read", description: "Read owned offline fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
    { type: "custom", name: "apply_patch", description: "Apply owned harmless fixture patch", format: { type: "text" } }];
  const harnessWire = nativeRequest({ tools, name: "harness" }); const harnessThread = harnessWire.client_metadata["x-codex-turn-metadata"].thread_id;
  const beforeHarness = await control();
  // Two real Next processes race the identical signed assertion, including binding CAS.
  const signed = sign(harnessWire);
  const parallel = await Promise.all(gateways.map(({ base }) => post(base, "/v1/responses", harnessWire, { ...auth, "x-9router-cgw-attestation": signed })));
  const acceptedIndex = parallel.findIndex(response => response.status === 200), rejectedIndex = parallel.findIndex(response => response.status === 409);
  assert(acceptedIndex >= 0 && rejectedIndex >= 0 && acceptedIndex !== rejectedIndex, "Blue/green did not atomically reject duplicate authority"); await parallel[rejectedIndex].arrayBuffer();
  let result = responseFromSse(await parallel[acceptedIndex].text()), body = harnessWire;
  const executed = new Set(), kinds = new Set(); let rounds = 0;
  const bindingBefore = (await control(`/evidence?threadId=${harnessThread}`)).binding;
  assert(bindingBefore?.profileId === "fixture" && bindingBefore.status === "active", "Tool request bound browser-only candidate instead of Full fixture");
  for (; rounds < 5; rounds++) {
    const calls = result.output.filter(item => ["function_call", "custom_tool_call"].includes(item.type));
    if (!calls.length) break;
    const outputs = calls.map(call => {
      assert(!executed.has(call.call_id), "Outer observer received a duplicate execution ID"); executed.add(call.call_id); kinds.add(call.type);
      let output;
      if (call.type === "function_call") {
        assert(call.namespace === "fixture" && call.name === "read", "Namespace changed on public wire");
        const args = JSON.parse(call.arguments); assert(args.path === "synthetic.txt", "Fixture requested an unowned tool path");
        output = readFileSync(join(workspace, args.path), "utf8");
      } else {
        assert(call.name === "apply_patch" && call.input === "*** Begin Patch\n*** Add File: synthetic-fixed.txt\n+fixed\n*** End Patch", "Unexpected freeform patch requested");
        const path = join(workspace, "synthetic-fixed.txt"); writeFileSync(path, "fixed\n", { flag: "wx", mode: 0o600 }); output = "Applied patch in owned offline observer workspace";
      }
      return { type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: call.call_id, output };
    });
    body = { ...body, input: [...body.input, ...result.output, ...outputs] };
    // First continuation goes to the opposite gateway; subsequent rounds alternate.
    const index = (1 - acceptedIndex + rounds) % 2;
    if (rounds === 0) {
      stage = "disabled profile continuation fails closed";
      for (const row of connections) await db.updateProviderConnection(row.id, { isActive: false });
      try {
        const withdrawn = await post(companions[index], "/v1/responses", body);
        assert(withdrawn.status === 409 && withdrawn.headers.get("x-9router-no-fallback") === "true", "Disabled durable profile did not fail closed");
        assert((await withdrawn.json()).error.code === "profile_unavailable", "Disabled profile returned wrong recovery state");
        assert((await control()).physicalSends === beforeHarness.physicalSends + 1, "Disabled continuation produced another browser Send");
      } finally { for (const row of connections) await db.updateProviderConnection(row.id, { isActive: true }); }
      stage = "cross-gateway native tool continuation";
    }
    const next = await post(companions[index], "/v1/responses", body); assert(next.ok, `Cross-gateway native tool continuation rejected (${next.status})`); result = responseFromSse(await next.text());
  }
  assert(rounds < 5 && result.status === "completed" && executed.size === 2 && kinds.has("function_call") && kinds.has("custom_tool_call"), "Browser/MCP tool loop did not reach native final");
  assert(readFileSync(join(workspace, "synthetic-fixed.txt"), "utf8") === "fixed\n", "Outer observer patch not physically applied locally");
  const afterHarness = await control(`/evidence?threadId=${harnessThread}`);
  assert(afterHarness.physicalSends - beforeHarness.physicalSends === 1 && afterHarness.mcpCalls - beforeHarness.mcpCalls === 2 && afterHarness.mcpResults - beforeHarness.mcpResults === 2, "Tool results did not resume same physical browser answer/MCP invocation");
  assert.deepEqual(afterHarness.binding, bindingBefore, "Runtime owner lost durable binding across gateway cutover");
  assert(afterHarness.composerClean && afterHarness.effortsVerified, "Actual composer/model effort proof failed");
  stage = "signed pending tool interruption";
  const cancelWire = nativeRequest({ tools, name: "cancel-pending" });
  const cancelMetadata = cancelWire.client_metadata["x-codex-turn-metadata"];
  const pending = await post(companions[0], "/v1/responses", cancelWire);
  assert(pending.ok, "Pending tool cancel fixture was not admitted");
  const pendingResult = responseFromSse(await pending.text());
  assert(pendingResult.output.some(item => item.type === "function_call"), "Cancel fixture did not reach actual pending MCP call");
  rmSync(threads.get(cancelMetadata.thread_id).file);
  const cancelled = await json(await post(companions[1], "/v1/cgw/interrupt-turn", { threadId: cancelMetadata.thread_id, turnId: cancelMetadata.turn_id }), "signed pending interrupt");
  assert(cancelled.cancelled === 1, "Signed interrupt did not cancel exact pending browser owner");
  const settledHealth = await json(await fetch(runtimeUrl.origin + "/healthz", { headers: { authorization: `Bearer ${dataToken}` } }), "interrupt physical settlement");
  assert(settledHealth.activeBrowserTurns === 0 && settledHealth.pendingToolCalls === 0, "Interrupt returned before physical MCP/browser settlement");
  outcome = { gate: "gateway-runtime-offline-e2e", gatewayMode, gatewayBun: Bun.version, runtimeBun: afterHarness.bunVersion, chromium: afterHarness.chromiumVersion,
    publicDottedReasoningCatalog: true, canonicalRootAndChild: true, missingAndPoisonedRolloutRejected: true, unsignedBodyModelPathRevokedRejectedBeforeSend: true,
    normalStreamingTerminal: "completed", compactSignatureBeforeRewrite: true, signedInterruptAfterRolloutRemoval: true, noFallbackHeader: true,
    signedPendingToolInterruptSettled: true,
    actualGatewayProcesses: 2, duplicateConnectionRowsOneProfile: true, durableBlueGreenBinding: true, parallelJtiReplayDenied: true,
    browserOnlyCandidateSkippedForTools: true, allRowsDisabledTypedNoFallbackNoSend: true,
    actualPersistentChromium: true, actualMcpStdio: true, nativeNamespacedCall: true, nativeFreeformPatch: true, localOuterExecutions: executed.size, sameBrowserToolContinuationSends: 1,
    nativeImageSandboxGate: !!options["--image"], realCodex: false, outboundOpenAiTunnel: false, liveChatGpt: false };
} catch (error) {
  // Never print gateway logs, wire input/output, attestation or secret configuration.
  console.error(JSON.stringify({ gate: "gateway-runtime-offline-e2e", outcome: "failed-or-blocked", stage,
    reason: error.code === "EADDRINUSE" ? "BLOCKED: requested port is occupied; existing services are never reused or stopped"
      : error instanceof assert.AssertionError ? error.message.split("\n")[0] : `Operation failed at ${stage}`, liveChatGpt: false }));
  process.exitCode = 1;
} finally {
  if (controlUrl) {
    try {
      await fetch(controlUrl + "/shutdown", { method: "POST", headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(2000) });
      const deadline = Date.now() + 20000;
      while (runtimeOwner?.exitCode === null && runtimeOwner?.signalCode === null && Date.now() < deadline) await sleep(50);
    } catch {}
  }
  if (resources.container) spawnSync("docker", ["stop", "--time", "20", resources.container], { stdio: "ignore", timeout: 30000 });
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 });
      continue;
    }
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 10000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(50);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  let cleanupFailed = false;
  for (const [resource, args] of [[resources.container, ["rm", "-f"]], [resources.extraction, ["rm", "-f"]], [resources.network, ["network", "rm"]], [resources.volume, ["volume", "rm"]]]) if (resource) {
    const result = spawnSync("docker", [...args, resource], { stdio: "ignore", timeout: 30000 });
    if (outcome && (resource === resources.network || resource === resources.volume) && result.status !== 0) cleanupFailed = true;
  }
  try {
    closeDatabase?.();
    for (const fd of logFiles) closeSync(fd);
    for (const directory of devDirectories) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch { cleanupFailed = true; }
  finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, key)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    process.off("SIGINT", interruptRun); process.off("SIGTERM", interruptRun);
  }
  if (cleanupFailed) {
    process.exitCode = 1;
    console.error(JSON.stringify({ gate: "gateway-runtime-offline-e2e", outcome: "owned-resource-cleanup-failed", liveChatGpt: false }));
  }
}
if (outcome && process.exitCode !== 1) console.info(JSON.stringify({ ...outcome, ownedResourcesCleaned: true }));
