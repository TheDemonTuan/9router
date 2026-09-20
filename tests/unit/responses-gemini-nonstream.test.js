import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

function geminiResponse(finishReason, candidates = undefined) {
  return {
    responseId: `nonstream-${finishReason || "empty"}`,
    modelVersion: "gemini-3.8-pro",
    candidates: candidates ?? [{ content: { parts: [{ text: "partial" }] }, finishReason }],
  };
}

describe("non-streaming Gemini to Responses terminal conversion", () => {
  it.each([
    ["STOP", "completed", null, null],
    ["MAX_TOKENS", "incomplete", "max_output_tokens", null],
    ["SAFETY", "incomplete", "content_filter", null],
    ["MALFORMED_FUNCTION_CALL", "failed", null, "provider_error"],
  ])("maps %s through the non-streaming handler", (finishReason, status, incompleteReason, errorCode) => {
    const response = translateNonStreamingResponse(
      geminiResponse(finishReason),
      FORMATS.GEMINI,
      FORMATS.OPENAI_RESPONSES,
    );

    expect(response).toMatchObject({ object: "response", status });
    expect(response.incomplete_details).toEqual(incompleteReason ? { reason: incompleteReason } : null);
    expect(response.error?.code || null).toBe(errorCode);
  });

  it("fails empty candidate lists as a canonical Responses failure", () => {
    const response = translateNonStreamingResponse(
      geminiResponse("empty", []),
      FORMATS.GEMINI,
      FORMATS.OPENAI_RESPONSES,
    );

    expect(response).toMatchObject({
      object: "response",
      status: "failed",
      error: { type: "server_error", code: "provider_error" },
    });
  });
});
