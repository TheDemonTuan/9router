import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const seam = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: seam.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map(key => [key, vi.fn()])) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const executor = new CodexExecutor();
let prepared, sent, headers;

function fixture() {
  return {
    model: "gpt-5.5", stream: false,
    reasoning: { effort: "high", summary: "detailed", mode: "pro", context: "current_turn" },
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "base" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", id: "rs_synthetic", encrypted_content: "synthetic-opaque+/==", summary: [] },
      { type: "function_call", id: "fc_synthetic", call_id: "call-synthetic", name: "read_file", arguments: '{"path":"synthetic"}' },
      { type: "function_call_output", call_id: "call-synthetic", output: "synthetic exact result" },
      { type: "item_reference", id: "resp_synthetic" },
    ],
    tools: [
      { type: "custom", name: "synthetic_custom", format: { type: "text" } },
      { type: "namespace", name: "synthetic_namespace", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }] },
      { type: "function", function: { name: "synthetic_flat", parameters: { type: "object", properties: {} } } },
    ],
    text: { format: { type: "json_schema", name: "synthetic", schema: { type: "object", properties: {}, additionalProperties: false }, strict: true } },
    include: ["message.output_text.logprobs"], client_metadata: { synthetic: "keep" }, prompt_cache_key: "synthetic-explicit",
  };
}

beforeEach(() => {
  prepared = sent = headers = null;
  seam.execute.mockReset().mockImplementation(async args => {
    prepared = structuredClone(args.body);
    sent = args.body.input !== undefined || !args.body.messages
      ? executor.transformRequest(args.model, args.body, args.stream, args.credentials)
      : args.body;
    headers = executor.buildHeaders(args.credentials, true, null, args.model, sent, prepared);
    const response = { id: "resp_synthetic", object: "response", status: "completed", model: "synthetic", output: [{ type: "message", id: "msg_synthetic", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return { response: new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } }), url: "https://synthetic.invalid/responses", headers, transformedBody: sent };
  });
});

