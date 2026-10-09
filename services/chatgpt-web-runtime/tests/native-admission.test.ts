import { describe, expect, spyOn, test } from "bun:test";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { RuntimeStateError } from "../src/runtime-state";
import { parseRequest } from "../src/responses/parser";
import type { CodexProviderConfig } from "../src/types";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

// Only in-memory mocks: no browser, filesystem, server, timers beyond the adapter's
// synchronously cleared heartbeat, network, authority database or physical worker.
describe("native request admission preserves the existing owner", () => {
  test("late replay rejection is not a submitted owner failure and cannot cancel it", async () => {
    const parsed = parseRequest({ model: "chatgpt-web", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic input" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-fixture" } }], client_metadata: { "x-codex-turn-metadata": { thread_id: "thread-fixture", turn_id: "turn-fixture" } } });
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    parsed._chatgptEffectiveModelIdentity = { routeId: "chatgpt-web/gpt-6-sol", browserFamily: "6", reasoning: "high" };
    parsed._chatgptModelFamily = "6";
    parsed.options.reasoning = "high";
    const environment: ChatGptTurnEnvironment = { cwd: "/fixture", roots: ["/fixture"], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] };
    const provider = { chatgptWeb: { profileId: "fixture", profileEpoch: "epoch", clientId: "client", browserProfilePath: "/fixture/browser", pathFlavor: "posix", verifiedEnvironment: environment, localToolsEnabled: false } } as CodexProviderConfig;
    const namespace = chatGptWebExecutionNamespace(provider);
    let cancelled = 0;
    let executed = 0;
    const session = {
      runtime: { executionNamespace: namespace, effectiveModelIdentity: JSON.stringify(parsed._chatgptEffectiveModelIdentity), resourceAdmission: Promise.resolve(), submission: { phase: "accepted" }, mode: "read-only" },
      cancel: () => { cancelled++; },
      runExclusive: async () => { executed++; },
    } as unknown as ChatGptTurnSession;
    // Effective identity uses a stable tuple, not client metadata or object ordering.
    session.runtime.effectiveModelIdentity = JSON.stringify(["chatgpt-web/gpt-6-sol", "6", "high"]);
    const worker = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({} as ChatGptBrowserWorker);
    const resolve = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolveVerified").mockReturnValue(environment);
    const owner = spyOn(chatGptTurnSessions, "assertOwnerModel").mockImplementation(() => {});
    const lookup = spyOn(chatGptTurnSessions, "getOrCreateAfterOwnerRetirement").mockResolvedValue(session);
    const retire = spyOn(chatGptTurnSessions, "retire").mockReturnValue(false);
    const failure = new RuntimeStateError("authority_replayed", "Synthetic authority was already consumed", 409);
    let rejected: unknown;
    try {
      const adapter = createChatGptWebAdapter(provider, {
        onResourcePreflight: () => {},
        onResourceAdmitted: () => { throw failure; },
        onResourceAdmissionFailed: error => { rejected = error; },
      });
      await expect(adapter.runTurn!(parsed, { headers: new Headers() }, () => {})).rejects.toBe(failure);
      expect(rejected).toBe(failure);
      expect(cancelled).toBe(0);
      expect(executed).toBe(0);
      expect(retire).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      retire.mockRestore(); lookup.mockRestore(); owner.mockRestore(); resolve.mockRestore(); worker.mockRestore();
    }
  });

  test("readonly replay preflight rejects before owner retirement lookup", async () => {
    const parsed = parseRequest({ model: "chatgpt-web", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic input" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-fixture" } }], client_metadata: { "x-codex-turn-metadata": { thread_id: "thread-fixture", turn_id: "turn-fixture" } } });
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    parsed._chatgptEffectiveModelIdentity = { routeId: "chatgpt-web/gpt-6-sol", browserFamily: "6", reasoning: "high" };
    const environment: ChatGptTurnEnvironment = { cwd: "/fixture", roots: ["/fixture"], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] };
    const provider = { chatgptWeb: { profileId: "fixture", profileEpoch: "epoch", clientId: "client", browserProfilePath: "/fixture/browser", pathFlavor: "posix", verifiedEnvironment: environment, localToolsEnabled: false } } as CodexProviderConfig;
    const worker = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue({} as ChatGptBrowserWorker);
    const resolve = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolveVerified").mockReturnValue(environment);
    const lookup = spyOn(chatGptTurnSessions, "getOrCreateAfterOwnerRetirement");
    const failure = new RuntimeStateError("authority_replayed", "Synthetic replay", 409);
    try {
      const adapter = createChatGptWebAdapter(provider, { onResourcePreflight: () => { throw failure; } });
      await expect(adapter.runTurn!(parsed, { headers: new Headers() }, () => {})).rejects.toBe(failure);
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); resolve.mockRestore(); worker.mockRestore(); }
  });
});
