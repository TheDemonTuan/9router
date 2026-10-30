// Single-object content must survive normalization and retain client policy.
import { describe, it, expect } from "vitest";
import {
  anchorClaudeCache,
  normalizeClaudePassthrough,
  prepareClaudeRequest,
} from "../../open-sse/translator/formats/claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const CC = { type: "ephemeral" };
const text = (t, extra = {}) => ({ type: "text", text: t, ...extra });
const tool = (name, extra = {}) => ({ name, description: "d", input_schema: {}, ...extra });

// counts markers incl. single-object content — mirrors the upstream contract
function countMarkers(body) {
  let n = 0;
  if (Array.isArray(body.system)) for (const b of body.system) if (b?.cache_control) n++;
  if (Array.isArray(body.tools)) for (const t of body.tools) if (t?.cache_control) n++;
  if (Array.isArray(body.messages)) for (const m of body.messages) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content) if (b?.cache_control) n++;
    } else if (m?.content && typeof m.content === "object" && m.content.cache_control) n++;
  }
  return n;
}

describe("cache marker budget and single-block content", () => {

  it("normalizes a single-object turn in passthrough and anchors it", () => {
    const body = {
      messages: [
        { role: "user", content: [text("u1")] },
        { role: "assistant", content: text("a1") },     // single object, no marker
        { role: "user", content: [text("q")] },
      ],
    };
    normalizeClaudePassthrough(body);
    const assistant = body.messages.find(m => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(Array.isArray(assistant.content)).toBe(true); // base: still bare object
    expect(assistant.content).toHaveLength(1);
    const out = anchorClaudeCache(body);
    expect(out.messages[1].content[0]).toMatchObject({ type: "text", text: "a1" });
  });

  it("keeps a marked single-object turn and its client policy", () => {
    const out = prepareClaudeRequest({
      model: "claude-sonnet-5", max_tokens: 100,
      system: [text("s1")],
      messages: [
        { role: "user", content: text("u1", { cache_control: CC }) },
        { role: "assistant", content: [text("a1")] },
        { role: "user", content: [text("q")] },
      ],
    }, "claude");
    const kept = out.messages.filter(m => JSON.stringify(m.content).includes("u1"));
    expect(kept.length).toBe(1);                        // base: 0 (dropped)
    expect(kept[0].content).toHaveLength(1);           // normalized to array
    expect(kept[0].content[0].cache_control).toEqual(CC);
  });

  it("drops no conversation turn when content is a single text object", () => {
    const out = prepareClaudeRequest({
      model: "claude-sonnet-5", max_tokens: 100,
      messages: [
        { role: "user", content: text("u1") },
        { role: "assistant", content: text("a1") },
        { role: "user", content: [text("q")] },
      ],
    }, "claude");
    expect(out.messages.length).toBe(3);               // base: 1
    expect(Array.isArray(out.messages[0].content)).toBe(true);
  });


  it("keeps a marked single-object turn when the marker budget is spent", () => {
    const body = {
      system: [text("s1", { cache_control: CC })],
      tools: [tool("t1", { cache_control: CC })],
      messages: [
        { role: "user", content: [text("c1"), text("c2")] },
        { role: "assistant", content: [text("a1", { cache_control: CC })] },
        { role: "user", content: text("u1", { cache_control: CC }) },
        { role: "user", content: [text("q")] },
      ],
    };
    normalizeClaudePassthrough(body);
    const out = anchorClaudeCache(body);
    const kept = out.messages.filter(m => JSON.stringify(m.content).includes("u1"));
    expect(kept.length).toBe(1);
    expect(Array.isArray(kept[0].content)).toBe(true); // base: bare object survives
    expect(kept[0].content).toHaveLength(1);
    expect(kept[0].content[0].cache_control).toBeUndefined();
    const ctx = out.messages.find(m => JSON.stringify(m.content).includes("c1"));
    expect(ctx.content).toEqual([text("c1"), text("c2")]);
    expect(countMarkers(out)).toBeLessThanOrEqual(4);  // fixed: 3
  });

  it("keeps single-object turns on the claude-to-openai leg", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [
        { role: "user", content: text("u1") },
        { role: "assistant", content: { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } } },
      ],
    }, false);
    expect(out.messages.some(m => JSON.stringify(m.content).includes("u1"))).toBe(true); // base: dropped
    const img = out.messages.find(m => m.role === "assistant");
    expect(JSON.stringify(img.content)).toContain("image_url"); // base: dropped
  });

  it("keeps a bare-object user turn folded with a mid-conversation system message", () => {
    const body = {
      messages: [
        { role: "user", content: text("u1") },
        { role: "system", content: [text("reminder")] },
        { role: "user", content: [text("q")] },
      ],
    };
    normalizeClaudePassthrough(body);
    const first = body.messages[0];
    expect(Array.isArray(first.content)).toBe(true);
    expect(JSON.stringify(first.content).includes("u1")).toBe(true); // pre-hoist: fold zeroes bare-object content
    expect(JSON.stringify(first.content).includes("reminder")).toBe(true);
  });

  it("keeps a bare-object system reminder on the claude-to-openai leg", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: text("be brief") },
      ],
    }, false);
    expect(JSON.stringify(out.messages)).toContain("be brief"); // pre-fix: turn dropped
  });
});
