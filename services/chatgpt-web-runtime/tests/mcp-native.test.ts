import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker, closeTurnBrokers } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { runtimeScopeKey } from "../src/runtime-scope";

test("nested native wait releases its MCP channel and cannot finish a parent before tool/activity settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-native-subagents-"));
  const endpoint = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(endpoint);
  const client = new Client({ name: "synthetic-nested-agent-browser", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/adapters/chatgpt-web/mcp-main.ts"), "--broker-socket", endpoint], stderr: "pipe", env: { CGW_DATA_DIR: root, PATH: process.env.PATH || "" } });
  const environment = (clientId: string, threadId: string): ChatGptTurnEnvironment => ({ cwd: "/synthetic", roots: ["/synthetic"], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, pathFlavor: "posix",
    executionScope: { namespace: runtimeScopeKey({ profileId: "fixture", profileEpoch: "epoch", clientId }), threadId, turnId: "turn" },
    tools: [{ namespace: "multi_agent_v1", name: "wait_agent", description: "Wait for named child", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, timeout_ms: { type: "number" } }, required: ["ids", "timeout_ms"] } },
      { namespace: "fixture", name: "read", description: "Read synthetic", parameters: { type: "object" } }] });
  try {
    await broker.listen(); await client.connect(transport);
    const parent = await broker.register(environment("client", "parent"), undefined, "fixture-parent");
    const child = await broker.register(environment("client", "child"), undefined, "fixture-child");
    const grandchild = await broker.register(environment("client", "grandchild"), undefined, "fixture-grandchild");
    const invalid = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: parent, wire_name: "multi_agent_v1__wait_agent", arguments: { ids: ["child"], timeout_ms: 10000 } } });
    expect(invalid.isError).toBe(true);
    const wait = client.callTool({ name: "codex_tool_call", arguments: { turn_token: parent, wire_name: "multi_agent_v1__wait_agent", arguments: { ids: ["child"], timeout_ms: 30000 } } });
    const childCall = client.callTool({ name: "codex_tool_call", arguments: { turn_token: child, wire_name: "fixture__read", arguments: {} } });
    const grandchildCall = client.callTool({ name: "codex_tool_call", arguments: { turn_token: grandchild, wire_name: "fixture__read", arguments: {} } });
    const [parentBatch, childBatch, grandchildBatch] = await Promise.all([broker.nextToolBatch(parent), broker.nextToolBatch(child), broker.nextToolBatch(grandchild)]);
    expect(parentBatch[0]?.arguments?.timeout_ms).toBe(30000);
    expect(broker.beginCompletionFence(parent)).toBeUndefined();
    broker.completeTool(child, childBatch[0]!.callId, { content: [{ type: "text", text: "child-result" }] });
    broker.completeTool(grandchild, grandchildBatch[0]!.callId, { content: [{ type: "text", text: "grandchild-result" }] });
    expect((await childCall).isError).not.toBe(true); expect((await grandchildCall).isError).not.toBe(true);
    broker.completeTool(parent, parentBatch[0]!.callId, { content: [{ type: "text", text: "child completed" }] });
    expect((await wait).isError).not.toBe(true);
    const fence = broker.beginCompletionFence(parent); expect(typeof fence).toBe("number"); expect(broker.commitCompletionFence(parent, fence!)).toBe(true);
    broker.revoke(parent); broker.revoke(child); broker.revoke(grandchild);
  } finally { await client.close(); await closeTurnBrokers(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
