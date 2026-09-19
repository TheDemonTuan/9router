import { describe, it, expect } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  responsesTextFormatToChatResponseFormat,
} from "../../open-sse/translator/request/openai-responses.js";
import {
  openaiToGeminiRequest,
  openaiToGeminiCLIRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";

describe("Responses Structured Outputs & Multi-hop Translation", () => {
  const goalEvaluatorSchema = {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["continue", "complete", "blocked"],
      },
      evidence: {
        type: "array",
        items: {
          type: "string",
        },
      },
      next_step: {
        type: ["string", "null"],
      },
      blocker_key: {
        type: ["string", "null"],
      },
    },
    required: ["decision", "evidence", "next_step", "blocker_key"],
    additionalProperties: false,
  };

  describe("responsesTextFormatToChatResponseFormat", () => {
    it("converts json_schema format to Chat Completions response_format", () => {
      const rf = responsesTextFormatToChatResponseFormat({
        format: {
          type: "json_schema",
          name: "goal_evaluator",
          strict: true,
          schema: goalEvaluatorSchema,
        },
      });

      expect(rf).toEqual({
        type: "json_schema",
        json_schema: {
          name: "goal_evaluator",
          strict: true,
          schema: goalEvaluatorSchema,
        },
      });
    });

    it("defaults name to 'response' and strict to true if omitted", () => {
      const rf = responsesTextFormatToChatResponseFormat({
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      });

      expect(rf).toEqual({
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: true,
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      });
    });

    it("converts json_object format", () => {
      const rf = responsesTextFormatToChatResponseFormat({
        format: {
          type: "json_object",
        },
      });

      expect(rf).toEqual({
        type: "json_object",
      });
    });

    it("converts text format", () => {
      const rf = responsesTextFormatToChatResponseFormat({
        format: {
          type: "text",
        },
      });

      expect(rf).toEqual({
        type: "text",
      });
    });

    it("returns null for non-object or missing format", () => {
      expect(responsesTextFormatToChatResponseFormat(null)).toBeNull();
      expect(responsesTextFormatToChatResponseFormat({})).toBeNull();
      expect(responsesTextFormatToChatResponseFormat({ format: { type: "unknown" } })).toBeNull();
    });
  });

  describe("openaiResponsesToOpenAIRequest", () => {
    it("translates text.format json_schema and removes text property", () => {
      const rawResponsesRequest = {
        model: "openai-responses",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Evaluate status" }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "evaluator",
            strict: true,
            schema: goalEvaluatorSchema,
          },
        },
      };

      const chatRequest = openaiResponsesToOpenAIRequest("gpt-4o", rawResponsesRequest, false);

      expect(chatRequest.text).toBeUndefined();
      expect(chatRequest.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "evaluator",
          strict: true,
          schema: goalEvaluatorSchema,
        },
      });
      expect(chatRequest.messages).toHaveLength(1);
    });

    it("translates text.format json_object and removes text property", () => {
      const rawResponsesRequest = {
        model: "openai-responses",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Output JSON" }],
          },
        ],
        text: {
          format: {
            type: "json_object",
          },
        },
      };

      const chatRequest = openaiResponsesToOpenAIRequest("gpt-4o", rawResponsesRequest, false);

      expect(chatRequest.text).toBeUndefined();
      expect(chatRequest.response_format).toEqual({
        type: "json_object",
      });
    });

    it("strips text property even when no format is specified", () => {
      const rawResponsesRequest = {
        input: [{ type: "message", role: "user", content: "Hello" }],
        text: {},
      };

      const chatRequest = openaiResponsesToOpenAIRequest("gpt-4o", rawResponsesRequest, false);
      expect(chatRequest.text).toBeUndefined();
      expect(chatRequest.response_format).toBeUndefined();
    });
  });

  describe("OpenAI -> Gemini / Antigravity request mapping", () => {
    it("maps json_schema response_format to generationConfig responseMimeType and responseSchema in Gemini", () => {
      const chatRequest = {
        messages: [{ role: "user", content: "Evaluate" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "evaluator",
            schema: goalEvaluatorSchema,
          },
        },
      };

      const geminiRequest = openaiToGeminiRequest("gemini-2.5-flash", chatRequest, false);

      expect(geminiRequest.generationConfig.responseMimeType).toBe("application/json");
      expect(geminiRequest.generationConfig.responseSchema).toBeDefined();

      const schema = geminiRequest.generationConfig.responseSchema;
      expect(schema.type).toBe("object");
      expect(schema.properties.decision).toBeDefined();
      expect(schema.properties.evidence).toBeDefined();
      // Response schemas preserve nullable and closed-object constraints.
      expect(schema.properties.next_step).toMatchObject({ type: "string", nullable: true });
      expect(schema.properties.blocker_key).toMatchObject({ type: "string", nullable: true });
      expect(schema.additionalProperties).toBe(false);
      // Verify required fields preserved
      expect(schema.required).toEqual(["decision", "evidence", "next_step", "blocker_key"]);
    });

    it("maps json_object response_format to application/json in Gemini", () => {
      const chatRequest = {
        messages: [{ role: "user", content: "JSON please" }],
        response_format: {
          type: "json_object",
        },
      };

      const geminiRequest = openaiToGeminiRequest("gemini-2.5-flash", chatRequest, false);

      expect(geminiRequest.generationConfig.responseMimeType).toBe("application/json");
      expect(geminiRequest.generationConfig.responseSchema).toBeUndefined();
    });

    it("maps response_format in Antigravity envelope for Gemini models", () => {
      const chatRequest = {
        messages: [{ role: "user", content: "Evaluate" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "evaluator",
            schema: goalEvaluatorSchema,
          },
        },
      };

      const agRequest = openaiToAntigravityRequest("gemini-3.7-flash", chatRequest, false);

      expect(agRequest.request.generationConfig.responseMimeType).toBe("application/json");
      expect(agRequest.request.generationConfig.responseSchema).toBeDefined();
      expect(agRequest.request.generationConfig.responseSchema.properties.decision).toBeDefined();
    });

    it("maps response_format in Antigravity envelope for Claude models", () => {
      const chatRequest = {
        messages: [{ role: "user", content: "Evaluate" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "evaluator",
            schema: goalEvaluatorSchema,
          },
        },
      };

      const agRequest = openaiToAntigravityRequest("claude-3-7-sonnet", chatRequest, false);

      expect(agRequest.request.generationConfig.responseMimeType).toBe("application/json");
      expect(agRequest.request.generationConfig.responseSchema).toBeDefined();
      expect(agRequest.request.generationConfig.responseSchema.properties.decision).toBeDefined();
    });
  });

  describe("nested response schemas", () => {
    it("resolves local refs before preserving nested composition, arrays, and object constraints", () => {
      const chatRequest = {
        messages: [{ role: "user", content: "Evaluate" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              additionalProperties: false,
              $defs: {
                evidence: {
                  allOf: [
                    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                    { properties: { tags: { type: "array", items: { type: ["string", "null"] } } }, required: ["tags"] },
                  ],
                },
              },
              properties: {
                evidence: { $ref: "#/$defs/evidence" },
                metadata: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["evidence"],
            },
          },
        },
      };

      const schema = openaiToAntigravityRequest("gemini-3.8-flash", chatRequest, false)
        .request.generationConfig.responseSchema;
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["evidence"],
        properties: {
          evidence: {
            type: "object",
            required: ["id", "tags"],
            properties: {
              id: { type: "string" },
              tags: { type: "array", items: { type: "string", nullable: true } },
            },
          },
          metadata: { type: "object", additionalProperties: { type: "string" } },
        },
      });
      expect(JSON.stringify(schema)).not.toContain("$ref");
      expect(JSON.stringify(schema)).not.toContain("$defs");
    });
  });

  describe("End-to-end multi-hop translation chain", () => {
    it("preserves strict schema from Responses -> intermediate Chat -> Antigravity without leaking text", () => {
      const clientResponsesRequest = {
        model: "antigravity/gemini-3.7-flash",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Evaluate task completion" }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "goal_evaluator",
            strict: true,
            schema: goalEvaluatorSchema,
          },
        },
      };

      // Hop 1: Responses -> Chat intermediate
      const intermediateChat = openaiResponsesToOpenAIRequest("antigravity/gemini-3.7-flash", clientResponsesRequest, false);

      expect(intermediateChat.text).toBeUndefined();
      expect(intermediateChat.response_format).toBeDefined();
      expect(intermediateChat.response_format.type).toBe("json_schema");

      // Hop 2: Chat intermediate -> Antigravity upstream
      const antigravityPayload = openaiToAntigravityRequest("gemini-3.7-flash", intermediateChat, false);

      expect(antigravityPayload.request).toBeDefined();
      expect(antigravityPayload.request.text).toBeUndefined();
      expect(antigravityPayload.text).toBeUndefined();
      expect(antigravityPayload.request.generationConfig.responseMimeType).toBe("application/json");

      const finalSchema = antigravityPayload.request.generationConfig.responseSchema;
      expect(finalSchema).toBeDefined();
      expect(finalSchema.type).toBe("object");
      expect(Object.keys(finalSchema.properties)).toEqual(["decision", "evidence", "next_step", "blocker_key"]);
      expect(finalSchema.required).toEqual(["decision", "evidence", "next_step", "blocker_key"]);
      expect(finalSchema.additionalProperties).toBe(false);
    });
  });
});
