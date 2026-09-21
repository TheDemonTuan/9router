import { describe, expect, it } from "vitest";
import {
  validateJsonSchema,
  validateJsonText,
  validateStructuredResponse,
} from "../../open-sse/translator/concerns/jsonSchemaValidation.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("internal JSON Schema fallback validation", () => {
  const unionSchema = {
    type: "object",
    properties: {
      value: { oneOf: [{ type: "string" }, { type: "object", required: ["id"], properties: { id: { type: "string" } } }] },
    },
    required: ["value"],
    additionalProperties: false,
  };

  it("validates oneOf branches without selecting a branch during translation", () => {
    expect(validateJsonSchema({ value: "ok" }, unionSchema).valid).toBe(true);
    expect(validateJsonSchema({ value: { id: "x" } }, unionSchema).valid).toBe(true);
    expect(validateJsonSchema({ value: { id: 1 } }, unionSchema).valid).toBe(false);
  });

  it("supports anyOf, nullable types, refs, arrays, and enums", () => {
    const schema = {
      $defs: { item: { type: "object", properties: { name: { enum: ["a", "b"] } }, required: ["name"] } },
      type: "object",
      properties: {
        item: { $ref: "#/$defs/item" },
        maybe: { type: ["string", "null"] },
        values: { type: "array", items: { type: "integer" }, minItems: 1 },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["item", "maybe", "values", "either"],
    };
    expect(validateJsonSchema({ item: { name: "a" }, maybe: null, values: [1, 2], either: 3 }, schema).valid).toBe(true);
    expect(validateJsonSchema({ item: { name: "c" }, maybe: null, values: [], either: true }, schema).valid).toBe(false);
  });

  it("validates accumulated streaming JSON at stream completion", async () => {
    let outcome;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"ok\\":false}"}}]}\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n"));
        controller.close();
      },
    }).pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "gemini-cli",
      null,
      null,
      "gemini-3.8-flash",
      null,
      null,
      (...args) => { outcome = args[3]; },
      null,
      null,
      null,
      { type: "object", properties: { ok: { const: true } }, required: ["ok"] },
    ));
    const reader = stream.getReader();
    while (!(await reader.read()).done) {}
    expect(outcome?.successful).toBe(false);
    expect(outcome?.message).toContain("JSON Schema validation");
  });

  it("parses fenced JSON and extracts Chat/Responses response text", () => {
    expect(validateJsonText("```json\n{\"ok\":true}\n```", { type: "object", required: ["ok"] }).valid).toBe(true);
    expect(validateStructuredResponse({ choices: [{ message: { content: "{\\\"ok\\\":true}" } }] }, { type: "object", required: ["ok"] }).valid).toBe(false);
    expect(validateStructuredResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] }, { type: "object", required: ["ok"] }).valid).toBe(true);
    expect(validateStructuredResponse({ choices: [{ message: { tool_calls: [{ id: "call" }] } }] }, { type: "object" }).skipped).toBe(true);
  });
});
