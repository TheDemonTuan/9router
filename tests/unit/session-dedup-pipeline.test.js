import { describe, it, expect, vi } from "vitest";
import "../translator/registerAll.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {},
  logConvertedResponse() {}, logError() {},
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest() {}, appendRequestLog: async () => {},
  saveRequestDetail: async () => {}, saveRequestUsage: async () => {} }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getTokenSaverSnapshot } = await import("../../open-sse/token-saver/state.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");
const { inspectSource } = await import("../../open-sse/token-saver/sourceWalker.js");
const { detectCacheFence } = await import("../../open-sse/token-saver/cacheFence.js");
const { planSessionDedup, commitSessionDedup } = await import("../../open-sse/token-saver/sessionDedup.js");
function fixture() {
  const messages = [];
  for (let i = 0; i < 6; i++) messages.push(
    { role: "user", content: `turn ${i}` },
    { role: "assistant", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(2048) },
  );
  return { model: "gpt-4o-mini", stream: false, messages };
}
async function run(body, mode) {
  let dispatched;
  execute.mockImplementation(async ({ body: upstream }) => {
    dispatched = structuredClone(upstream);
    return { response: new Response(JSON.stringify({ id: "t", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { headers: { "content-type": "application/json" } }), url: "https://example.test/v1/chat/completions", headers: {}, transformedBody: upstream };
  });
  const result = await handleChatCore({ body, sessionDedupMode: mode,
    modelInfo: { provider: "openai", model: "gpt-4o-mini" }, credentials: { apiKey: "synthetic", providerSpecificData: {} },
    connectionId: "synthetic", rtkEnabled: false, pxpipeEnabled: false,
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
  });
  expect(result.success).toBe(true);
  return dispatched;
}
describe("session dedup dispatch", () => {
  it("keeps the canonical result and recent history raw while shadow only measures", async () => {
    const body = fixture();
    const before = structuredClone(body);
    const shadow = await run(body, "shadow");
    expect(shadow.messages).toEqual(before.messages);
    const active = await run(body, "on");
    expect(body).toEqual(before);
    expect(active.messages[2].content).toBe(before.messages[2].content);
    expect(active.messages[5].content).toMatch(/^\[9router dedup:v1 /);
    expect(active.messages[8].content).toBe(active.messages[5].content);
    for (const i of [11, 14, 17]) expect(active.messages[i]).toEqual(before.messages[i]);
    const stats = getTokenSaverSnapshot().usage;
    expect(stats.wouldDedupResults).toBeGreaterThanOrEqual(2);
    expect(stats.appliedResults).toBeGreaterThanOrEqual(2);
  });
  it.each(["claude", "gemini"]) ("keeps the verified Chat canonical before markers through %s translation", targetFormat => {
    const body = fixture();
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    const translated = translateRequest("openai", targetFormat, targetFormat === "claude" ? "claude-3-5-sonnet" : "gemini-2.5-pro", body, false);
    const commit = commitSessionDedup(translated, { sourceFormat: "openai", finalFormat: targetFormat, sourceIndex: index, plan });
    expect(commit.appliedResults).toBe(2);
    const final = inspectSource(translated, targetFormat);
    const first = targetFormat === "gemini" ? final.results[0].resultContainer.response.result.result : final.results[0].text;
    const second = targetFormat === "gemini" ? final.results[1].resultContainer.response.result.result : final.results[1].text;
    expect(first).toBe("x".repeat(2048));
    expect(second).toMatch(/^\[9router dedup:v1 /);
  });
  it("rejects a missing same-family anchor even if another tool preserved the same text", () => {
    const body = fixture(); const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    const translated = translateRequest("openai", "claude", "claude-3-5-sonnet", body, false);
    translated.messages.splice(2, 1);
    const before = structuredClone(translated);
    const commit = commitSessionDedup(translated, { sourceFormat: "openai", finalFormat: "claude", sourceIndex: index, plan });
    expect(commit.skipReason).toBe("final_correspondence");
    expect(commit.appliedResults).toBe(0);
    expect(translated).toEqual(before);
  });
  it("declines an oversized JSON codec before writing any marker", () => {
    const body = fixture();
    const original = "x".repeat(900_000);
    for (const message of body.messages) if (message.role === "tool") message.content = original;
    const index = inspectSource(body, "openai");
    const plan = planSessionDedup(index, { mode: "on", fence: detectCacheFence(body, index) });
    const translated = translateRequest("openai", "gemini", "gemini-2.5-pro", body, false);
    const result = commitSessionDedup(translated, { sourceFormat: "openai", finalFormat: "gemini", sourceIndex: index, plan });
    expect(result.skipReason).toBe("final_budget");
    expect(result.appliedResults).toBe(0);
    expect(translated.contents[2].parts[0].functionResponse.response.result.result).toBe(original);
  });
});
