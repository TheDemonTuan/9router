import { describe, it, expect } from "vitest";
import { anchorClaudeCache, normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

const hour = { type: "ephemeral", ttl: "1h" };
const text = (value, cache_control) => ({ type: "text", text: value, ...(cache_control ? { cache_control } : {}) });
const fixture = () => ({ model: "claude-sonnet-4-6", max_tokens: 1024, metadata: { user_id: "client-session" }, tools: [{ name: "lookup", input_schema: { type: "object" } }], system: [text("stable", hour), text("volatile suffix")], messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [text("answer")] }, { role: "user", content: [text("follow-up", hour)] }] });
const marked = body => [ ...(Array.isArray(body.system) ? body.system : []), ...(body.tools || []), ...(body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : [m.content]) ].filter(b => b?.cache_control);

describe("Claude cache ownership", () => {
  it("does not leak generated decoy-tool markers into a later automatic client policy", () => {
    const credentials = { accessToken: "sk-ant-oat-offline-fixture" };
    const managed = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-4-6", {
      messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }, true, credentials, "claude");
    anchorClaudeCache(managed, { apiKey: credentials.accessToken, preserveClientCache: false });
    const body = fixture();
    body.cache_control = hour;
    body.system.forEach(block => delete block.cache_control);
    body.messages.at(-1).content.forEach(block => delete block.cache_control);
    const automatic = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, body.model, body, true, credentials, "claude");
    anchorClaudeCache(automatic, { apiKey: credentials.accessToken, preserveClientCache: true });
    expect(automatic.cache_control).toEqual(hour);
    expect(marked(automatic)).toEqual([]);
  });
  it.each(["claude", "anthropic"])("preserves the client's stable boundary and rolling user TTL on %s", provider => {
    const body = fixture();
    const original = structuredClone(body);
    expect(anchorClaudeCache(body, { provider, apiKey: "sk-ant-oat-offline-fixture" })).toEqual(original);
    const prepared = prepareClaudeRequest(fixture(), provider, "fake-api-key");
    expect(prepared.system).toEqual(original.system);
    expect(prepared.messages.at(-1)).toEqual(original.messages.at(-1));
    expect(marked(prepared)).toHaveLength(2);
    expect(prepared.metadata.user_id).toBe("client-session");
  });
  it("preserves automatic top-level caching without adding explicit breakpoints", () => {
    const body = { cache_control: hour, messages: [{ role: "user", content: "hello" }] };
    expect(anchorClaudeCache(body)).toEqual({ cache_control: hour, messages: [{ role: "user", content: "hello" }] });
  });
  it("keeps markers on bare blocks and folded system blocks", () => {
    const body = { messages: [{ role: "user", content: text("question", hour) }, { role: "system", content: [text("reminder", hour), text("suffix")] }] };
    normalizeClaudePassthrough(body, "claude-sonnet-4-6", { preserveClientCache: true });
    expect(body.messages[0].content).toEqual([text("question", hour), text("reminder", hour), text("suffix")]);
  });
  it("does not silently repair invalid client caching", () => {
    const body = fixture();
    body.tools[0].defer_loading = true;
    body.tools[0].cache_control = hour;
    body.system.push(text("third", hour), text("fourth", hour));
    const original = structuredClone(body);
    expect(anchorClaudeCache(body)).toEqual(original);
    expect(marked(body)).toHaveLength(5);
  });
  it.each([["sk-ant-oat-offline-fixture", hour], ["fake-api-key", { type: "ephemeral" }]])("uses one retention for all generated anchors with %s", (apiKey, expected) => {
    const body = fixture();
    body.system.forEach(b => delete b.cache_control);
    body.messages.at(-1).content.forEach(b => delete b.cache_control);
    const out = anchorClaudeCache(body, { provider: "claude", apiKey });
    expect(marked(out)).toHaveLength(4);
    expect(marked(out).every(b => JSON.stringify(b.cache_control) === JSON.stringify(expected))).toBe(true);
    expect(out.messages.at(-1).content[0].cache_control).toEqual(expected);
  });
  it("caches first-turn strings but skips deferred tools and thinking-only turns", () => {
    const body = { system: "stable", tools: [{ name: "later", defer_loading: true }], messages: [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "thinking", thinking: "private" }] }] };
    anchorClaudeCache(body);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined();
  });
  it("rebuilds generated anchors after the final payload changes", () => {
    const body = { system: [text("head")], messages: [{ role: "user", content: "first" }] };
    anchorClaudeCache(body, { preserveClientCache: false });
    body.system.push(text("post-saver"));
    anchorClaudeCache(body, { preserveClientCache: false });
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
  });
  it("captures client provenance before same-format preparation", () => {
    const original = fixture();
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, original.model, structuredClone(original), true, { apiKey: "fake-api-key" }, "claude");
    expect(out.system).toEqual(original.system);
    expect(out.messages.at(-1)).toEqual(original.messages.at(-1));
  });
});