async function run(body, extra = {}) {
  const original = structuredClone(body);
  const result = await handleChatCore({
    body, modelInfo: { provider: "codex", model: body.model }, credentials: { accessToken: "synthetic", connectionId: "synthetic-connection", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "synthetic-connection",
    rtkEnabled: false, sessionDedupMode: "off", cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
    clientRawRequest: { endpoint: "/v1/responses", body, headers: { accept: "application/json", "user-agent": "omp-test" } }, ...extra,
  });
  const text = await result.response.text();
  expect(body).toEqual(original);
  return { status: result.response.status, text, json: text.startsWith("{") ? JSON.parse(text) : null };
}

describe("non-native Codex Responses preparation", () => {
  it("preserves reasoning siblings, opaque replay and tools through the real canonicalizer", async () => {
    const body = fixture();
    const result = await run(body);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ object: "response", output: [{ content: [{ text: "ok" }] }] });
    expect(sent.reasoning).toEqual(body.reasoning);
    const expected = structuredClone(body.input.slice(0, -1));
    expected[0].role = "developer";
    delete expected[2].id; delete expected[3].id;
    expect(sent.input).toEqual(expected);
    expect(sent.tools.slice(0, 2)).toEqual(body.tools.slice(0, 2));
    expect(sent.tools[2]).toEqual({ type: "function", name: "synthetic_flat", parameters: { type: "object", properties: {} } });
    for (const key of ["text", "client_metadata", "prompt_cache_key"]) expect(sent[key]).toEqual(body[key]);
    expect(sent.include).toEqual([...body.include, "reasoning.encrypted_content"]);
  });
  it("enforces the provider allowlist rather than acting as a raw proxy", async () => {
    const result = await run({ ...fixture(), temperature: 0.5, max_output_tokens: 99, metadata: { synthetic: true }, unknown_synthetic: true, store: true, service_tier: "fast" });
    expect(result.status).toBe(200);
    for (const key of ["temperature", "max_output_tokens", "metadata", "unknown_synthetic"]) expect(sent).not.toHaveProperty(key);
    expect(sent).toMatchObject({ store: false, stream: true, model: "gpt-5.5", service_tier: "priority" });
  });

  for (const [name, model, intent, providerThinking, metadata, effort] of [
    ["suffix wins", "gpt-5.5(high)", { reasoning: { effort: "low" } }, undefined, undefined, "high"],
    ["client wins provider default", "gpt-5.5", { reasoning: { effort: "high" } }, { mode: "low" }, undefined, "high"],
    ["provider level", "gpt-5.5", {}, { mode: "low" }, undefined, "low"],
    ["provider budget", "gpt-5.5", {}, { mode: "on" }, undefined, "medium"],
    ["Lite cannot disable", "gpt-6-luna", {}, { mode: "off" }, undefined, "low"],
    ["catalog default", "gpt-5.5", {}, undefined, { supportedReasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }, "medium"],
    ["top-level effort wins", "gpt-5.5", { reasoning_effort: "low", reasoning: { effort: "high" } }, undefined, undefined, "low"],
    ["output config wins", "gpt-5.5", { output_config: { effort: "medium" }, reasoning_effort: "low", reasoning: { effort: "high" } }, undefined, undefined, "medium"],
  ]) {
    it(`thinking precedence: ${name}`, async () => {
      const result = await run({ model, input: "hello", stream: false, ...intent, reasoning: { ...intent.reasoning, summary: "detailed", mode: "pro", context: "current_turn" } }, {
        providerThinking, credentials: { accessToken: "synthetic", codexModelMetadata: metadata },
      });
      expect(result.status).toBe(200);
      expect(sent.reasoning).toEqual({ effort, summary: "detailed", mode: "pro", context: model === "gpt-6-luna" ? "all_turns" : "current_turn" });
      expect(prepared).not.toHaveProperty("reasoning_effort");
    });
  }

  it("rejects an effort outside the account catalog before dispatch", async () => {
    const result = await run(fixture(), { credentials: { accessToken: "synthetic", codexModelMetadata: { supportedReasoningLevels: ["low", "medium"], defaultReasoningLevel: "medium" } } });
    expect(result.status).toBe(400);
    expect(result.json.error.message).toContain('Unsupported Codex reasoning effort "high"');
    expect(prepared).toBeNull();
  });

  it("removes stale effort for a non-reasoning catalog without hiding canonicalizer failure", async () => {
    const result = await run({ ...fixture(), reasoning_effort: "low" }, { credentials: { accessToken: "synthetic", codexModelMetadata: { supportedReasoningLevels: [], defaultReasoningLevel: "medium" } } });
    expect(prepared.reasoning).toEqual({ summary: "detailed", mode: "pro", context: "current_turn" });
    expect(prepared).not.toHaveProperty("reasoning_effort");
    expect(result.status).toBe(502);
    expect(result.json.error.message).toContain('Unsupported Codex reasoning effort "medium"');
  });

  for (const [field, value, message] of [
    ["previous_response_id", "resp_synthetic", "Codex Responses does not support 'previous_response_id'"],
    ["truncation", "auto", "Codex Responses does not support truncation modes"],
  ]) {
    it(`rejects unsupported ${field} on the original body`, async () => {
      const result = await run({ ...fixture(), [field]: value });
      expect(result.status).toBe(400);
      expect(result.text).toContain(message);
      expect(prepared).toBeNull();
    });
  }
  it("accepts disabled truncation but strips it upstream", async () => {
    expect((await run({ ...fixture(), truncation: "disabled" })).status).toBe(200);
    expect(sent).not.toHaveProperty("truncation");
  });

  for (const [name, input, text] of [["string", "hello", "hello"], ["empty", [], "..."], ["missing", undefined, "..."]]) {
    it(`uses the canonicalizer's ${name} input behavior`, async () => {
      expect((await run({ model: "gpt-5.5", stream: false, ...(input === undefined ? {} : { input }) })).status).toBe(200);
      expect(sent.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text }] }]);
    });
  }

  it("retains native effort against provider overrides", async () => {
    const body = fixture();
    expect((await run(body, { providerThinking: { mode: "low" }, clientRawRequest: { body, headers: { "user-agent": "codex-cli/0.144.1" } } })).status).toBe(200);
    expect(sent.reasoning).toEqual(body.reasoning);
  });

  it("translates Chat Completions into Codex and returns the client's protocol", async () => {
    const result = await run({ model: "gpt-5.5", stream: false, messages: [{ role: "user", content: "hello" }] }, { sourceFormatOverride: FORMATS.OPENAI });
    expect(result.status).toBe(200);
    expect(sent.input[0]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "hello" }] });
    expect(sent).not.toHaveProperty("messages");
    expect(result.json).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "ok" } }] });
  });

  it("keeps generic normalization for another Responses provider", async () => {
    const result = await run(fixture(), { modelInfo: { provider: "openai-compatible-responses-synthetic", model: "gpt-5.5" }, credentials: { apiKey: "synthetic", providerSpecificData: { apiType: "responses" } } });
    expect(result.status).toBe(200);
    expect(prepared.reasoning_effort).toBe("high");
    expect(prepared).not.toHaveProperty("reasoning");
  });

  it("resolves repeat sessions from raw headers and explicit body cache keys", async () => {
    for (let i = 0; i < 2; i++) {
      const body = { model: "gpt-5.5", stream: false, input: "hello" };
      expect((await run(body, { clientRawRequest: { body, headers: { "user-agent": "omp-test", "x-client-request-id": "synthetic-session" } } })).status).toBe(200);
      expect(sent.prompt_cache_key).toBe("synthetic-session");
      expect(headers.session_id).toBe("synthetic-session");
    }
    expect((await run(fixture())).status).toBe(200);
    expect(sent.prompt_cache_key).toBe("synthetic-explicit");
    expect(headers.session_id).toBe("synthetic-explicit");
  });
});
