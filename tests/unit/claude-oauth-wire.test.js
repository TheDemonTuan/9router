// Claude OAuth wire parity: final-body CCH, cc_version build fingerprint,
// per-account identity, and explicit top_p rejection under active thinking.
// CCH and fingerprint vectors are CLIProxyAPI's Claude Code captures
// (claude_signing_test.go, claude_cloaked_cache_repro_test.go).
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { applyCloaking, signClaudeBody } from "../../open-sse/utils/claudeCloaking.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const BASE = `{"model":"model-a","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"tools":[],"metadata":{"user_id":"meta-x"},"max_tokens":1,"thinking":{"type":"adaptive","display":"omitted"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"stream":true}`;
const cch = (json) => /cch=([0-9a-f]{5});/.exec(JSON.parse(json).system[0].text)[1];
const OAUTH = "sk-ant-oat01-placeholder";

describe("signClaudeBody matches Claude Code 2.1.220 vectors", () => {
  it.each([
    ["base", BASE, "7ee87"],
    ["model value ignored", BASE.replace(`"model":"model-a"`, `"model":"model-b"`), "7ee87"],
    ["max_tokens ignored", BASE.replace(`"max_tokens":1`, `"max_tokens":2`), "7ee87"],
    ["message changes hash", BASE.replace(`"text":"x"`, `"text":"y"`), "b9cc8"],
    ["metadata changes hash", BASE.replace(`"user_id":"meta-x"`, `"user_id":"meta-y"`), "7a89d"],
    ["trailing dispatch run keeps the native comma", BASE.replace(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]}`), "4589b"],
    ["model before trailing dispatch run", BASE.replace(`"metadata":{"user_id":"meta-x"}`, `"metadata":{"user_id":"meta-x","model":"nested-model","max_tokens":999,"fallbacks":[{"model":"fallback-model"}],"fallback_credit_token":"not-a-real-token"}`), "2d312"],
    ["billing block only", `{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"}]}`, "f2edb"],
  ])("%s", (_, body, want) => {
    expect(cch(signClaudeBody(body))).toBe(want);
  });

  it("re-signs stale client digits and changes no other byte", () => {
    const literal = "keep literal cch=00000; in the message";
    const body = BASE.replace(`"text":"x"`, `"text":"${literal}"`);
    const signed = signClaudeBody(body.replace("sdk-cli; cch=00000;", "sdk-cli; cch=abcde;"));
    expect(JSON.parse(signed).messages[0].content[0].text).toBe(literal);
    expect(signed.replace(/sdk-cli; cch=[0-9a-f]{5};/, "sdk-cli; cch=00000;")).toBe(body);
    expect(cch(signed)).toBe(cch(signClaudeBody(body)));
  });
});

describe("cc_version build fingerprint", () => {
  const version = (text) => /cc_version=2\.1\.280\.([0-9a-f]{3});/.exec(applyCloaking({ messages: [{ role: "user", content: text }] }, OAUTH, "s").system[0].text)?.[1];

  it.each([
    ["emoji before sampled positions", "😀abcdefghijklmnopqrstuvwxyz", "dac"],
    ["sampled surrogate half", "abc😀abcdefghijklmnop", "695"],
  ])("%s", (_, text, want) => {
    expect(version(text)).toBe(want);
  });

  it("samples the first real user text, not reminders, and leaves cch as a placeholder", () => {
    const withReminder = applyCloaking({ messages: [{ role: "user", content: [
      { type: "text", text: "<system-reminder>date</system-reminder>" },
      { type: "text", text: "😀abcdefghijklmnopqrstuvwxyz" },
    ] }] }, OAUTH, "s").system[0].text;
    expect(withReminder).toBe("x-anthropic-billing-header: cc_version=2.1.280.dac; cc_entrypoint=sdk-cli; cch=00000;");
  });
});

describe("Claude OAuth executor wire", () => {
  const executor = new DefaultExecutor("claude");
  const clientUserId = '{"device_id":"client-device","account_uuid":"client-account","session_id":"client-session"}';
  const passthrough = () => ({
    model: "claude-opus-5-5", max_tokens: 1024, stream: true,
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli;" }, { type: "text", text: "client system" }],
    metadata: { user_id: clientUserId },
    messages: [{ role: "user", content: "hi" }],
  });
  const identity = (body) => JSON.parse(body.metadata.user_id);

  it("replaces the client's device/account with the routed account and scopes its session", () => {
    const original = passthrough();
    const a = executor.transformRequest("claude-opus-5-5", original, true, { accessToken: OAUTH, connectionId: "conn-a" });
    const refreshed = executor.transformRequest("claude-opus-5-5", passthrough(), true, { accessToken: `${OAUTH}-refreshed`, connectionId: "conn-a" });
    const b = executor.transformRequest("claude-opus-5-5", passthrough(), true, { accessToken: OAUTH, connectionId: "conn-b" });

    expect(original.metadata.user_id).toBe(clientUserId);
    expect(identity(a)).not.toMatchObject({ device_id: "client-device" });
    expect(identity(a).account_uuid).not.toBe("client-account");
    expect(identity(a).session_id).not.toBe("client-session");
    expect(identity(refreshed)).toEqual(identity(a));
    expect(identity(b).device_id).not.toBe(identity(a).device_id);
    expect(identity(b).session_id).not.toBe(identity(a).session_id);

    const headers = executor.buildHeaders({ accessToken: OAUTH, connectionId: "conn-a" }, true, "", "claude-opus-5-5", a);
    expect(headers["x-claude-code-session-id"]).toBe(identity(a).session_id);
  });

  it("restores cch on a client billing header and signs the serialized body", () => {
    const creds = { accessToken: OAUTH, connectionId: "conn-a" };
    const wire = executor.transformRequest("claude-opus-5-5", passthrough(), true, creds);
    expect(wire.system[0].text).toBe("x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;");
    const signed = executor.serializeBody(wire, creds);
    expect(signed.replace(/cch=[0-9a-f]{5};/, "cch=00000;")).toBe(JSON.stringify(wire));
    expect(signClaudeBody(signed)).toBe(signed);
  });

  it("leaves API-key requests unchanged", () => {
    const creds = { apiKey: "sk-ant-api03-placeholder" };
    const wire = executor.transformRequest("claude-opus-5-5", passthrough(), true, creds);
    expect(wire.metadata.user_id).toBe(clientUserId);
    expect(wire.system[0].text).not.toContain("cch=");
    expect(executor.serializeBody(wire, creds)).toBe(JSON.stringify(wire));
  });
});

describe("Responses top_p under active Claude thinking", () => {
  const route = (model, extra) => () => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, model, { input: "q", ...extra }, false, { apiKey: "test-key" }, "claude");

  it("rejects top_p below 0.95 on a model whose thinking cannot be disabled", () => {
    expect(route("claude-opus-5-5", { top_p: 0.5 })).toThrow(expect.objectContaining({ status: 400, param: "top_p" }));
  });

  it("rejects top_p below 0.95 when the client enables thinking", () => {
    expect(route("claude-sonnet-4-6", { top_p: 0.5, reasoning: { effort: "high" } })).toThrow(expect.objectContaining({ status: 400, param: "top_p" }));
  });

  it("accepts top_p at 0.95 with thinking, and any top_p without it", () => {
    expect(route("claude-opus-5-5", { top_p: 0.95 })().top_p).toBe(0.95);
    expect(route("claude-sonnet-4-6", { top_p: 0.5 })().top_p).toBe(0.5);
  });
});
