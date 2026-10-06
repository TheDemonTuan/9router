import { describe, expect, mock, spyOn, test } from "bun:test";
import { BrowserRequestError, validateBrowserChatRequest, validateBrowserResponsesRequest } from "../browser-request.js";
import { PROTOCOL_VERSION, PUBLIC_PATHS, RUNTIME_PATHS, canonicalPublicPath } from "../protocol.js";
import { startRuntime, validateBrowserRuntimeEnvelope } from "../src/server";
import { sha256 } from "../src/authority";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserProviderConfig, DEFAULT_PROFILE_SETTINGS } from "../src/config";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { brokerWorkSnapshot } from "../src/adapters/chatgpt-web/turn-broker";
import { buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { randomUUID } from "node:crypto";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";

function parsedBrowserFixture(body: Record<string, unknown>) {
  const capabilities = { solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const normalized = validateBrowserResponsesRequest(body);
  const route = requireChatGptWebModelRoute(normalized.model, capabilities, "high");
  const parsed = parseRequest(normalized);
  parsed._chatgptEffectiveModelIdentity = { routeId: route.slug, browserFamily: route.modelFamily || route.backendModel, reasoning: "high" };
  parsed._chatgptModelFamily = route.modelFamily;
  parsed.modelId = route.backendModel; parsed.options.reasoning = route.adapterEffort;
  return parsed;
}

const model = "chatgpt-web/gpt-5.6-sol";
const envelope = (request: Record<string, unknown>) => ({ protocolVersion: PROTOCOL_VERSION, profileId: "fixture", profileEpoch: "epoch-1",
  request, effectiveModel: model, effectiveReasoning: "high", transformedRequestSha256: sha256(JSON.stringify(request)) });

describe("Browser-only request contract", () => {
  test("keeps complete history, every instruction and text verbosity without mutating input", () => {
    const request = { model, instructions: "Follow all instructions", stream: false, reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "low", format: { type: "text" } },
      input: [{ role: "system", content: "First instruction" }, { role: "developer", content: "Second instruction" },
        { role: "user", content: "Earlier user" }, { role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] }, { role: "user", content: "Latest user" }] };
    const before = JSON.stringify(request);
    const normalized = validateBrowserResponsesRequest(request);
    expect(JSON.stringify(request)).toBe(before);
    expect(normalized.input.map(item => item.type === "message" ? item.content[0].text : undefined)).toEqual(["First instruction", "Second instruction", "Earlier user", "Earlier answer", "Latest user"]);
    expect(normalized.instructions).toBe("Follow all instructions");
    const parsed = parseRequest(normalized);
    expect(parsed.context.systemPrompt).toEqual(["Follow all instructions", "First instruction"]);
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const compiled = compileChatGptWebPrompt(parsed, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false });
    for (const text of ["Follow all instructions", "First instruction", "Second instruction", "Earlier user", "Earlier answer", "Latest user"]) expect(compiled.text).toContain(text);
    expect(compiled.text.indexOf("Earlier user")).toBeLessThan(compiled.text.indexOf("Earlier answer"));
    expect(compiled.text.indexOf("Earlier answer")).toBeLessThan(compiled.text.indexOf("Latest user"));
    expect(normalized.text?.verbosity).toBe("low");
  });
  test("normalizes string input and safe converter defaults", () => {
    expect(validateBrowserResponsesRequest({ model, input: "hello", instructions: "", store: false, stream: true, tools: [], tool_choice: "none", parallel_tool_calls: false }))
      .toEqual({ model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }], instructions: "", store: false, stream: true });
  });
  test("validates Chat before translation while preserving instruction messages", () => {
    const normalized = validateBrowserChatRequest({ model, messages: [{ role: "system", content: "a" }, { role: "developer", content: "b" }, { role: "user", content: [{ type: "text", text: "hello" }] }],
      n: 1, reasoning_effort: "high", stream_options: { include_usage: true }, metadata: { tag: "ignored" }, user: "ignored", prompt_cache_key: "ignored" });
    expect(normalized.messages).toHaveLength(3);
    expect(normalized.reasoning_effort).toBe("high");
    expect(normalized.stream_options?.include_usage).toBe(true);
    for (const key of ["n", "metadata", "user", "prompt_cache_key"]) expect(normalized).not.toHaveProperty(key);
  });
  for (const field of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "max_output_tokens", "stop", "presence_penalty", "frequency_penalty", "previous_response_id", "conversation", "authority", "cwd", "roots", "environment", "pathFlavor", "clientId", "nativeTurnId", "_compact", "_chatgptTurnIdentity", "include", "unknownSemanticField"]) {
    test(`rejects unsupported ${field}`, () => {
      expect(() => validateBrowserResponsesRequest({ model, input: "hello", [field]: "not-supported" })).toThrow(BrowserRequestError);
      expect(() => validateBrowserChatRequest({ model, messages: [{ role: "user", content: "hello" }], [field]: "not-supported" })).toThrow(BrowserRequestError);
    });
  }
  for (const content of [null, [{ type: "image_url", image_url: { url: "https://invalid.example" } }], [{ type: "text", text: { nested: true } }], [{ type: "text", text: "hello", authority: {} }]]) {
    test(`rejects nontext Chat content ${JSON.stringify(content)}`, () => {
      expect(() => validateBrowserChatRequest({ model, messages: [{ role: "user", content }] })).toThrow(BrowserRequestError);
    });
  }
  test("rejects native items, wrong-role blocks, tool and structured output semantics", () => {
    for (const input of [[{ type: "function_call", name: "run", arguments: "{}" }], [{ role: "user", content: [{ type: "output_text", text: "hello" }] }], [{ role: "tool", content: "hello" }]]) {
      expect(() => validateBrowserResponsesRequest({ model, input })).toThrow(BrowserRequestError);
    }
    for (const extra of [{ tools: [{ type: "function" }] }, { tools: [{ type: "web_search" }] }, { tool_choice: "required" }, { parallel_tool_calls: "true" }, { store: true }, { text: { format: { type: "json_object" } } }, { reasoning: { effort: "none" } }]) {
      expect(() => validateBrowserResponsesRequest({ model, input: "hello", ...extra })).toThrow(BrowserRequestError);
    }
    expect(() => validateBrowserChatRequest({ model, messages: [{ role: "user", content: "hello" }], reasoning: { effort: "low" }, reasoning_effort: "high" })).toThrow(BrowserRequestError);
    expect(() => validateBrowserChatRequest({ model, messages: [{ role: "user", content: "hello" }], n: 2 })).toThrow(BrowserRequestError);
  });
  test("requires nonempty user text and valid benign metadata types", () => {
    for (const input of ["", "  ", [], [{ role: "assistant", content: "hello" }]]) expect(() => validateBrowserResponsesRequest({ model, input })).toThrow(BrowserRequestError);
    for (const extra of [{ metadata: { invalid: 3 } }, { user: {} }, { prompt_cache_key: false }, { stream: "true" }]) {
      expect(() => validateBrowserResponsesRequest({ model, input: "hello", ...extra })).toThrow(BrowserRequestError);
    }
  });
  test("accepts standard functions and reordered results without altering long IDs or JSON", () => {
    const ids = ["x".repeat(64) + "a", "x".repeat(64) + "b"];
    const args = '{"text":"héllo \\"world\\""}';
    const request = { model, tools: [{ type: "function", name: "Read", strict: null }], tool_choice: { type: "function", name: "Read" }, parallel_tool_calls: false,
      input: [{ role: "user", content: "read" }, ...ids.map(call_id => ({ type: "function_call", id: "item_" + call_id, status: "completed", call_id, name: "OldRead", arguments: args })),
        ...ids.toReversed().map(call_id => ({ type: "function_call_output", call_id, output: [{ type: "output_text", text: "result" }] })),
        { type: "message", role: "assistant", status: "completed", id: "message_1", content: [{ type: "output_text", text: "done", annotations: [], logprobs: null }] }] };
    const normalized = validateBrowserResponsesRequest(request);
    expect(normalized.tools).toEqual([{ type: "function", name: "Read", parameters: { type: "object", properties: {} } }]);
    expect(normalized.input.slice(1, 3)).toEqual(ids.map(call_id => ({ type: "function_call", call_id, name: "OldRead", arguments: args })));
    expect(normalized.tool_choice).toEqual({ type: "function", name: "Read" });
    const chat = validateBrowserChatRequest({ model, tools: [{ type: "function", function: { name: "Read" } }], messages: [{ role: "user", content: "read" },
      { role: "assistant", tool_calls: ids.map(id => ({ id, type: "function", function: { name: "Read", arguments: "{}" } })) },
      ...ids.toReversed().map(tool_call_id => ({ role: "tool", tool_call_id, content: "result" }))] });
    expect(chat.messages[1].content).toBeNull();
    expect(chat.messages[1].tool_calls?.map(call => call.id)).toEqual(ids);
    expect(chat.tool_choice).toBe("auto");
    expect(chat.parallel_tool_calls).toBe(true);
  });
  test("rejects ambiguous or incomplete client histories and malformed declarations", () => {
    const call = { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" };
    const result = { type: "function_call_output", call_id: "call_1", output: "ok" };
    const user = { role: "user", content: "read" };
    for (const history of [[user, call], [user, result], [user, call, call, result], [user, call, result, result], [user, call, user, result], [user, { ...call, arguments: "[]" }, result]]) {
      expect(() => validateBrowserResponsesRequest({ model, input: history })).toThrow(BrowserRequestError);
    }
    for (const tools of [[{ type: "function", name: "bad name" }], [{ type: "function", name: "Read", parameters: [] }], [{ type: "function", name: "Read" }, { type: "function", name: "Read" }]]) {
      expect(() => validateBrowserResponsesRequest({ model, input: "read", tools })).toThrow(BrowserRequestError);
    }
    expect(() => validateBrowserResponsesRequest({ model, input: "read", tools: [{ type: "function", name: "Read" }], tool_choice: { type: "function", name: "Exec" } })).toThrow(BrowserRequestError);
  });
});

