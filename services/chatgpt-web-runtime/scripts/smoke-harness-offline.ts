import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, closeBrowserManagers } from "../src/browser/manager";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { closeTurnBrokers } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { buildResponseJSON } from "../src/bridge";
import { runtimeExecutionScope } from "../src/runtime-scope";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const browser = process.env.CGW_CHROMIUM_EXECUTABLE;
if (!browser) throw new Error("CGW_CHROMIUM_EXECUTABLE is required");
const root = mkdtempSync(join(tmpdir(), "cgw-harness-offline-")); process.env.CGW_DATA_DIR = root;
const scope = { profileId: "fixture", profileEpoch: "epoch", clientId: "client", pathFlavor: "posix" as const };
const brokerSocket = defaultBrokerEndpoint(join(root, "profile"));
const manager = BrowserManager.forProfile({ profileId: scope.profileId, profileEpoch: scope.profileEpoch, browserProfilePath: join(root, "browser"), chromeExecutablePath: browser, headed: false });
const client = new Client({ name: "synthetic-browser-connector", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/chatgpt-web/mcp-main.ts"), "--broker-socket", brokerSocket, "--contract", "native"], stderr: "pipe",
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
try {
  await client.connect(transport);
  const context = await manager.ensureContext();
  await context.exposeBinding("syntheticMcpCall", async (_source, input) => client.callTool(input));
  const html = readFileSync(new URL("../tests/fixtures/chatgpt-runtime.html", import.meta.url), "utf8");
  await context.route("**/*", route => {
    const url = new URL(route.request().url()); if (url.origin !== "https://chatgpt.com") return route.abort();
    return url.pathname === "/api/auth/session" ? route.fulfill({ json: { expires: new Date(Date.now() + 600000).toISOString(), user: { id: "synthetic-account" } } }) : route.fulfill({ body: html, contentType: "text/html" });
  });
  const tools = [{ type: "namespace", name: "fixture", tools: [{ type: "function", name: "read", description: "Read synthetic local file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
    { type: "custom", name: "apply_patch", description: "Apply synthetic local patch", format: { type: "text" } }];
  const metadata = { request_kind: "turn", thread_id: "fixture-thread", turn_id: "fixture-turn", agent_name: "/root", sandbox_mode: "read-only", workspaces: { "/synthetic": {} } };
  const original = { model: "chatgpt-web/gpt-5.6-sol", stream: false, reasoning: { effort: "high" }, tools,
    client_metadata: { "x-codex-turn-metadata": metadata }, input: [{ type: "message", role: "user", id: "fixture-user", content: "Read the synthetic file, apply the harmless synthetic patch, and report both results.", internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id } }] };
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: {
    ...scope, browserProfilePath: join(root, "browser"), headed: false, brokerSocketPath: brokerSocket, localToolsEnabled: true, solAvailable: true, proAvailable: false, extraHighAvailable: false,
    verifiedEnvironment: { cwd: "/synthetic", roots: ["/synthetic"], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] },
  } };
  const prepare = (body: unknown) => {
    const parsed = parseRequest(body); parsed.modelId = "gpt-5.6-sol"; parsed.options.reasoning = "high";
    parsed._chatgptModelFamily = "5.6"; parsed._chatgptEffectiveModelIdentity = { routeId: "chatgpt-web/gpt-5.6-sol", browserFamily: "5.6", reasoning: "high" }; return parsed;
  };
  let body: unknown = original;
  const calls = new Set<string>(); const executed: { id: string; kind: string }[] = [];
  let final: Record<string, unknown> | undefined;
  for (let round = 0; round < 5; round++) {
    const events: AdapterEvent[] = [];
    await runtimeExecutionScope.run({ ...scope, verifiedEnvironment: provider.chatgptWeb!.verifiedEnvironment }, () => createChatGptWebAdapter(provider).runTurn!(prepare(body), { headers: new Headers() }, event => events.push(event)));
    const response = buildResponseJSON(events, original.model, { toolNsMap: new Map([["fixture__read", { namespace: "fixture", name: "read" }]]), freeformToolNames: new Set(["apply_patch"]) });
    if (!Array.isArray(response.output)) throw new Error("Native output missing");
    const toolCalls = response.output.filter(item => item.type === "function_call" || item.type === "custom_tool_call");
    if (!toolCalls.length) { final = response; break; }
    const outputs = toolCalls.map(call => {
      assert(!calls.has(call.call_id), "Delivered call ID was executed twice"); calls.add(call.call_id);
      assert(call.type === "custom_tool_call" ? call.name === "apply_patch" && call.input.includes("synthetic-fixed.txt") : call.namespace === "fixture" && call.name === "read", "Native namespace/freeform identity changed");
      executed.push({ id: call.call_id, kind: call.type });
      return { type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: call.call_id, output: call.type === "custom_tool_call" ? "Synthetic patch applied locally by smoke observer" : "Synthetic file read locally by smoke observer" };
    });
    const prior = body as typeof original;
    body = { ...prior, input: [...prior.input, ...response.output, ...outputs] };
  }
  assert(final?.status === "completed" && executed.length === 2 && executed.some(call => call.kind === "custom_tool_call"), "Full browser/MCP loop did not complete native tool rounds");
  const pageState = await Promise.all(context.pages().map(page => page.evaluate(() => Reflect.get(window, "fixture"))));
  assert(pageState.reduce((sum, state) => sum + (state?.sends || 0), 0) === 1, "Tool-result continuation started another browser response");
  console.info(JSON.stringify({ gate: "offline-browser-mcp-loop", actualChromium: true, actualMcpStdio: true, nativeNamespace: true, freeformPatch: true, outerExecutions: 2, stableCallIds: true, physicalSends: 1, terminal: "completed", realCodex: false, outboundOpenAiTunnel: false, liveChatGpt: false }));
} finally {
  await client.close(); chatGptTurnSessions.clear(); await closeBrowserManagers(); await closeTurnBrokers(); rmSync(root, { recursive: true, force: true });
}
