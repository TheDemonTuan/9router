import { describe, it, expect, vi, beforeEach } from "vitest";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";
const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

await import("../translator/registerAll.js");

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeLongDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,200 @@"];
  for (let i = 0; i < 200; i++) lines.push(`+added line ${i} UNIQUE_PADDING_${i} ${"x".repeat(20)}`);
  return lines.join("\n");
}

describe("token savers on Cursor (pre-translate RTK)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url) => { throw new Error(`unexpected fetch: ${url}`); });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api2.cursor.sh/agent",
      headers: {},
      transformedBody: null,
    });
  });


  for (const header of ["x-9router-token-saver", "x-9r-token-saver"]) {
    it(`keeps tool content and system prompt unchanged with ${header}: off`, async () => {
      const diff = makeLongDiff();
      const body = { model: "cu/default", stream: false, messages: [
        { role: "system", content: "original system" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_keep", type: "function", function: { name: "Bash", arguments: '{"command":"git diff"}' } }] },
        { role: "tool", tool_call_id: "call_keep", content: diff },
      ] };
      await handleChatCore({
        body, modelInfo: { provider: "cursor", model: "default" },
        credentials: { apiKey: "test-key", providerSpecificData: {} },
        connectionId: "test-conn", rtkEnabled: true,
        cavemanEnabled: true, cavemanLevel: "full", ponytailEnabled: true, ponytailLevel: "full",
        clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { [header]: "off", accept: "application/json" } },
      });
      const dispatched = executeMock.mock.calls[0][0].body;
      const wireText = dispatched.messages.map((message) => message.content || "").join("\n");
      expect(wireText).toContain(diff);
      expect(wireText).toContain("call_keep");
      expect(wireText).toContain("original system");
      expect(wireText).not.toContain(CAVEMAN_PROMPTS.full);
      expect(wireText).not.toContain(PONYTAIL_PROMPTS.full);
      expect(body.messages[2].content).toBe(diff);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }
});
