import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getChatGptWebCatalog: vi.fn(), requestChatGptWebRuntime: vi.fn(), hasChatGptWebModel: (catalog, model) => catalog.models.some(row => row.id === model) }));
vi.mock("open-sse/services/chatgptWebRuntimeClient.js", () => mocks);
const { ChatGPTWebExecutor, isChatGptWebRetryable } = await import("../../open-sse/executors/chatgpt-web.js");
const row = { id: "chatgpt-web/gpt-5.6-sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", capabilities: { native_responses: true, tools: false } };
beforeEach(() => { vi.clearAllMocks(); mocks.getChatGptWebCatalog.mockResolvedValue({ profileId: "fixture", profileEpoch: "epoch", stale: false, models: [row] }); });
it.each([[429, "", "not_sent", 1, false], [429, "quota_exhausted", "not_sent", 1, false], [503, "provider_busy", "not_sent", 1, false], [429, "rate_limited", "sent", 1, false], [429, "rate_limited", "unknown", 1, false], [429, "rate_limited", "not_sent", 0, false], [429, "rate_limited", "not_sent", 1, true], [503, "temporarily_unavailable", "not_sent", 1, true]])("retry %s/%s/%s requires positive proven pre-send evidence", (status, code, submission_state, retry_after, expected) => {
  expect(isChatGptWebRetryable(status, { code, submission_state, retry_after, retryable: true })).toBe(expected);
});
it("unsigned authority, unsupported effort, account epoch mismatch and unverified Full tools stay terminal", async () => {
  const executor = new ChatGPTWebExecutor();
  const authority = { purpose: "responses" };
  for (const [body, credentials, code] of [
    [{ input: [] }, {}, "codex_authority_required"],
    [{ input: [], reasoning: { effort: "xhigh" } }, { chatGptWebAuthority: authority }, "model_version_unavailable"],
    [{ input: [] }, { chatGptWebAuthority: authority, chatGptWebProfileEpoch: "old-epoch" }, "profile_epoch_mismatch"],
    [{ input: [], tools: [{ type: "function", name: "exec" }] }, { chatGptWebAuthority: authority }, "harness_unavailable"],
  ]) {
    const result = await executor.execute({ model: row.id, body, credentials });
    expect(result.response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(await result.response.json()).toMatchObject({ error: { code, retryable: false } });
  }
});
it("transport exception is unknown/nonretryable, never inferred as pre-send from message text", async () => {
  mocks.requestChatGptWebRuntime.mockRejectedValue(new Error("temporarily unavailable rate limit"));
  const result = await new ChatGPTWebExecutor().execute({ model: row.id, body: { input: [] }, credentials: { chatGptWebAuthority: { purpose: "responses" } } });
  expect(result.response.status).toBe(502); expect(await result.response.json()).toMatchObject({ error: { code: "submission_unknown", submission_state: "unknown", retryable: false } });
});
it("unknown 429 and busy wording do not create rate/quota cooldown classifications", () => {
  const executor = new ChatGPTWebExecutor();
  expect(executor.parseError(new Response(null, { status: 429 }), JSON.stringify({ error: { message: "rate limit quota exceeded" } })).errorClass).toBe("runtime_error");
  expect(executor.parseError(new Response(null, { status: 503 }), JSON.stringify({ error: { code: "provider_busy", message: "concurrency limit reached" } })).errorClass).toBe("runtime_error");
  expect(executor.parseError(new Response(null, { status: 429 }), JSON.stringify({ error: { code: "quota_exhausted" } })).errorClass).toBe("quota_exhausted");
});
