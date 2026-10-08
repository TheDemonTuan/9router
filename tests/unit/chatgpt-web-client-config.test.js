import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { buildChatGptWebClientConfig } from "../../src/shared/utils/chatgptWebClientConfig.js";

const row = (overrides = {}) => ({
  id: "chatgpt-web/gpt-5.6-sol",
  display_name: "GPT-5.6 Sol",
  supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
  default_reasoning_level: "high",
  context_window: 196000,
  auto_compact_token_limit: 180000,
  max_output: 16000,
  legacy: false,
  capabilities: { generic_responses: true, generic_tools: true, native_responses: true },
  ...overrides,
});
const build = (catalog = row(), origin = "https://router.example", effort) =>
  buildChatGptWebClientConfig(catalog, origin, effort);
const pluginHooks = async snippet => {
  const plugin = runInNewContext(
    snippet.replace("export const NineRouterChatGptWeb", "const NineRouterChatGptWeb") + "\nNineRouterChatGptWeb;",
    Object.create(null),
  );
  return plugin();
};

// Exercises the downloaded strings as data/code, not only the generator's in-memory inputs.
describe("ChatGPT Web client templates", () => {

  it("uses safe JSON serialization for display names without placing them in executable code", () => {
    const hostile = '</script><script>globalThis.compromised=true</script>";\\\n\u2028\u2029${process.env.SECRET}';
    const snippets = build(row({ display_name: hostile, apiKey: "NEVER_ECHO", runtimeApiKey: "NEVER_ECHO", privateKeyPem: "NEVER_ECHO" }));
    expect(JSON.parse(snippets.openCodeConfig).provider["9router-cgw"].models[snippets.modelId].name).toBe(hostile);
    expect(snippets.openCodeConfig).not.toContain("</script>");
    expect(snippets.openCodeConfig).not.toMatch(/[\u2028\u2029]/);
    expect(snippets.openCodePlugin).not.toContain(hostile);
    expect(snippets.nativeConfig).not.toContain(hostile);
    expect(JSON.stringify(snippets)).not.toContain("NEVER_ECHO");
  });

  it.each(["https://router.example", "https://router.example:8443/", "http://localhost:20127", "http://127.0.0.1:20127/", "http://[::1]:20127"])(
    "accepts secure or exact loopback API origin %s", origin => {
      const snippets = build(row(), origin);
      expect(snippets.apiBaseUrl).toBe(`${new URL(origin).origin}/v1`);
      expect(JSON.parse(snippets.companionConfig).gatewayUrl).toBe(new URL(origin).origin);
    },
  );

  it.each([
    undefined, null, {}, "", "router.example", "javascript:alert(1)", "file:///tmp/key", "//router.example",
    "http://router.example", "http://localhost.attacker.example", "https://key@router.example", "https://user:key@router.example",
    "https://router.example/v1", "https://router.example/path/..", "https://router.example/?key=SECRET", "https://router.example/#SECRET",
    "https://router.example\\@attacker.example", "https://router.example\n", " https://router.example", "https://router.example\u0000",
    'https://router.example/";globalThis.compromised=true;//',
  ])("rejects malformed/credential-bearing origins without echoing them: %j", origin => {
    expect(() => build(row(), origin === undefined ? null : origin)).toThrow(/API origin/);
  });

  it.each([
    null, [], {}, row({ id: "cgw/chatgpt-web/gpt-5.6-sol" }), row({ id: "gpt-5.6-sol" }), row({ id: "chatgpt-web/" }),
    row({ id: "chatgpt-web/../gpt-5.6-sol" }), row({ id: 'chatgpt-web/gpt-5.6-sol";globalThis.compromised=true;//' }),
    row({ id: "chatgpt-web/" + "a".repeat(129) }), row({ legacy: true }),
    row({ supported_reasoning_levels: [] }), row({ supported_reasoning_levels: ["high", "high"] }),
    row({ supported_reasoning_levels: ["ultra"], default_reasoning_level: "ultra" }), row({ supported_reasoning_levels: ["invented"] }),
    row({ default_reasoning_level: "max" }), row({ context_window: "196000" }), row({ context_window: 0 }),
    row({ context_window: Infinity }), row({ context_window: 1.5 }), row({ context_window: Number.MAX_SAFE_INTEGER + 1 }),
    row({ max_output: "16000" }), row({ max_output: 0 }), row({ auto_compact_token_limit: 196001 }), row({ auto_compact_token_limit: -1 }),
  ])("rejects catalog values rather than guessing availability/limits: %j", catalog => {
    expect(() => build(catalog)).toThrow(TypeError);
  });

  it.each(["max", 'high";globalThis.compromised=true;//', null, "", {}, "ultra"])("rejects unverified selected effort %j", effort => {
    expect(() => build(row(), "https://router.example", effort)).toThrow("Select a reasoning effort verified for this model");
  });

});

describe("downloaded OpenCode chat.params plugin", () => {
  it.each(["low", "medium", "high", "xhigh"])("removes unsupported controls and sets the selected %s effort in unnested provider options", async effort => {
    const hooks = await pluginHooks(build(row(), "https://router.example", effort).openCodePlugin);
    const input = { model: { providerID: "9router-cgw", id: "cgw/chatgpt-web/gpt-5.6-sol" } };
    const output = { maxOutputTokens: 999, temperature: 0.7, topP: 0.8, topK: 10, options: { custom: "keep", reasoningEffort: "medium", reasoning_effort: "max" }, other: "keep" };
    await hooks["chat.params"](input, output);
    expect(output.maxOutputTokens).toBeUndefined();
    expect(output.temperature).toBeUndefined();
    expect(output.topP).toBeUndefined();
    expect(output.topK).toBeUndefined();
    expect(output.options).toEqual({ custom: "keep", reasoningEffort: effort, reasoning_effort: effort });
    expect(output.options["9router-cgw"]).toBeUndefined();
    expect(output.other).toBe("keep");
    expect(Object.keys(hooks)).toEqual(["chat.params"]);
    // @ai-sdk/openai-compatible 2.0.41 filters known camelCase options from the raw
    // spread, then writes reasoning_effort from reasoningEffort (not the raw value).
    const { reasoningEffort, ...rawOptions } = output.options;
    const wire = JSON.parse(JSON.stringify({ max_tokens: output.maxOutputTokens, temperature: output.temperature, top_p: output.topP,
      ...rawOptions, reasoning_effort: reasoningEffort }));
    expect(wire).toEqual({ custom: "keep", reasoning_effort: effort });
  });

  it.each(["openai", "9router-cgw-other", "9router-cgw.attacker", "another-provider"])("does not mutate %s parameters or options", async providerID => {
    const hooks = await pluginHooks(build().openCodePlugin);
    const output = Object.freeze({ maxOutputTokens: 1000, temperature: 0.5, topP: 0.6, topK: 5, options: Object.freeze({ reasoningEffort: "high" }) });
    await hooks["chat.params"]({ model: { providerID } }, output);
    expect(output).toEqual({ maxOutputTokens: 1000, temperature: 0.5, topP: 0.6, topK: 5, options: { reasoningEffort: "high" } });
  });

  it("uses the catalog default when no effort override is chosen and handles absent options", async () => {
    const hooks = await pluginHooks(build().openCodePlugin);
    const output = {};
    await hooks["chat.params"]({ model: { providerID: "9router-cgw" } }, output);
    expect(output.options).toEqual({ reasoningEffort: "high", reasoning_effort: "high" });
  });
});