describe("Browser-only transport boundary", () => {
  test("is an internal data path, never a companion public path", () => {
    expect(RUNTIME_PATHS.browserResponses).toBe("/v1/browser/responses");
    expect(Object.values(PUBLIC_PATHS)).not.toContain(RUNTIME_PATHS.browserResponses);
    expect(() => canonicalPublicPath(RUNTIME_PATHS.browserResponses)).toThrow();
  });
  test("checks original serialized integrity before normalization", () => {
    const value = envelope({ model, input: "hello", tools: [] });
    const validated = validateBrowserRuntimeEnvelope(value, "fixture");
    expect(validated.request).not.toHaveProperty("tools");
    expect(validated.transformedRequestSha256).toBe(value.transformedRequestSha256);
    expect(() => validateBrowserRuntimeEnvelope({ ...value, transformedRequestSha256: "wrong" }, "fixture")).toThrow("integrity");
  });
  test("requires exact header, envelope keys, model and effort", () => {
    const value = envelope({ model, input: "hello", reasoning: { effort: "high" } });
    for (const header of [null, "other"]) expect(() => validateBrowserRuntimeEnvelope(value, header)).toThrow("mismatch");
    for (const profileId of ["INVALID", "../fixture", "", null, 7]) expect(() => validateBrowserRuntimeEnvelope({ ...value, profileId }, "fixture")).toThrow("profile");
    for (const key of ["authority", "clientId", "threadId", "turnId", "pathFlavor"]) expect(() => validateBrowserRuntimeEnvelope({ ...value, [key]: "injected" }, "fixture")).toThrow("envelope");
    expect(() => validateBrowserRuntimeEnvelope({ ...value, effectiveModel: "chatgpt-web/other" }, "fixture")).toThrow("mismatch");
    expect(() => validateBrowserRuntimeEnvelope({ ...value, effectiveReasoning: "low" }, "fixture")).toThrow("mismatch");
  });
  test("actual runtime HTTP separates bearers and rejects unready, Full, stale epoch and fenced requests before Send", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-browser-http-"));
    const runtime = startRuntime({ dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: join(root, "absent-chromium"),
      runtimeToken: Buffer.from("fixture-data-token-is-not-a-real-secret"), adminToken: Buffer.from("fixture-admin-token-is-not-a-real-secret") });
    const run = spyOn(ChatGptBrowserWorker.prototype, "run");
    try {
      await runtime.initialized;
      const profile = runtime.state.createProfile("fixture");
      const value = { ...envelope({ model, input: "No Send" }), profileEpoch: profile.epoch };
      const base = `http://127.0.0.1:${runtime.server.port}`;
      const send = (body: unknown, token = "fixture-data-token-is-not-a-real-secret") => fetch(`${base}/v1/browser/responses`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-cgw-profile-id": "fixture" }, body: JSON.stringify(body),
      });
      expect((await send(value, "fixture-admin-token-is-not-a-real-secret")).status).toBe(401);
      expect((await fetch(`${base}/admin/profiles`, { headers: { authorization: "Bearer fixture-data-token-is-not-a-real-secret" } })).status).toBe(401);
      const unready = await send(value);
      expect(unready.status).toBeGreaterThanOrEqual(400);
      expect((await unready.json()).error.code).toBe("login_required");
      const stale = await send({ ...value, profileEpoch: "stale" });
      expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("profile_epoch_mismatch");
      runtime.state.patchProfile("fixture", profile.revision, { ...profile.settings, mode: "full" });
      const full = await send(value);
      expect(full.status).toBe(400); expect((await full.json()).error.code).toBe("codex_authority_required");
      runtime.state.drain("fixture-fence");
      const fenced = await send(value);
      expect(fenced.status).toBe(503); expect((await fenced.json()).error.code).toBe("runtime_draining");
      expect(runtime.state.acceptedRequestCount()).toBe(0);
      expect(run).not.toHaveBeenCalled();
    } finally { run.mockRestore(); await runtime.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Request-local browser adapter lifecycle", () => {
  test("client decisions buffer private transport and emit only validated calls after retirement", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-client-decision-"));
    const before = brokerWorkSnapshot();
    try {
      let answer = JSON.stringify({ content: "checking", tool_calls: [{ name: "Read", arguments: { path: "fixture.mjs" } }] });
      spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
        await turn.prepare(); turn.onSendActivated?.(); turn.onSubmitted?.();
        turn.onTextDelta?.(answer.slice(0, 20)); await Promise.resolve(); turn.onTextDelta?.(answer.slice(20));
        return answer;
      });
      for (const valid of [true, false]) {
        if (!valid) answer = JSON.stringify({ content: null, tool_calls: [{ name: "Read", arguments: { path: 42 } }] });
        const requestId = randomUUID();
        const provider = browserProviderConfig({ profileId: `fixture-${randomUUID()}`, profileEpoch: "epoch", requestId, settings: DEFAULT_PROFILE_SETTINGS,
          capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false }, dataDir: root, contextWindow: 128000 });
        const request = parsedBrowserFixture({ model, input: "read", tools: [{ type: "function", name: "Read", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }] });
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider, { browserRequestId: requestId }).runTurn!(request, { headers: new Headers() }, event => {
          if (event.type === "done") expect(chatGptTurnSessions.physicalWorkCount()).toBe(0);
          events.push(event);
        });
        expect(events.filter(event => event.type === "text_delta")).toEqual(valid ? [{ type: "text_delta", text: "checking" }] : []);
        if (valid) {
          expect(events.find(event => event.type === "done")).toMatchObject({ stopReason: "tool_use", endTurn: false });
          expect(buildResponseJSON(events, model).output).toContainEqual(expect.objectContaining({ type: "function_call", name: "Read", arguments: '{"path":"fixture.mjs"}' }));
        } else {
          expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
          expect(events.find(event => event.type === "error")).toMatchObject({ code: "browser_tool_output_invalid", retryable: false });
        }
        expect(chatGptTurnSessions.physicalWorkCount()).toBe(0);
      }
      expect(brokerWorkSnapshot()).toEqual(before);
    } finally { mock.restore(); await closeChatGptBrowserWorkers(); rmSync(root, { recursive: true, force: true }); }
  });
  test("fresh identities compile independent complete histories and physically retire on success", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-browser-isolation-"));
    const profileId = `fixture-${randomUUID()}`;
    const prompts: string[] = [], traces: string[] = [];
    const before = brokerWorkSnapshot();
    try {
      spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
        const prepared = await turn.prepare();
        prompts.push(prepared.text); traces.push(turn.traceId);
        expect(turn.conversationKey).toBeUndefined();
        expect(turn.prepareResume).toBeUndefined();
        expect(turn.captureLunaCheckpoint).not.toBe(true);
        turn.onSendActivated?.(); turn.onSubmitted?.();
        turn.onTextDelta?.("Fixture "); turn.onTextDelta?.("answer");
        return "Fixture answer";
      });
      for (const [requestId, history] of [["one", "history A"], ["two", "history B"]]) {
        const provider = browserProviderConfig({ profileId, profileEpoch: "epoch", requestId, settings: DEFAULT_PROFILE_SETTINGS,
          capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false }, dataDir: root, contextWindow: 128000 });
        expect(provider.chatgptWeb).not.toHaveProperty("verifiedEnvironment");
        expect(provider.chatgptWeb).not.toHaveProperty("pathFlavor");
        const parsed = parsedBrowserFixture({ model, instructions: "all instructions", input: [{ role: "user", content: history }, { role: "assistant", content: "earlier answer" }, { role: "user", content: "same latest prompt" }] });
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider, { browserRequestId: requestId }).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
        const response = buildResponseJSON(events, model);
        expect(response.status).toBe("completed");
        const outputText = (response.output as { content?: { type: string; text?: string }[] }[]).flatMap(item => item.content || [])
          .filter(part => part.type === "output_text").map(part => part.text).join("");
        expect(outputText).toBe("Fixture answer");
        expect(chatGptTurnSessions.activeCount()).toBe(0);
        expect(chatGptTurnSessions.physicalWorkCount()).toBe(0);
      }
      expect(prompts[0]).toContain("history A"); expect(prompts[0]).not.toContain("history B");
      expect(prompts[1]).toContain("history B"); expect(prompts[1]).not.toContain("history A");
      expect(traces[0]).not.toBe(traces[1]);
      expect(brokerWorkSnapshot()).toEqual(before);
    } finally { mock.restore(); await closeChatGptBrowserWorkers(); rmSync(root, { recursive: true, force: true }); }
  });
  test("HTTP abort cancels immediately but waits for physical settlement without its aborted signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-browser-abort-"));
    const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>();
    let running: Promise<void> | undefined;
    const controller = new AbortController();
    try {
      spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
        await turn.prepare();
        turn.abortSignal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
        started.resolve();
        await settle.promise;
        throw new DOMException("Fixture physically cancelled", "AbortError");
      });
      const provider = browserProviderConfig({ profileId: `fixture-${randomUUID()}`, profileEpoch: "epoch", requestId: "abort", settings: DEFAULT_PROFILE_SETTINGS,
        capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false }, dataDir: root, contextWindow: 128000 });
      const parsed = parsedBrowserFixture({ model, input: "hello", tools: [{ type: "function", name: "Read", parameters: { type: "object" } }] });
      let returned = false;
      const events: AdapterEvent[] = [];
      running = createChatGptWebAdapter(provider, { browserRequestId: "abort" }).runTurn!(parsed, { headers: new Headers(), abortSignal: controller.signal }, event => events.push(event))
        .catch(() => {}).finally(() => { returned = true; });
      await started.promise; controller.abort(); await cancelled.promise;
      expect(returned).toBe(false);
      expect(chatGptTurnSessions.physicalWorkCount()).toBeGreaterThan(0);
      settle.resolve(); await running;
      expect(chatGptTurnSessions.physicalWorkCount()).toBe(0);
      expect(chatGptTurnSessions.activeCount()).toBe(0);
      expect(events.some(event => event.type === "completed" || event.type === "tool_call_done")).toBe(false);
    } finally { controller.abort(); settle.resolve(); await running?.catch(() => {}); mock.restore(); await closeChatGptBrowserWorkers(); rmSync(root, { recursive: true, force: true }); }
  });
  test("pre-aborted request never starts a browser submission", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-browser-presend-"));
    try {
      const run = spyOn(ChatGptBrowserWorker.prototype, "run");
      const provider = browserProviderConfig({ profileId: `fixture-${randomUUID()}`, profileEpoch: "epoch", requestId: "presend", settings: DEFAULT_PROFILE_SETTINGS,
        capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false }, dataDir: root, contextWindow: 128000 });
      const parsed = parsedBrowserFixture({ model, input: "hello" });
      await expect(createChatGptWebAdapter(provider, { browserRequestId: "presend" }).runTurn!(parsed, { headers: new Headers(), abortSignal: AbortSignal.abort() }, () => {})).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    } finally { mock.restore(); await closeChatGptBrowserWorkers(); rmSync(root, { recursive: true, force: true }); }
  });
  test("a submitted transport failure is terminal, never retries or completes JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-browser-failure-"));
    let attempts = 0;
    try {
      spyOn(ChatGptBrowserWorker.prototype, "run").mockImplementation(async turn => {
        attempts++;
        await turn.prepare();
        turn.onSendActivated?.();
        turn.onTextDelta?.("Partial fixture text");
        throw new Error("Controlled transport loss");
      });
      const provider = browserProviderConfig({ profileId: `fixture-${randomUUID()}`, profileEpoch: "epoch", requestId: "failure", settings: DEFAULT_PROFILE_SETTINGS,
        capabilities: { solAvailable: true, extraHighAvailable: false, proAvailable: false }, dataDir: root, contextWindow: 128000 });
      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider, { browserRequestId: "failure" }).runTurn!(parsedBrowserFixture({ model, input: "hello" }), { headers: new Headers() }, event => events.push(event));
      expect(attempts).toBe(1);
      expect(events.some(event => event.type === "done")).toBe(false);
      expect(events.find(event => event.type === "error")).toMatchObject({ retryable: false, code: "chatgpt_submission_ambiguous" });
      expect(buildResponseJSON(events, model).status).toBe("failed");
      expect(chatGptTurnSessions.physicalWorkCount()).toBe(0);
      expect(chatGptTurnSessions.activeCount()).toBe(0);
    } finally { mock.restore(); await closeChatGptBrowserWorkers(); rmSync(root, { recursive: true, force: true }); }
  });
});
