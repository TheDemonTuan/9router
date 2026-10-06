import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Server } from "bun";
import type { BrowserContext } from "playwright-core";

// This is an offline connector transport, not a release compatibility manifest or
// production configuration switch. All Responses, identity, broker and browser code
// remains the real runtime implementation. Only ChatGPT's origin and outbound tunnel
// are replaced by a DOM fixture and an actual private MCP stdio connection.
if (Bun.version !== "1.4.0") throw new Error("Runtime fixture requires Bun 1.4.0");
if (process.argv.includes("--stdin-config")) {
  const config = JSON.parse(await Bun.stdin.text());
  const directory = "/run/cgw/fixture";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries(config) as [string, string][]) {
    if (key.endsWith("_TOKEN_FILE")) {
      const file = join(directory, key); writeFileSync(file, value, { mode: 0o600 }); process.env[key] = file;
    } else process.env[key] = value;
  }
}
// Deliberate module-loading boundary: stdin configuration must isolate all paths
// before runtime modules initialize their persistent stores.
const { startRuntime } = await import("../src/server");
const { loadRuntimeConfig, defaultBrokerEndpoint } = await import("../src/config");
const { chatGptTurnSessions } = await import("../src/adapters/chatgpt-web/turn-execution");
const config = loadRuntimeConfig();
const runtime = startRuntime(config);
const client = new Client({ name: "offline-browser-connector", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(import.meta.dir, "../src/adapters/chatgpt-web/mcp-main.ts"), "--broker-socket", defaultBrokerEndpoint(join(config.dataDir, "profiles", "fixture")), "--contract", "native"],
  stderr: "pipe", env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
let physicalSends = 0, composerClean = true, effortsVerified = true, mcpCalls = 0, mcpResults = 0, harness = false;
let malformedClientTools = false, oldGenericTools = false;
let closing = false;
let control: Server<undefined> | undefined;
async function close() {
  if (closing) return; closing = true;
  control?.stop(true);
  chatGptTurnSessions.clear();
  const deadline = Date.now() + 15_000;
  while (chatGptTurnSessions.physicalWorkCount() && Date.now() < deadline) await Bun.sleep(25);
  await client.close(); await runtime.close();
}
try {
  await runtime.initialized;
  const contexts: BrowserContext[] = [];
  for (const profileId of ["fixture", "browser-only-fixture"]) {
    runtime.state.createProfile(profileId);
    const manager = await runtime.profiles.ensureProfileBrowser(profileId);
    contexts.push(await manager.ensureContext());
  }
  const context = contexts[0];
  await client.connect(transport);
  const inventory = await client.listTools();
  if (!inventory.tools.some(tool => tool.name === "codex_tool_call") || !inventory.tools.some(tool => tool.name === "codex_apply_patch")) throw new Error("Actual native MCP handshake inventory missing");
  for (const context of contexts) {
  await context.exposeBinding("syntheticMcpCall", async (_source, input) => {
    mcpCalls++; const result = await client.callTool(input); mcpResults++;
    if (result.isError) throw new Error("Offline MCP invocation failed"); return result;
  });
  await context.exposeBinding("syntheticObserveSend", (_source, evidence) => {
    physicalSends++; composerClean &&= !evidence.stale; effortsVerified &&= evidence.effort === "2";
  });
  await context.addInitScript(() => document.addEventListener("submit", () => {
    const text = document.querySelector("#prompt-textarea")?.textContent || "";
    const effort = document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow");
    void Reflect.get(window, "syntheticObserveSend")({ stale: text.includes("Stale draft must be cleared"), effort });
  }, true));
  const html = readFileSync(new URL("../tests/fixtures/chatgpt-runtime.html", import.meta.url), "utf8");
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://chatgpt.com") return route.abort();
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: { expires: new Date(Date.now() + 3600000).toISOString(), user: { id: "offline-synthetic-account" } } });
    return route.fulfill({ body: html.replace("let value=0", `window.__cgwClientToolsFixture={malformed:${malformedClientTools}};let value=0`), contentType: "text/html" });
  });
  }
  await runtime.profiles.probe("browser-only-fixture");
  let offlineProbe = await runtime.profiles.probe("fixture");
  const productionEvidence = runtime.profiles.evidence.bind(runtime.profiles);
  runtime.profiles.evidence = (id: string) => {
    if (!harness || id !== "fixture") {
      const evidence = productionEvidence(id);
      return oldGenericTools ? { ...evidence, models: evidence.models.map(row => ({ ...row, capabilities: { ...row.capabilities, generic_tools: false } })) } : evidence;
    }
    const profile = runtime.state.profile(id);
    if (profile.epoch !== offlineProbe.epoch || profile.revision !== offlineProbe.revision) throw new Error("Offline connector evidence expired");
    return offlineProbe;
  };
  const productionReady = runtime.profiles.ready.bind(runtime.profiles);
  runtime.profiles.ready = (id: string) => harness && id === "fixture" && !runtime.state.fence()
    ? !!runtime.profiles.evidence(id).models.length : productionReady(id);
  control = Bun.serve({ hostname: config.host, port: Number(process.env.CGW_FIXTURE_CONTROL_PORT), async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${config.adminToken.toString()}`) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/shutdown") {
      setTimeout(() => { void close().then(() => process.exit(0)); }, 25);
      return Response.json({ closingOwnedFixture: true });
    }
    if (request.method === "POST" && path.startsWith("/client-tools/")) {
      const mode = path.slice("/client-tools/".length);
      if (!["normal", "malformed", "old-capability"].includes(mode)) return new Response(null, { status: 400 });
      malformedClientTools = mode === "malformed"; oldGenericTools = mode === "old-capability";
      return Response.json({ mode });
    }
    if (request.method === "POST" && path === "/harness") {
      const profile = runtime.state.profile("fixture");
      runtime.state.patchProfile("fixture", profile.revision, { ...profile.settings, mode: "full" });
      const probe = await runtime.profiles.probe("fixture");
      // Explicit offline transport injection only, after the real stdio handshake.
      for (const row of probe.models) for (const capability of ["tools", "mcp_tools", "exec", "subagents"]) row.capabilities[capability] = true;
      offlineProbe = probe;
      harness = true; return Response.json({ offlineConnectorInjected: true });
    }
    if (request.method === "GET" && path === "/evidence") {
      const threadId = new URL(request.url).searchParams.get("threadId");
      const binding = threadId ? runtime.state.binding("offline-client", threadId) : null;
      return Response.json({ physicalSends, composerClean, effortsVerified, mcpCalls, mcpResults, binding,
        activeBrowserTurns: chatGptTurnSessions.activeCount(), physicalBrowserWork: chatGptTurnSessions.physicalWorkCount(),
        epoch: runtime.state.profile("fixture").epoch, chromiumVersion: context.browser()?.version(), bunVersion: Bun.version,
        actualMcpStdio: true, outboundOpenAiTunnel: false, realCodex: false, liveChatGpt: false });
    }
    return new Response(null, { status: 404 });
  } });
  console.info("CGW_GATEWAY_FIXTURE_READY");
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
} catch (error) { await close(); throw error; }
