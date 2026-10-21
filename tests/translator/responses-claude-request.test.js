import { afterEach, describe, expect, it, vi } from "vitest";
import "./registerAll.js";
import "../../open-sse/translator/request/responses-to-claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { responsesToClaudeRequest } from "../../open-sse/translator/request/responses-to-claude.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { sealClaudeReasoning, unsealClaudeReasoning } from "../../open-sse/translator/concerns/claudeContinuation.js";

const model = "claude-sonnet-4-20250514";
const credentials = { apiKey: "test-key", _responsesClaudeContext: { provider: "claude", model, connectionId: "test-account" } };
const context = { provider: "claude", model, credentials };
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const fn = { type: "function", name: "lookup", parameters: schema, strict: true };
const user = { role: "user", content: "question" };
const call = { type: "function_call", call_id: "call_client_id", name: "lookup", arguments: '{"value":"x"}' };
const result = { type: "function_call_output", call_id: call.call_id, output: "answer" };
const request = body => responsesToClaudeRequest(model, body, false, credentials);
const routed = body => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, model, body, false, credentials, "claude");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("direct Responses to Claude requests", () => {
  it("registers the direct route and keeps instructions, developer and system text without synthetic identity", () => {
    const out = routed({ instructions: "instructions", input: [
      { role: "system", content: [{ type: "input_text", text: "system" }] },
      { role: "developer", content: "developer" }, user,
    ] });
    expect(out.system.map(block => block.text)).toEqual(["instructions", "system", "developer"]);
    expect(out.system[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "question" }] }]);
    expect(JSON.stringify(out)).not.toContain("Claude Code");
  });

  it("preserves native remote and base64 images, PDF and text documents", () => {
    const out = routed({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "https://example.com/image.png" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_file", file_data: "data:application/pdf;base64,JVBERg==", filename: "a.pdf" },
      { type: "input_file", file_data: "data:text/plain;base64,aGVsbG8=", filename: "a.txt" },
      { type: "input_file", file_url: "https://example.com/document.pdf" },
    ] }] });
    expect(out.messages[0].content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" }, title: "a.pdf" },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" }, title: "a.txt" },
      { type: "document", source: { type: "url", url: "https://example.com/document.pdf" } },
    ]);
  });

  it("keeps complete function histories, call IDs, parallel results, post-tool assistant text and 4 cache breakpoints", () => {
    const second = { ...call, call_id: "call_second", arguments: '{"value":"y"}' };
    const out = routed({ instructions: "sys", tools: [fn], input: [user, call, second,
      { role: "assistant", content: [{ type: "output_text", text: "after calls" }] },
      { ...result, call_id: second.call_id }, result,
    ] });
    expect(out.messages[1].content).toEqual([
      { type: "tool_use", id: call.call_id, name: "lookup", input: { value: "x" } },
      { type: "tool_use", id: second.call_id, name: "lookup", input: { value: "y" } },
      { type: "text", text: "after calls", cache_control: { type: "ephemeral" } },
    ]);
    expect(out.messages[2].content.map(block => block.tool_use_id)).toEqual([second.call_id, call.call_id]);
    expect(out.messages[2].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(out.tools[0]).toEqual({ name: "lookup", input_schema: schema, strict: true, cache_control: { type: "ephemeral", ttl: "1h" } });
  });

  it("preserves full Fake Claude Code OAuth cloaking (billing header, Claude Code identity, prompt_cache_key session, tool suffix, and CC decoy tools)", () => {
    const oauthCreds = { accessToken: "sk-ant-oat-test-token", connectionId: "cc-account-1", _responsesClaudeContext: { provider: "claude", model, connectionId: "cc-account-1", clientScope: "client-1" } };
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, model, {
      instructions: "Follow repo rules",
      prompt_cache_key: "opencode-session-42",
      tools: [fn],
      tool_choice: { type: "function", name: "lookup" },
      input: [user],
    }, true, oauthCreds, "claude", null, [], "cc-account-1");
    expect(out.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/);
    expect(out.system[1].text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(out.system[2].text).toBe("Follow repo rules");
    expect(out.system[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.metadata?.user_id).toContain('"device_id"');
    expect(out.metadata?.user_id).toContain('"session_id"');
    expect(out.tools[0].name).toBe("lookup_ide");
    expect(out.tools.some(t => t.name === "Bash")).toBe(true);
    expect(out.tools.some(t => t.name === "Read")).toBe(true);
    expect(out.tool_choice).toEqual({ type: "tool", name: "lookup_ide" });
    expect(out._toolNameMap.get("lookup_ide")).toBe("lookup");
  });

  it("wraps free-form custom tools in an exact input:string schema and preserves empty inputs", () => {
    const custom = { type: "custom", name: "shell", description: "Run shell", format: { type: "text" } };
    const out = request({ tools: [custom], tool_choice: { type: "custom", name: "shell" }, parallel_tool_calls: false, input: [
      user, { type: "custom_tool_call", call_id: "custom_id", name: "shell", input: "" },
      { type: "custom_tool_call_output", call_id: "custom_id", output: "ok" },
    ] });
    expect(out.tools[0].input_schema).toEqual({ type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false });
    expect(out._customToolNames).toEqual(["shell"]);
    expect(out.messages[1].content[0]).toEqual({ type: "tool_use", id: "custom_id", name: "shell", input: { input: "" } });
    expect(out.tool_choice).toEqual({ type: "tool", name: "shell", disable_parallel_tool_use: true });
  });

  it.each([
    ["none", { type: "none" }],
    ["required", { type: "any", disable_parallel_tool_use: true }],
    [{ type: "function", name: "lookup" }, { type: "tool", name: "lookup", disable_parallel_tool_use: true }],
    ["auto", { type: "auto", disable_parallel_tool_use: true }],
  ])("maps tool_choice %j without weakening parallel constraints", (tool_choice, expected) => {
    expect(routed({ tools: [fn], input: "q", tool_choice, parallel_tool_calls: false }).tool_choice).toEqual(expected);
  });

  it("uses native output_config.format without appending schema instructions", () => {
    const out = routed({ input: "q", text: { format: { type: "json_schema", name: "answer", schema, strict: true } } });
    expect(out.output_config.format).toEqual({ type: "json_schema", schema });
    expect(out.system).toBeUndefined();
  });

  it.each(["claude-sonnet-4-20250514", "claude-sonnet-4-6"])("keeps native schema while mapping reasoning effort on %s", name => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, name, {
      input: "q", reasoning: { effort: "high" },
      text: { format: { type: "json_schema", schema, strict: true } },
    }, false, { apiKey: "test-key" }, "claude");
    expect(out.output_config.format).toEqual({ type: "json_schema", schema });
    expect(out.thinking).toBeDefined();
  });

  it("keeps the exact client token limit instead of a tool-driven minimum", () => {
    expect(routed({ tools: [fn], input: "q", max_output_tokens: 20 }).max_tokens).toBe(20);
  });
  it("reconciles default max_tokens for max effort while rejecting explicit max_output_tokens below thinking budget", () => {
    const autoCapped = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-4-20250514", {
      input: "q", reasoning: { effort: "max", summary: "auto" },
    }, false, { apiKey: "test-key" }, "claude");
    expect(autoCapped.max_tokens).toBe(64000);
    expect(autoCapped.thinking).toEqual({ type: "enabled", budget_tokens: 62976, display: "summarized" });
    expect(() => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, "claude-opus-4-20250514", {
      input: "q", reasoning: { effort: "high" }, max_output_tokens: 1024,
    }, false, { apiKey: "test-key" }, "claude")).toThrow("must exceed the native thinking budget");
  });


  it("preserves supported multimodal function results", () => {
    const out = request({ input: [user, call, { ...result, output: [
      { type: "input_text", text: "screenshot" }, { type: "input_image", image_url: "https://example.com/shot.png" },
    ] }] });
    expect(out.messages[2].content[0].content).toEqual([
      { type: "text", text: "screenshot" }, { type: "image", source: { type: "url", url: "https://example.com/shot.png" } },
    ]);
  });

  it("rejects model-incompatible images and documents without silently removing them", () => {
    for (const part of [
      { type: "input_image", image_url: "https://example.com/a.png" },
      { type: "input_file", file_data: "data:application/pdf;base64,JVBERg==" },
    ]) {
      expect(() => responsesToClaudeRequest("text-only-test-model", { input: [{ role: "user", content: [part] }] }, false, credentials)).toThrow("for this model");
    }
  });

  it("rejects a provider which would otherwise erase native structured output", () => {
    const body = request({ input: "q", text: { format: { type: "json_schema", schema, strict: true } } });
    expect(() => prepareClaudeRequest(body, "minimax")).toThrow("does not support native structured outputs");
    expect(body.output_config.format.schema).toEqual(schema);
  });

  it.each([
    { previous_response_id: "resp_old" }, { conversation: "conv_1" }, { background: true }, { store: true },
    { tools: [{ type: "web_search" }] }, { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] },
    { tools: [{ type: "custom", name: "shell", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] },
    { tool_choice: { type: "allowed_tools", mode: "auto", tools: [] } },
    { text: { format: { type: "json_object" } } }, { text: { verbosity: "low" } },
    { text: { format: { type: "json_schema", schema, strict: false } } },
    { reasoning: { summary: "invalid_mode" } }, { truncation: "auto" }, { max_tool_calls: 1 },
    { include: ["web_search_call.action.sources"] }, { top_logprobs: 1 },
  ])("rejects unsupported constraints %j with an explicit client error", options => {
    expect(() => request({ input: "q", ...options })).toThrow();
    try { request({ input: "q", ...options }); } catch (error) {
      expect(error.status).toBe(400);
      expect(["invalid_request_error", "unsupported_parameter"]).toContain(error.code);
    }
  });

  it.each([
    { type: "input_image", file_id: "file_openai" },
    { type: "input_image", image_url: "https://example.com/a.png", detail: "high" },
    { type: "input_file", file_id: "file_openai" },
    { type: "input_file", file_data: "data:application/msword;base64,AAAA" },
    { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } },
  ])("rejects nonrepresentable content rather than dropping it: %j", part => {
    expect(() => request({ input: [{ role: "user", content: [part] }] })).toThrow();
  });

  it.each(["{", '{"value":"x"} trailing', "null", "[]", "42", { value: "x" }])("rejects incomplete or nonobject function JSON: %j", argumentsValue => {
    expect(() => request({ input: [user, { ...call, arguments: argumentsValue }, result] })).toThrow();
  });

  it.each([
    [result], [user, call], [user, call, { role: "user", content: "repair it" }],
    [user, call, { ...result, call_id: "missing" }], [user, call, result, result],
    [user, call, { type: "custom_tool_call_output", call_id: call.call_id, output: "wrong kind" }],
    [user, call, { ...call }, result],
    [user, { type: "reasoning", summary: [{ type: "summary_text", text: "unsigned" }] }, { role: "user", content: "next" }],
    [{ role: "assistant", content: "prefill" }],
  ])("rejects missing, duplicate, mismatched or unsigned history: %j", input => {
    expect(() => request({ input })).toThrow();
  });
});

