#!/usr/bin/env bun
/**
 * Offline actual Next + companion + runtime + persistent Chromium + MCP stdio.
 * Usage: bun tests/integration/chatgpt-web-runtime-smoke.mjs
 *   --runtime-url http://127.0.0.1:17841 --gateway-port 21127
 *   --runtime-bun /absolute/path/to/bun-1.4.0 --chromium /absolute/path/to/chromium
 * Or: --image cgw-runtime:check --browser-volume 9router-cgw-browser --gateway-port 21127 (native Linux Docker only).
 * Requires gateway Bun 1.4.2, runtime dependencies installed with its frozen lock,
 * and an existing gateway build. Missing BUILD_ID fails before launching processes;
 * this runner never compiles the gateway implicitly. No account, production DB, Codex auth or live
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
  assert(["--runtime-url", "--gateway-port", "--image", "--browser-volume", "--runtime-bun", "--chromium", "--opencode", "--proof-dir"].includes(key), "Unknown smoke flag");
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
assert(existsSync(join(repository, process.env.NEXT_DIST_DIR || ".next", "BUILD_ID")), "BLOCKED: a completed production gateway artifact is required; implicit local builds are disabled");
const proofDirectory = options["--proof-dir"] ? resolve(options["--proof-dir"]) : null;
if (proofDirectory) mkdirSync(proofDirectory, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(tmpdir(), "9router-cgw-gateway-"));
const children = [], logFiles = [];
const resources = { container: null, probe: null, extraction: null, network: null, volume: null };
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
    const browserVolume = options["--browser-volume"];
    assert(browserVolume && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(browserVolume), "BLOCKED: --image requires a provisioned Docker --browser-volume");
    assert(command("docker", ["volume", "inspect", "--format", "{{.Name}}", browserVolume]) === browserVolume, "BLOCKED: browser volume missing");
    const hardening = ["--read-only", "--cpus", "1.0", "--memory", "2g", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--security-opt", `seccomp=${join(runtimePackage, "security/seccomp.json")}`, "--shm-size", "1g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
      "--mount", `type=volume,src=${browserVolume},dst=/opt/cgw-browser,readonly`];
    resources.probe = `cgw-sandbox-${suffix}`;
    command("docker", ["run", "--rm", "--name", resources.probe, ...hardening, "--network", "none", "--tmpfs", "/data:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700", options["--image"], "bun", "scripts/image-smoke.ts", "--arch", arch]);
    resources.probe = null;
    resources.extraction = `cgw-extract-${suffix}`;
    command("docker", ["create", "--name", resources.extraction, options["--image"]]);
    runtimeBun = join(root, "bun-1.4.0"); command("docker", ["cp", `${resources.extraction}:/usr/local/bin/bun`, runtimeBun]); chmodSync(runtimeBun, 0o700);
    command("docker", ["rm", resources.extraction]); resources.extraction = null;
    resources.network = `cgw-offline-${suffix}`; resources.volume = `cgw-state-${suffix}`; resources.container = `cgw-runtime-${suffix}`;
    command("docker", ["network", "create", resources.network]); command("docker", ["volume", "create", resources.volume]);
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
      CGW_RUNTIME_TOKEN_FILE: dataFile, CGW_ADMIN_TOKEN_FILE: adminFile, CGW_PORT: runtimeUrl.port, CGW_FIXTURE_CONTROL_PORT: String(controlPort), CGW_CHROMIUM_EXECUTABLE: chromium, CGW_FIXTURE_HOST_DISPLAY: "1" }, "runtime");
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
  await db.setModelAlias("offline-browser-alias", "cgw/chatgpt-web/gpt-5.6-sol");
  await db.createCombo({ name: "offline-browser-combo", models: ["offline-browser-alias"] });
  const connections = [];
  for (const [index, profileId] of ["browser-only-fixture", "fixture", "fixture"].entries()) {
    connections.push(await db.createProviderConnection({ provider: "chatgpt-web", authType: "bridge", name: `offline-row-${index}`, priority: index + 1, isActive: true, testStatus: "active", providerSpecificData: { profileId } }));
  }
  const gatewayEnv = { ...isolated, CHATGPT_WEB_RUNTIME_URL: runtimeUrl.origin, CHATGPT_WEB_RUNTIME_TOKEN_FILE: dataFile, CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE: adminFile, CHATGPT_WEB_CLIENT_KEYS_FILE: clientKeysFile };
  gatewayMode = "production-custom-server";
  const gateways = [];
  for (const [index, color] of ["blue", "green"].entries()) {
    const env = { ...gatewayEnv, PORT: String(gatewayPort + index), HOSTNAME: "127.0.0.1" };
    const args = [join(repository, "custom-server.js"), "-p", env.PORT, "-H", "127.0.0.1"];
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
  const control = (path = "/evidence", method = "GET", body) => fetch(controlUrl + path, { method, headers: { authorization: `Bearer ${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) }).then(response => json(response, "fixture evidence"));
  stage = "public catalog";
  const models = await json(await fetch(companions[0] + "/v1/models"), "public models");
  const sol = models.data.find(model => model.id === "cgw/chatgpt-web/gpt-5.6-sol");
  assert(sol?.supported_reasoning_levels.includes("high") && !sol.supported_reasoning_levels.includes("xhigh") && sol.model_family === "5.6", "Dotted route/effort/family lost through public Next/companion catalog");
  const auth = { authorization: `Bearer ${apiKey}` };
  stage = "unsigned Browser-only four public wires";
  const genericBefore = (await control()).physicalSends;
  for (const model of ["cgw/chatgpt-web/gpt-5.6-sol", "offline-browser-alias", "offline-browser-combo"]) {
    const denied = await post(gateways[0].base, "/v1/chat/completions", { model, messages: [{ role: "user", content: "Do not send" }] }, { authorization: "Bearer invalid" });
    assert(denied.status === 401, "Direct/alias/combo allowed an invalid API key"); await denied.arrayBuffer();
  }
  assert((await control()).physicalSends === genericBefore, "API-key rejection reached Send through alias or combo");
  const fixtureAnswer = "Offline answer first paragraph.\n\nOffline answer second paragraph.";
  const browserConnection = connections[0].id;
  writeFileSync(clientKeysFile, JSON.stringify({ version: 1, clients: [] }), { mode: 0o600 });
  try {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      for (const stream of [false, true]) {
        const body = { model: "cgw/chatgpt-web/gpt-5.6-sol", stream,
          ...(path.endsWith("completions") ? { messages: [{ role: "user", content: "Return fixture text" }] } : { input: "Return fixture text" }) };
        const response = await post(gateways[0].base, path, body, { ...auth, "x-connection-id": browserConnection, "user-agent": "codex_cli_rs/offline" });
        assert(response.ok && response.headers.get("x-9router-connection-id") === browserConnection, "Generic request rejected or selected another account");
        let answer;
        if (!stream) {
          const result = await response.json();
          if (path.endsWith("completions")) { assert(result.choices[0].finish_reason === "stop", "Chat completion missing successful terminal"); answer = result.choices[0].message.content; }
          else { assert(result.status === "completed", "Responses JSON missing successful terminal"); answer = result.output.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join(""); }
        } else {
          const wire = await response.text();
          if (path.endsWith("completions")) {
            const chunks = wire.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
            assert(wire.includes("data: [DONE]") && chunks.some(chunk => chunk.choices?.[0]?.finish_reason === "stop"), "Chat stream missing terminal");
            answer = chunks.map(chunk => chunk.choices?.[0]?.delta?.content || "").join("");
          } else {
            const final = responseFromSse(wire);
            answer = final.output.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("");
            const deltas = wire.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6))).filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
            assert(deltas === answer, "Responses incremental text differs from final");
          }
        }
        assert(answer === fixtureAnswer, "Generic browser answer changed or lost paragraphs");
      }
    }
    assert((await control()).physicalSends === genericBefore + 4, "Generic wires did not produce exactly four physical Sends");
  } finally { writeFileSync(clientKeysFile, JSON.stringify(provisioned), { mode: 0o600 }); }
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
  stage = "generic standard-function four public wires";
  await control("/agent-fixture", "POST");
  writeFileSync(clientKeysFile, JSON.stringify({ version: 1, clients: [] }), { mode: 0o600 });
  const genericTools = [
    { type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    { type: "function", name: "write_file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  ];
  const genericEvidence = await control();
  for (const path of ["/v1/chat/completions", "/v1/responses"]) for (const stream of [false, true]) {
    const chat = path.endsWith("completions");
    const local = mkdtempSync(join(workspace, "generic-"));
    writeFileSync(join(local, "input.txt"), "CGW_AGENT_FIXTURE_INPUT\n", { mode: 0o600 });
    let history = chat ? [{ role: "user", content: "Read input.txt, create output.txt containing the same text plus VERIFIED, then read it back." }]
      : [{ type: "message", role: "user", content: "Read input.txt, create output.txt containing the same text plus VERIFIED, then read it back." }];
    const callIds = new Set();
    for (let round = 0; round < 4; round++) {
      const body = { model: "cgw/chatgpt-web/gpt-5.6-sol", stream, parallel_tool_calls: false,
        ...(round === 0 ? { tool_choice: chat ? { type: "function", function: { name: "read_file" } } : { type: "function", name: "read_file" } } : {}),
        ...(chat ? { reasoning_effort: "high", tools: genericTools.map(({ type, ...fn }) => ({ type, function: fn })), messages: history }
          : { reasoning: { effort: "high" }, tools: genericTools, input: history }) };
      const response = await post(gateways[round % 2].base, path, body, auth);
      if (!response.ok) {
        const failure = await response.json();
        const code = /^[a-z0-9_]+$/.test(failure.error?.code || "") ? failure.error.code : "unknown";
        assert.fail(`Generic ${chat ? "Chat" : "Responses"} round ${round} rejected (${response.status}:${code})`);
      }
      assert(response.headers.get("x-9router-connection-id") !== browserConnection, "Generic tools selected browser-only account");
      let calls, answer, assistant;
      if (chat) {
        let message, finish;
        if (!stream) {
          const result = await response.json(); message = result.choices[0].message; finish = result.choices[0].finish_reason;
        } else {
          const wire = await response.text(); assert(wire.includes("data: [DONE]"), "Generic Chat missing DONE");
          const chunks = wire.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
          const collected = new Map(); let content = "";
          for (const chunk of chunks) {
            const choice = chunk.choices?.[0]; if (choice?.finish_reason) finish = choice.finish_reason;
            content += choice?.delta?.content || "";
            for (const call of choice?.delta?.tool_calls || []) {
              const value = collected.get(call.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
              if (call.id) value.id = call.id;
              value.function.name += call.function?.name || ""; value.function.arguments += call.function?.arguments || "";
              collected.set(call.index, value);
            }
          }
          message = { role: "assistant", content: content || null, ...(collected.size ? { tool_calls: [...collected.values()] } : {}) };
        }
        calls = (message.tool_calls || []).map(call => ({ call_id: call.id, name: call.function.name, arguments: call.function.arguments }));
        assert(finish === (round < 3 ? "tool_calls" : "stop"), "Generic Chat finish_reason does not match tool/final boundary");
        assistant = message; answer = message.content;
      } else {
        const result = stream ? responseFromSse(await response.text()) : await response.json();
        assert(result.status === "completed", "Generic Responses did not complete");
        calls = result.output.filter(item => item.type === "function_call");
        answer = result.output.filter(item => item.type === "message").flatMap(item => item.content).map(item => item.text || "").join("");
      }
      if (round === 3) { assert(calls.length === 0 && answer.includes("Verification complete"), "Generic tool loop did not reach final answer"); break; }
      assert(calls.length === 1, "Generic function batch boundary changed");
      const call = calls[0]; assert(!callIds.has(call.call_id), "Generic call ID was reused"); callIds.add(call.call_id);
      const args = JSON.parse(call.arguments);
      assert(call.name === (round === 1 ? "write_file" : "read_file") && args.path === (round === 0 ? "input.txt" : "output.txt"), "Unexpected client tool/path proposal");
      let output;
      if (round === 1) {
        assert(args.content === "CGW_AGENT_FIXTURE_INPUT\nVERIFIED\n", "Generic write content was not derived from client read result");
        writeFileSync(join(local, args.path), args.content, { flag: "wx", mode: 0o600 }); output = "WRITE_SUCCESS";
      } else {
        output = readFileSync(join(local, args.path), "utf8");
        if (round === 2) { assert(output === "CGW_AGENT_FIXTURE_INPUT\nVERIFIED\n", "Generic read-back failed"); output = "READ_BACK_SUCCESS\n" + output; }
      }
      history = chat ? [...history, assistant, { role: "tool", tool_call_id: call.call_id, content: output }]
        : [...history, { type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments }, { type: "function_call_output", call_id: call.call_id, output }];
    }
    assert(callIds.size === 3 && readFileSync(join(local, "output.txt"), "utf8") === "CGW_AGENT_FIXTURE_INPUT\nVERIFIED\n", "Generic physical client file evidence missing");
  }
  const afterGeneric = await control();
  assert(afterGeneric.physicalSends - genericEvidence.physicalSends === 16 && afterGeneric.mcpCalls - genericEvidence.mcpCalls === 12, "Generic rounds did not use fresh physical turns/actual MCP batches");
  stage = "required-tool failures remain structured and terminal for Chat clients";
  await control("/agent-cli", "POST", { calls: [], answer: "No proposed tools." });
  const beforeRequired = await control();
  for (const stream of [false, true]) {
    const response = await post(gateways[0].base, "/v1/chat/completions", { model: "cgw/chatgpt-web/gpt-5.6-sol", stream,
      reasoning_effort: "high", tool_choice: "required", tools: genericTools.map(({ type, ...fn }) => ({ type, function: fn })),
      messages: [{ role: "user", content: "Offline required-tool error fixture." }] }, { ...auth, "x-connection-id": connections[1].id });
    if (stream) {
      const wire = await response.text();
      const frames = wire.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
      assert(frames.find(frame => frame.error)?.error.code === "agent_tool_choice_unsatisfied", "Streaming Chat lost typed required-tool failure");
      assert(!wire.includes("[Error]") && !frames.some(frame => frame.choices?.[0]?.finish_reason), "Streaming Chat fabricated a successful error answer");
    } else {
      const result = await response.json();
      assert(response.status === 502 && result.error?.code === "agent_tool_choice_unsatisfied" && !result.choices, "Nonstream Chat lost typed required-tool failure");
      assert(response.headers.get("x-9router-no-fallback") === "true", "Nonstream tool failure lost replay protection");
    }
  }
  assert((await control()).physicalSends - beforeRequired.physicalSends === 2, "Required-tool failures retried physical submission");
  stage = "native and generic shared physical capacity/cancellation";
  writeFileSync(clientKeysFile, JSON.stringify(provisioned), { mode: 0o600 });
  await control("/agent-cli", "POST", { calls: [], answer: "Held offline capacity turn completed.", delayMs: 300000 });
  const capacityStart = await control();
  const capacityNative = nativeRequest({ name: "mixed-capacity" });
  const capacityIdentity = capacityNative.client_metadata["x-codex-turn-metadata"];
  const nativeCapacityAbort = new AbortController();
  const nativePending = fetch(gateways[0].base + "/v1/responses", { method: "POST", headers: { ...auth, "content-type": "application/json", "x-connection-id": connections[1].id, "x-9router-cgw-attestation": sign(capacityNative) }, body: JSON.stringify(capacityNative), signal: nativeCapacityAbort.signal }).then(async response => { await response.arrayBuffer(); }).catch(error => { assert(nativeCapacityAbort.signal.aborted, "Unexpected native capacity failure"); });
  const genericBody = { model: "cgw/chatgpt-web/gpt-5.6-sol", stream: false, reasoning_effort: "high", tool_choice: "none", tools: genericTools.map(({ type, ...fn }) => ({ type, function: fn })), messages: [{ role: "user", content: "Hold the offline capacity fixture." }] };
  const capacityAborts = Array.from({ length: 4 }, () => new AbortController());
  const genericPending = capacityAborts.map(controller => fetch(gateways[0].base + "/v1/chat/completions", { method: "POST", headers: { ...auth, "content-type": "application/json", "x-connection-id": connections[1].id }, body: JSON.stringify(genericBody), signal: controller.signal }).then(async response => { await response.arrayBuffer(); }).catch(error => { assert(controller.signal.aborted, "Unexpected generic capacity failure"); }));
  const health = () => fetch(runtimeUrl.origin + "/healthz", { headers: { authorization: `Bearer ${dataToken}` } }).then(response => json(response, "mixed physical health"));
  const waitPhysical = async (count, timeout = 20000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if ((await health()).activeBrowserTurns === count) return; await sleep(100); }
    throw new assert.AssertionError({ message: `Mixed-client physical turn count did not reach ${count}` });
  };
  try {
    await waitPhysical(5);
    const beforeOverflow = await control();
    stage = "sixth mixed-client physical turn overflow";
    const overflow = await post(gateways[1].base, "/v1/chat/completions", genericBody, { ...auth, "x-connection-id": connections[1].id });
    const overflowBody = await overflow.json();
    const overflowCode = typeof overflowBody.error?.code === "string" && /^[a-z0-9_]+$/.test(overflowBody.error.code) ? overflowBody.error.code : "unknown";
    assert(overflow.status === 503 && overflowCode === "provider_busy", `Sixth mixed-client turn did not fail typed busy (HTTP ${overflow.status}, ${overflowCode})`);
    assert((await control()).physicalSends === beforeOverflow.physicalSends, "Sixth mixed-client turn reached Send");
    stage = "generic physical cancellation settlement";
    capacityAborts[0].abort(); await genericPending[0]; await waitPhysical(4);
    stage = "native physical cancellation settlement";
    const interrupt = await json(await post(companions[0], "/v1/cgw/interrupt-turn", { threadId: capacityIdentity.thread_id, turnId: capacityIdentity.turn_id }), "mixed native cancellation");
    assert(interrupt.cancelled === 1, "Mixed native cancellation missed its physical owner");
    await nativePending; await waitPhysical(3);
    stage = "reclaimed generic physical slot";
    await control("/agent-cli", "POST", { calls: [], answer: "Reclaimed physical slot completed." });
    const reclaimed = await json(await post(gateways[1].base, "/v1/chat/completions", genericBody, { ...auth, "x-connection-id": connections[1].id }), "reclaimed generic capacity");
    assert(reclaimed.choices[0].finish_reason === "stop", "Cancelled physical slot could not run another generic turn");
  } finally {
    capacityAborts.forEach(controller => controller.abort());
    nativeCapacityAbort.abort();
    await Promise.all(genericPending); await nativePending;
  }
  await waitPhysical(0);
  const capacityEnd = await control();
  assert(capacityEnd.physicalSends >= capacityStart.physicalSends + 1, "Mixed-client smoke did not physically submit the reclaimed slot");
  writeFileSync(clientKeysFile, JSON.stringify({ version: 1, clients: [] }), { mode: 0o600 });
  let actualOpenCode = null;
  if (options["--opencode"]) {
    stage = "actual OpenCode CLI project-scoped read/write/read-back";
    stage = "OpenCode executable version prerequisite";
    const version = command(options["--opencode"], ["--version"]);
    const project = mkdtempSync(join(workspace, "opencode-"));
    assert(spawnSync("git", ["init", "--quiet"], { cwd: project, env: { ...isolated, PWD: project }, stdio: "ignore" }).status === 0, "Owned CLI fixture initialization failed");
    writeFileSync(join(project, "input.txt"), "CGW_AGENT_FIXTURE\n", { mode: 0o600 });
    const cliCalls = [
      { name: "read", arguments: { filePath: join(project, "input.txt") } },
      { name: "apply_patch", arguments: { patchText: `*** Begin Patch\n*** Add File: ${join(project, "output.txt")}\n+CGW_AGENT_FIXTURE\n+VERIFIED\n*** End Patch` } },
      { name: "read", arguments: { filePath: join(project, "output.txt") } },
    ];
    const fields = new Set(); let requests = 0, proxyFailure, gatewayFailure, proxyStage = "idle";
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "POST") {
          proxyStage = "decode-client-request";
          const body = await request.clone().json(); Object.keys(body).forEach(key => fields.add(key));
          assert(!["temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "max_output_tokens"].some(key => Object.hasOwn(body, key)), "Generated OpenCode plugin left unsupported controls on the wire");
          assert(body.reasoning_effort === "high" && requests < 4, "OpenCode lost requested effort or repeated a turn");
          if (requests > 0) assert(body.messages.filter(message => message.role === "tool").length === requests, "OpenCode did not supply complete tool-result history");
          const next = cliCalls[requests];
          if (next) assert(body.tools.some(tool => tool.function?.name === next.name), "OpenCode native read/write inventory missing");
          proxyStage = "configure-offline-browser";
          await control("/agent-cli", "POST", { calls: next ? [next] : [], answer: next ? "Client operation queued." : "Verification complete: output.txt contains CGW_AGENT_FIXTURE and VERIFIED." });
          requests++;
        }
        proxyStage = "forward-to-gateway";
        const response = await fetch(gateways[0].base + url.pathname + url.search, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: request.signal });
        if (!response.ok) {
          const failure = await response.clone().json().catch(() => null);
          const code = failure?.error?.code || failure?.error?.type;
          gatewayFailure = { status: response.status, code: typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "unknown" };
        }
        return response;
      } catch (error) { proxyFailure = error; return Response.json({ error: { message: "Offline CLI fixture assertion failed" } }, { status: 500 }); }
    } });
    try {
      const { buildChatGptWebClientConfig } = await import(join(repository, "src/shared/utils/chatgptWebClientConfig.js"));
      stage = "OpenCode generated project configuration: build template";
      const catalogSol = { ...sol, id: sol.id.replace(/^cgw\//, ""), context_window: sol.context_length,
        ...(sol.max_completion_tokens !== undefined ? { max_output: sol.max_completion_tokens } : {}) };
      const snippet = buildChatGptWebClientConfig(catalogSol, `http://127.0.0.1:${proxy.port}`, "high");
      const config = JSON.parse(snippet.openCodeConfig);
      config.permission = { "*": "deny", read: { "*": "deny", "input.txt": "allow", "output.txt": "allow" }, edit: { "*": "deny", "output.txt": "allow" } };
      // Keep this deterministic tool fixture scoped to the requested task, not
      // OpenCode's separate background title-generation conversation.
      config.agent = { title: { disable: true } };
      writeFileSync(join(project, "opencode.json"), JSON.stringify(config), { mode: 0o600 });
      mkdirSync(join(project, ".opencode/plugins"), { recursive: true, mode: 0o700 });
      writeFileSync(join(project, ".opencode/plugins/9router-cgw.js"), snippet.openCodePlugin, { mode: 0o600 });
      const fd = openSync(join(root, "opencode.private.log"), "w", 0o600); logFiles.push(fd);
      const cli = spawn(options["--opencode"], ["run", "--format", "json", "--model", "9router-cgw/cgw/chatgpt-web/gpt-5.6-sol", "Read input.txt, create output.txt containing the same text plus VERIFIED, then read it back."],
        { cwd: project, env: { ...isolated, PWD: project, NINE_ROUTER_API_KEY: apiKey, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" }, stdio: ["ignore", fd, fd], detached: process.platform !== "win32" });
      children.push(cli);
      const completion = Promise.withResolvers(); cli.once("error", completion.reject); cli.once("exit", completion.resolve);
      stage = "OpenCode actual client execution";
      const timeout = setTimeout(() => completion.reject(new assert.AssertionError({ message: `OpenCode CLI deadline after ${requests} completed request admissions` })), 180000);
      let code;
      try { code = await completion.promise; } finally { clearTimeout(timeout); }
      const opencodeLog = readFileSync(join(root, "opencode.private.log"), "utf8");
      const cliFailure = /Configuration is invalid/.test(opencodeLog) ? "invalid client configuration"
        : /ProviderModelNotFoundError/.test(opencodeLog) ? "client model unavailable" : "client execution failed";
      const transportName = ["TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(proxyFailure?.name) ? proxyFailure.name : "Error";
      const safeProxyReason = proxyFailure instanceof assert.AssertionError ? proxyFailure.message.split("\n")[0] : proxyFailure ? `fixture ${proxyStage} ${transportName}` : code === 0 ? "none" : cliFailure;
      assert(!proxyFailure && code === 0 && requests === 4, `Actual OpenCode CLI failed (exit ${code}, rounds ${requests}, ${safeProxyReason}${gatewayFailure ? `, gateway ${gatewayFailure.status} ${gatewayFailure.code}` : ""})`);
      stage = "OpenCode physical output verification";
      assert(existsSync(join(project, "output.txt")), "Actual OpenCode did not create its physical output");
      assert(readFileSync(join(project, "output.txt"), "utf8") === "CGW_AGENT_FIXTURE\nVERIFIED\n", "Actual OpenCode write/read-back file missing");
      const events = readFileSync(join(root, "opencode.private.log"), "utf8").split(/\r?\n/).filter(line => line.startsWith("{")).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      assert(events.filter(event => event.type === "tool_use" && event.part?.state?.status === "completed").length === 3, "Actual OpenCode tool execution output missing");
      assert(events.some(event => event.type === "text" && event.part?.text?.includes("Verification complete")), "Actual OpenCode final answer missing");
      actualOpenCode = { version, nativeClientTools: true, projectRestrictedPermissions: true, readWriteReadBack: true, completeHistory: true, unsupportedControlsAbsent: true, wireFieldNames: [...fields].sort() };
    } finally { proxy.stop(true); }
  }
  outcome = { gate: "gateway-runtime-offline-e2e", gatewayMode, gatewayBun: Bun.version, runtimeBun: afterHarness.bunVersion, chromium: afterHarness.chromiumVersion,
    publicDottedReasoningCatalog: true, canonicalRootAndChild: true, missingAndPoisonedRolloutRejected: true, unsignedBodyModelPathRevokedRejectedBeforeSend: true,
    normalStreamingTerminal: "completed", compactSignatureBeforeRewrite: true, signedInterruptAfterRolloutRemoval: true, noFallbackHeader: true,
    signedPendingToolInterruptSettled: true,
    genericPublicFourWires: true, emptyCompanionProvisioningGeneric: true, codexUserAgentDoesNotGrantAuthority: true,
    genericFunctionFourWires: true, genericFreshBrowserSends: 16, genericActualMcpCalls: 12, genericLocalReadWriteReadBack: true, actualOpenCode,
    nativeGenericSharedFivePhysicalSlots: true, sixthTurnTypedBusyNoSend: true, genericCancellationSettled: true, nativeCancellationSettled: true, cancelledSlotReclaimed: true,
    actualGatewayProcesses: 2, duplicateConnectionRowsOneProfile: true, durableBlueGreenBinding: true, parallelJtiReplayDenied: true,
    browserOnlyCandidateSkippedForTools: true, allRowsDisabledTypedNoFallbackNoSend: true,
    actualPersistentChromium: true, actualMcpStdio: true, nativeNamespacedCall: true, nativeFreeformPatch: true, localOuterExecutions: executed.size, sameBrowserToolContinuationSends: 1,
    nativeImageSandboxGate: !!options["--image"], realCodex: false, outboundOpenAiTunnel: false, liveChatGpt: false };
} catch (error) {
  // Never print gateway logs, wire input/output, attestation or secret configuration.
  const failure = { gate: "gateway-runtime-offline-e2e", outcome: "failed-or-blocked", stage,
    reason: error.code === "EADDRINUSE" ? "BLOCKED: requested port is occupied; existing services are never reused or stopped"
      : error instanceof assert.AssertionError ? error.message.split("\n")[0] : `Operation failed at ${stage}`, liveChatGpt: false };
  if (proofDirectory) writeFileSync(join(proofDirectory, "failure.json"), JSON.stringify(failure, null, 2) + "\n", { mode: 0o600 });
  console.error(JSON.stringify(failure));
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
  for (const [resource, args] of [[resources.container, ["rm", "-f"]], [resources.probe, ["rm", "-f"]], [resources.extraction, ["rm", "-f"]], [resources.network, ["network", "rm"]], [resources.volume, ["volume", "rm"]]]) if (resource) {
    const result = spawnSync("docker", [...args, resource], { stdio: "ignore", timeout: 30000 });
    if (outcome && (resource === resources.network || resource === resources.volume) && result.status !== 0) cleanupFailed = true;
  }
  try {
    closeDatabase?.();
    for (const fd of logFiles) closeSync(fd);
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
if (outcome && process.exitCode !== 1) {
  const result = { ...outcome, ownedResourcesCleaned: true };
  if (proofDirectory) writeFileSync(join(proofDirectory, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.info(JSON.stringify(result));
}
