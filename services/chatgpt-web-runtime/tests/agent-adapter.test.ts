import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAgentAdapter } from "../src/agent-adapter";
import { AgentTurnBroker } from "../src/agent-turns";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { setupGenericAgentOfflineFixture } from "../scripts/smoke-agent-offline";
import type { AdapterEvent } from "../src/types";

describe("agent adapter lifecycle and event emission", () => {
  test("an already cancelled request aborts before browser submission", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-adapter-test-"));
    const socketPath = join(root, "agent-turns.sock");
    const broker = AgentTurnBroker.forSocket(socketPath);
    await broker.listen();

    try {
      const provider: CodexProviderConfig = {
        adapter: "chatgpt-web",
        baseUrl: "https://chatgpt.com",
        chatgptWeb: {
          profileId: "p1",
          profileEpoch: "e1",
          clientId: "c1",
          brokerSocketPath: join(root, "native.sock"),
          browserProfilePath: join(root, "browser"),
          localToolsEnabled: false,
        },
      };

      const adapter = createChatGptWebAgentAdapter(provider, {
        requestId: "r1",
        profileId: "p1",
        profileEpoch: "e1",
        model: "chatgpt-web/gpt-5.6-sol",
        socketPath,
      });

      // Verify immediate abort handling
      const abortController = new AbortController();
      abortController.abort(new DOMException("Cancelled immediately", "AbortError"));

      const parsed: CodexParsedRequest = parseRequest({
        model: "chatgpt-web/gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: "test" }],
      });

      let abortThrew = false;
      try {
        await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: abortController.signal }, () => {});
      } catch (err) {
        abortThrew = true;
        expect(err instanceof DOMException && err.name === "AbortError").toBe(true);
      }
      expect(abortThrew).toBe(true);
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

});

describe.skipIf(!process.env.CGW_CHROMIUM_EXECUTABLE)("actual generic browser boundaries", () => {
  test("a requested Pro family cannot run the current Sol family", async () => {
    const f = await setupGenericAgentOfflineFixture({ chromeExecutable: process.env.CGW_CHROMIUM_EXECUTABLE, profileId: "family-fixture" });
    const context = await f.manager.ensureContext();
    let sends = 0;
    await context.exposeBinding("observeFamilySend", () => { sends++; });
    await context.addInitScript(() => document.addEventListener("submit", () => Reflect.get(window, "observeFamilySend")(), true));
    try {
      f.provider.chatgptWeb!.proAvailable = true;
      const adapter = createChatGptWebAgentAdapter(f.provider, { requestId: "pro-request", profileId: f.scope.profileId, profileEpoch: f.scope.profileEpoch, model: "chatgpt-web/gpt-6-pro", socketPath: f.agentBrokerSocket });
      const parsed = parseRequest({ model: "chatgpt-web/gpt-6-pro", input: "Offline exact-family request" });
      parsed.modelId = "gpt-5.6-sol";parsed.options.reasoning = "high";parsed._chatgptModelFamily = "6";
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.find(event => event.type === "error")).toMatchObject({ code: "model_version_unavailable" });
      expect(sends).toBe(0);
      expect(f.manager.isIdle).toBe(true);
    } finally { await f.close(); }
  }, 60_000);

  test("revocation aborts a generating browser turn and settles its physical slot", async () => {
    const f = await setupGenericAgentOfflineFixture({ chromeExecutable: process.env.CGW_CHROMIUM_EXECUTABLE, profileId: "expiry-fixture" });
    const context = await f.manager.ensureContext();
    const submitted = Promise.withResolvers<void>();
    await context.exposeBinding("observeExpirySend", () => submitted.resolve());
    await context.addInitScript(() => {
      Reflect.set(window, "__cgwAgentBatch", { calls: [], answer: "Held fixture", delayMs: 30000 });
      document.addEventListener("submit", () => Reflect.get(window, "observeExpirySend")(), true);
    });
    try {
      const adapter = createChatGptWebAgentAdapter(f.provider, { requestId: "expiry-request", profileId: f.scope.profileId, profileEpoch: f.scope.profileEpoch, model: "chatgpt-web/gpt-5.6-sol", socketPath: f.agentBrokerSocket });
      const parsed = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", input: "Offline revocation fixture", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }] });
      parsed.modelId = "gpt-5.6-sol";parsed.options.reasoning = "high";parsed._chatgptModelFamily = "5.6";
      const events: AdapterEvent[] = [];
      const run = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
      await submitted.promise;
      expect(f.manager.activeTurns).toBe(1);
      await f.agentBroker.close();await run;
      expect(events.find(event => event.type === "error")).toMatchObject({ code: "agent_request_expired" });
      expect(f.manager.isIdle).toBe(true);
    } finally { await f.close(); }
  }, 60_000);

  test("five physical turns reject a sixth before Send and retain cancelled slots until settlement", async () => {
    const f = await setupGenericAgentOfflineFixture({ chromeExecutable: process.env.CGW_CHROMIUM_EXECUTABLE, profileId: "capacity-fixture" });
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const pending: Promise<unknown>[] = [];
    let sends = 0;
    const submitted = Promise.withResolvers<void>();
    try {
      const context = await f.manager.ensureContext();
      await context.exposeBinding("observeCapacitySend", () => { if (++sends === 5) submitted.resolve(); });
      await context.addInitScript(() => {
        Reflect.set(window, "__cgwAgentBatch", { calls: [], answer: "Held fixture", delayMs: 300000 });
        document.addEventListener("submit", () => Reflect.get(window, "observeCapacitySend")(), true);
      });
      const launch = async (index: number, signal?: AbortSignal) => {
        const adapter = createChatGptWebAgentAdapter(f.provider, { requestId: `capacity-${index}`, profileId: f.scope.profileId, profileEpoch: f.scope.profileEpoch, model: "chatgpt-web/gpt-5.6-sol", effort: "high", socketPath: f.agentBrokerSocket });
        const parsed = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", input: "Hold offline capacity fixture", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }], tool_choice: "none" });
        parsed.modelId = "gpt-5.6-sol"; parsed.options.reasoning = "high"; parsed._chatgptModelFamily = "5.6";
        const events: AdapterEvent[] = [];
        await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: signal }, event => events.push(event));
        return events;
      };
      for (let index = 0; index < controllers.length; index++) {
        const controller = controllers[index]!;
        pending.push(launch(index, controller.signal).catch(error => { expect(controller.signal.aborted).toBe(true); return error; }));
      }
      await submitted.promise;
      expect(f.manager.activeTurns).toBe(5);
      const sixth = await launch(5);
      expect(sixth.find(event => event.type === "error")).toMatchObject({ code: "concurrency_limit" });
      expect(sends).toBe(5);
      controllers[0]!.abort();
      expect(f.manager.activeTurns).toBe(5);
      await pending[0];
      expect(f.manager.activeTurns).toBe(4);
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
      expect(f.manager.isIdle).toBe(true);
      expect(sends).toBe(5);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending); await f.close();
    }
  }, 60000);
});
