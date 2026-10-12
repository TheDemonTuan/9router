/**
 * Muse Spark (Meta Model API) is served by the Responses API. A model that only
 * declares `supportedFormats: ["openai-responses"]` must still be reachable by an
 * OpenAI-format client: the transport must follow the translated body's wire
 * format, otherwise the Responses body (`input`) is POSTed to the default Chat
 * Completions URL and Meta rejects it with `unknown parameter `input``.
 *
 * Second half of the same bug: thinking for the Responses wire must be nested as
 * reasoning.effort, not the Chat-shaped top-level reasoning_effort (Meta rejects
 * `unknown parameter `reasoning_effort``).
 *
 * Repro model: muse/muse-spark-1.3-contributor(xhigh)
 * Ref: https://github.com/decolua/9router/pull/3757
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const seam = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: seam.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map(key => [key, vi.fn()])) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const executor = new DefaultExecutor("muse");
let sent, url;

beforeEach(() => {
  sent = url = null;
  seam.execute.mockReset().mockImplementation(async args => {
    sent = executor.transformRequest(args.model, args.body, args.stream, args.credentials);
    url = executor.buildUrl(args.model, args.stream, 0, args.credentials);
    const response = { id: "resp_muse", object: "response", status: "completed", model: args.model, output: [{ type: "message", id: "msg_muse", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return { response: new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } }), url, headers: {}, transformedBody: sent };
  });
});

describe("Muse Responses wire routing through handleChatCore", () => {
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("serves a non-stream %s client from the Responses endpoint", async sourceFormat => {
    const model = "muse-spark-1.3-contributor(xhigh)";
    const body = sourceFormat === FORMATS.OPENAI
      ? { model, stream: false, messages: [{ role: "user", content: "hi" }] }
      : { model, stream: false, input: "hi" };
    const result = await handleChatCore({
      body, modelInfo: { provider: "muse", model }, credentials: { apiKey: "synthetic", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, connectionId: "muse-synthetic",
      rtkEnabled: false, sessionDedupMode: "off", cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
      sourceFormatOverride: sourceFormat,
    });
    expect(result.response.status).toBe(200);
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(sent.input).toBeDefined();
    expect(sent.messages).toBeUndefined();
    expect(sent.reasoning.effort).toBe("xhigh");
    expect(sent.reasoning_effort).toBeUndefined();
    const json = await result.response.json();
    if (sourceFormat === FORMATS.OPENAI) expect(json.choices[0].message.content).toBe("ok");
    else expect(json.output[0].content[0].text).toBe("ok");
  });
});

describe("Muse Responses thinking wire shape", () => {
  it("writes reasoning.effort (not top-level reasoning_effort) for the Responses wire", () => {
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor(xhigh)", body, "muse", { mode: "level", level: "xhigh" });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("clamps max to xhigh for the Responses wire", () => {
    const body = { input: [] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-spark-1.3", body, "muse", { mode: "level", level: "max" });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("keeps Chat Completions clients on the Chat wire (top-level reasoning_effort)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyThinking(FORMATS.OPENAI, "muse-spark-1.3", body, "muse", { mode: "level", level: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
  });

  it("removes both stale effort encodings when Responses reasoning is disabled", () => {
    const body = { input: [], reasoning_effort: "high", reasoning: { effort: "high" } };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-spark-1.3", body, "muse", { mode: "off" });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