describe("authenticated stateless Claude reasoning continuity", () => {
  const blocks = [
    { type: "thinking", thinking: "native thinking", signature: "native-test-signature" },
    { type: "redacted_thinking", data: "native-opaque-data" },
  ];

  it("returns signed and redacted blocks exactly, without repair or fake signatures", () => {
    const token = sealClaudeReasoning(blocks, context);
    const out = routed({ tools: [fn], input: [user, { type: "reasoning", encrypted_content: token, summary: [] }, call, result] });
    expect(out.messages[1].content.slice(0, 2)).toEqual(blocks);
    expect(unsealClaudeReasoning(token, context)).toEqual(blocks);
    expect(token).not.toContain("native thinking");
  });

  it.each([
    { ...context, provider: "anthropic-compatible-other" },
    { ...context, credentials: { ...credentials, _responsesClaudeContext: { ...credentials._responsesClaudeContext, connectionId: "other" } } },
    { ...context, credentials: { ...credentials, _responsesClaudeContext: { ...credentials._responsesClaudeContext, model: "other-model" } } },
    { ...context, credentials: { ...credentials, _responsesClaudeContext: { ...credentials._responsesClaudeContext, clientScope: "different-client-key" } } },
  ])("rejects a different account/provider/model scope", other => {
    expect(() => unsealClaudeReasoning(sealClaudeReasoning(blocks, context), other)).toThrow("different account");
  });

  it("rejects unknown blobs, tampering and expired continuations", () => {
    const token = sealClaudeReasoning(blocks, context);
    expect(() => unsealClaudeReasoning("openai-opaque-blob", context)).toThrow();
    const pieces = token.split(".");
    pieces[3] = (pieces[3][0] === "a" ? "b" : "a") + pieces[3].slice(1);
    expect(() => unsealClaudeReasoning(pieces.join("."), context)).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(() => unsealClaudeReasoning(token, context)).toThrow("expired");
  });

  it("uses the configured worker secret and rejects a changed key", () => {
    vi.stubEnv("CLAUDE_CONTINUATION_SECRET", "secret-for-test-workers-at-least-32-chars");
    const token = sealClaudeReasoning(blocks, context);
    expect(unsealClaudeReasoning(token, context)).toEqual(blocks);
    vi.stubEnv("CLAUDE_CONTINUATION_SECRET", "different-worker-secret-at-least-32-chars");
    expect(() => unsealClaudeReasoning(token, context)).toThrow();
  });
});

describe("shared Chat to Claude semantics", () => {
  it("hoists developer instructions and preserves native strict schema/tool constraints", () => {
    const out = openaiToClaudeRequest(model, {
      messages: [{ role: "developer", content: "developer" }, user],
      tools: [{ type: "function", function: { name: "lookup", parameters: schema, strict: true } }],
      tool_choice: { type: "function", name: "lookup" }, parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
    }, false);
    expect(out.system.map(s => s.text).join("\n")).toContain("developer");
    expect(out.tools[0].strict).toBe(true);
    expect(out.tool_choice).toEqual({ type: "tool", name: "lookup", disable_parallel_tool_use: true });
    expect(out.output_config.format).toEqual({ type: "json_schema", schema });
    expect(out.messages[0].role).toBe("user");
  });

  it.each(["any", "tool"])("rejects unsupported forced choice %s on direct Responses route instead of changing it to auto", type => {
    expect(() => prepareClaudeRequest({ _directResponsesToClaude: true, model: "claude-sonnet-5-5", tool_choice: { type, name: "lookup" }, messages: [] }, "claude")).toThrow("does not support");
  });
});
