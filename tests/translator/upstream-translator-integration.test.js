import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

const toolLoop = () => [
  { role: "user", content: [{ type: "text", text: "Read the result" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "lookup", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "fixture result" }] },
];
const tool = () => ({ name: "lookup", input_schema: { type: "object", properties: {} } });

describe("upstream native thinking and conversation preservation", () => {
  it.each(["claude-sonnet-5-5", "claude-sonnet-5.5", "claude-opus-5.5", "claude-opus-5.5-thinking-agentic"])(
    "uses adaptive xhigh for %s without forging historical thinking",
    (model) => {
      expect(getCapabilitiesForModel("claude", model).thinkingFormat).toBe("claude-adaptive");
      expect(getThinkingLevels("claude", model)).toContain("xhigh");
      const out = translateRequest("claude", "claude", model, {
        model, max_tokens: 4096, output_config: { effort: "xhigh" }, messages: toolLoop(), tools: [tool()],
      }, false, null, "claude");
      expect(out.thinking.type).toBe("adaptive");
      expect(out.output_config.effort).toBe("xhigh");
      const assistant = out.messages.find((message) => message.role === "assistant");
      expect(assistant.content.map((block) => block.type)).toEqual(["tool_use"]);
      expect(assistant.content[0].id).toBe("toolu_fixture");
    },
  );

  it.each(["claude-opus-4.6", "claude-opus-4-6", "claude-sonnet-4.6", "claude-sonnet-4-6"])(
    "does not advertise or send unsupported xhigh for %s",
    (model) => {
      expect(getThinkingLevels("claude", model)).not.toContain("xhigh");
      const body = {};
      applyThinking("claude", `${model}(xhigh)`, body, "claude");
      expect(body.output_config.effort).toBe("high");
    },
  );

  it("combines Sonnet off/forced-choice handling with a fourth tool-result cache breakpoint", () => {
    const out = translateRequest("openai", "claude", "claude-sonnet-5-5", {
      model: "claude-sonnet-5-5", reasoning_effort: "none",
      tool_choice: { type: "function", function: { name: "lookup" } },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      messages: [
        { role: "system", content: "Use lookup" },
        { role: "user", content: "Read the result" },
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "toolu_fixture", content: "fixture result" },
      ],
    }, false, null, "claude");
    expect(out.thinking).toEqual({ type: "between_tools" });
    expect(out.tool_choice.type).toBe("auto");
    const last = out.messages[out.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_fixture" });
    expect(last.content[last.content.length - 1].cache_control?.type).toBe("ephemeral");
    const blocks = [...(out.system || []), ...(out.tools || []), ...out.messages.flatMap((message) => message.content)];
    expect(blocks.filter((block) => block?.cache_control)).toHaveLength(4);
  });

  it("keeps a file-only user turn instead of replacing it after an assistant", () => {
    const out = translateRequest("claude", "claude", "claude-sonnet-5-5", {
      model: "claude-sonnet-5-5", max_tokens: 4096,
      messages: [
        { role: "user", content: "Read the file" },
        { role: "assistant", content: "Send the file" },
        { role: "user", content: [{ type: "container_upload", file_id: "file_fixture" }] },
      ],
    }, false, null, "claude");
    expect(out.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages[2].content).toEqual([{ type: "container_upload", file_id: "file_fixture" }]);
  });

  it.each([false, true])("preserves explicit model prefill with source envelope=%s", (wrapped) => {
    const request = { contents: [
      { role: "user", parts: [{ text: "Complete the sentence" }] },
      { role: "model", parts: [{ text: "The answer is" }] },
    ] };
    const body = wrapped ? { request } : request;
    const out = translateRequest(wrapped ? "antigravity" : "gemini", "claude", "claude-sonnet-5-5", body, false, null, "claude");
    expect(out.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(out.messages[1].content.some((block) => block.text === "The answer is")).toBe(true);
  });

  it("restores an emptied envelope user tail without changing intentional prefill", () => {
    const out = translateRequest("antigravity", "claude", "claude-sonnet-5-5", {
      request: { contents: [
        { role: "user", parts: [{ text: "Start" }] },
        { role: "model", parts: [{ text: "Reply" }] },
        { role: "user", parts: [] },
      ] },
    }, false, null, "claude");
    expect(out.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages[2].content.some((block) => typeof block.text === "string" && block.text.length > 0)).toBe(true);
  });

  it("sanitizes nested MCP annotations while retaining valid schema descriptions", () => {
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object", description: "Lookup inputs", errorMessage: "Invalid inputs",
      properties: { rows: { type: "array", items: {
        type: "object", description: "One result", errorMessages: { required: "Missing value" },
        properties: { value: { type: "string", description: "Result value", markdownDescription: "**Result**", "x-errorMessage": "Invalid value" } },
        required: ["value"],
      } } },
    });
    expect(cleaned.description).toBe("Lookup inputs");
    expect(cleaned).not.toHaveProperty("errorMessage");
    const items = cleaned.properties.rows.items;
    expect(items.description).toBe("One result");
    expect(items).not.toHaveProperty("errorMessages");
    expect(items.required).toEqual(["value"]);
    expect(items.properties.value).toEqual({ type: "string", description: "Result value" });
  });
});
