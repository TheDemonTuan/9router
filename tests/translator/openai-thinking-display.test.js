// OpenAI-format clients asking for reasoning get Claude's thinking text back.
//
// Claude only returns thinking text when the request sets thinking.display to
// "summarized" — otherwise the redact-thinking beta is sent and every thinking
// block comes back signature-only. That field has no OpenAI equivalent, so an
// OpenAI-format client (opencode, DeepSeek Harness, Cherry Studio, ...) could never
// see its reasoning: reasoning_content stayed empty however high the effort was.
//
// The client's intent is read from the pre-translation body:
// - Chat Completions: setting reasoning_effort is the request for reasoning.
// - Responses API: reasoning.summary is OpenAI's explicit ask for summaries.
// Claude-format clients are untouched — they set display themselves.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { selectAnthropicBeta } from "../../open-sse/providers/shared.js";

const REDACT = "redact-thinking-2026-02-12";
const MODEL = "claude-opus-5";

function toClaude(sourceFormat, body, model = MODEL) {
  return translateRequest(sourceFormat, FORMATS.CLAUDE, model, body, true, null, "claude");
}

const chat = (extra = {}) => ({ model: MODEL, messages: [{ role: "user", content: "Is 391 prime?" }], ...extra });
const responses = (extra = {}) => ({ model: MODEL, input: [{ role: "user", content: "Is 391 prime?" }], ...extra });

describe("Chat Completions clients", () => {
  it("reasoning_effort asks Claude for summarized thinking and drops redact-thinking", () => {
    const out = toClaude(FORMATS.OPENAI, chat({ reasoning_effort: "high" }));
    expect(out.thinking.display).toBe("summarized");
    expect(selectAnthropicBeta(MODEL, out)).not.toContain(REDACT);
  });

  it("reasoning_effort none leaves thinking off and keeps redact-thinking", () => {
    const out = toClaude(FORMATS.OPENAI, chat({ reasoning_effort: "none" }));
    expect(out.thinking?.display).toBeUndefined();
    expect(selectAnthropicBeta(MODEL, out)).toContain(REDACT);
  });

  it("no reasoning_effort changes nothing", () => {
    const out = toClaude(FORMATS.OPENAI, chat());
    expect(out.thinking?.display).toBeUndefined();
    expect(selectAnthropicBeta(MODEL, out)).toContain(REDACT);
  });
});

describe("Responses API clients", () => {
  it("reasoning.summary asks Claude for summarized thinking", () => {
    const out = toClaude(FORMATS.OPENAI_RESPONSES, responses({ reasoning: { effort: "high", summary: "auto" } }));
    expect(out.thinking.display).toBe("summarized");
    expect(selectAnthropicBeta(MODEL, out)).not.toContain(REDACT);
  });

  it("effort without summary keeps thinking text redacted, as OpenAI would", () => {
    const out = toClaude(FORMATS.OPENAI_RESPONSES, responses({ reasoning: { effort: "high" } }));
    expect(out.thinking?.display).toBeUndefined();
    expect(selectAnthropicBeta(MODEL, out)).toContain(REDACT);
  });
});

describe("Claude-format clients are untouched", () => {
  it("thinking without display stays redacted", () => {
    const out = toClaude(FORMATS.CLAUDE, {
      model: MODEL, max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "Is 391 prime?" }],
    });
    expect(out.thinking?.display).toBeUndefined();
    expect(selectAnthropicBeta(MODEL, out)).toContain(REDACT);
  });

  it("an explicit display is kept as sent", () => {
    const out = toClaude(FORMATS.CLAUDE, {
      model: MODEL, max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048, display: "omitted" },
      messages: [{ role: "user", content: "Is 391 prime?" }],
    });
    expect(out.thinking.display).toBe("omitted");
    expect(selectAnthropicBeta(MODEL, out)).toContain(REDACT);
  });
});

// Opus 5.5 and Fable 5.1 cannot turn thinking off, so the adaptive mapper sends
// effort without a thinking switch. A display request must still reach Claude,
// or redact-thinking stays on and every thinking block comes back signature-only.
describe("permanently adaptive models keep the display request", () => {
  it.each(["claude-opus-5-5", "claude-fable-5-1"])("Chat reasoning_effort on %s asks for summarized thinking", (model) => {
    const out = toClaude(FORMATS.OPENAI, { model, reasoning_effort: "high", messages: [{ role: "user", content: "Is 391 prime?" }] }, model);
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
    expect(selectAnthropicBeta(model, out)).not.toContain(REDACT);
  });

  it("Responses reasoning.summary on Opus 5.5 asks for summarized thinking", () => {
    const out = toClaude(FORMATS.OPENAI_RESPONSES, { input: [{ role: "user", content: "Is 391 prime?" }], reasoning: { effort: "xhigh", summary: "auto" } }, "claude-opus-5-5");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
    expect(selectAnthropicBeta("claude-opus-5-5", out)).not.toContain(REDACT);
  });

  it("Responses effort without summary on Opus 5.5 still sends no thinking switch", () => {
    const out = toClaude(FORMATS.OPENAI_RESPONSES, { input: [{ role: "user", content: "Is 391 prime?" }], reasoning: { effort: "high" } }, "claude-opus-5-5");
    expect(out.thinking).toBeUndefined();
    expect(selectAnthropicBeta("claude-opus-5-5", out)).toContain(REDACT);
  });

  it("an explicit Claude display on Opus 5.5 is kept as sent", () => {
    const out = toClaude(FORMATS.CLAUDE, {
      model: "claude-opus-5-5", max_tokens: 4096,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "Is 391 prime?" }],
    }, "claude-opus-5-5");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "max" });
  });
});
