import { describe, it, expect } from "vitest";
import {
  chatResponseFormatToResponsesText,
  openaiToOpenAIResponsesRequest,
  openaiResponsesToOpenAIRequest,
  responsesTextFormatToChatResponseFormat,
} from "../../open-sse/translator/request/openai-responses.js";
import {
  openaiToGeminiRequest,
  openaiToGeminiCLIRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToVertexRequest } from "../../open-sse/translator/request/openai-to-vertex.js";

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

  describe("openaiToOpenAIResponsesRequest", () => {
    const goalResponseFormat = {
      type: "json_schema",
      json_schema: {
        name: "goal_evaluator",
        description: "Evaluate Goal state",
        strict: true,
        schema: goalEvaluatorSchema,
      },
    };

    it("maps Goal json_schema from Chat to Responses and preserves it round-trip", () => {
      const responses = openaiToOpenAIResponsesRequest("cx/gpt-5.5", {
        messages: [{ role: "user", content: "Evaluate" }],
        response_format: goalResponseFormat,
      }, true);

      expect(responses.response_format).toBeUndefined();
      expect(responses.text).toEqual(chatResponseFormatToResponsesText(goalResponseFormat));
      expect(openaiResponsesToOpenAIRequest("cx/gpt-5.5", responses, true).response_format).toEqual(goalResponseFormat);
    });

    it("maps json_object and text formats, including the input passthrough branch", () => {
      for (const type of ["json_object", "text"]) {
        const responseFormat = { type };
        const normal = openaiToOpenAIResponsesRequest("cx/gpt-5.5", {
          messages: [{ role: "user", content: "Format" }],
          response_format: responseFormat,
        }, true);
        const input = openaiToOpenAIResponsesRequest("cx/gpt-5.5", {
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Format" }] }],
          response_format: responseFormat,
        }, true);
        expect(normal).toMatchObject({ text: { format: { type } } });
        expect(input).toMatchObject({ text: { format: { type } } });
        expect(input.response_format).toBeUndefined();
      }
    });

    it("keeps an existing Responses text format in the input branch", () => {
      const text = { format: { type: "json_object" } };
      const out = openaiToOpenAIResponsesRequest("cx/gpt-5.5", {
        input: [], text, response_format: { type: "text" },
      }, true);
      expect(out.text).toBe(text);
      expect(out.response_format).toBeUndefined();
    });
  });

  describe("OpenAI -> Gemini / Antigravity request mapping", () => {
    it("maps json_schema response_format to generationConfig responseMimeType and responseJsonSchema in Gemini", () => {
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
      expect(geminiRequest.generationConfig.responseJsonSchema).toBeDefined();
      expect(geminiRequest.generationConfig.responseSchema).toBeUndefined();

      const schema = geminiRequest.generationConfig.responseJsonSchema;
      expect(schema.type).toBe("object");
      expect(schema.properties.decision).toBeDefined();
      expect(schema.properties.evidence).toBeDefined();
      // Public JSON Schema preserves nullable type arrays and closed-object constraints.
      expect(schema.properties.next_step).toEqual({ type: ["string", "null"] });
      expect(schema.properties.blocker_key).toEqual({ type: ["string", "null"] });
      expect(schema.additionalProperties).toBe(false);
      // Verify required fields preserved
      expect(schema.required).toEqual(["decision", "evidence", "next_step", "blocker_key"]);
    });

    it("keeps complex tool parameters on the tool cleaner", () => {
      expect(() => openaiToGeminiRequest("gemini-2.5-flash", {
        messages: [{ role: "user", content: "Use tool" }],
        tools: [{ type: "function", function: {
          name: "pick",
          parameters: { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } } },
        } }],
      }, false)).toThrow("Unsupported tool schema oneOf");
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

  describe("schema composition safety", () => {
    it("falls back to an instruction for unsupported Antigravity anyOf composition", () => {
      const request = openaiToAntigravityRequest("gemini-3.7-flash", {
        messages: [{ role: "user", content: "Choose" }],
        response_format: {
          type: "json_schema",
          json_schema: { schema: { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } } },
        },
      }, false);
      expect(request.request.generationConfig.responseSchema).toBeUndefined();
      expect(request.request._responseSchemaValidation.properties.value.anyOf).toHaveLength(2);
      expect(request.request.systemInstruction.parts[0].text).toContain("anyOf");
    });

    it("falls back to an instruction for unsupported Antigravity composition", () => {
      const request = openaiToGeminiCLIRequest("gemini-cli-model", {
        messages: [{ role: "user", content: "Choose" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "object" }] } } },
          },
        },
      }, false);

      expect(request.generationConfig.responseSchema).toBeUndefined();
      expect(request.generationConfig.responseJsonSchema).toBeUndefined();
      expect(request.systemInstruction.parts[0].text).toContain("JSON Schema");
      expect(request.systemInstruction.parts[0].text).toContain("oneOf");
    });

    it("preserves multi-branch oneOf for Chat -> Vertex responseJsonSchema", () => {
      const schema = {
        type: "object",
        properties: { value: { oneOf: [{ type: "string" }, { type: "object", properties: {} }] } },
      };
      const request = openaiToVertexRequest("gemini-3.8-flash", {
        messages: [{ role: "user", content: "Choose" }],
        response_format: { type: "json_schema", json_schema: { schema } },
      }, false);

      expect(request.generationConfig.responseJsonSchema.properties.value.oneOf).toEqual(schema.properties.value.oneOf);
      expect(request.generationConfig.responseSchema).toBeUndefined();
    });

    for (const keyword of ["anyOf", "oneOf"]) {
      it(`preserves multi-branch ${keyword} for Gemini responseJsonSchema`, () => {
        const schema = {
          type: "object",
          properties: { value: { [keyword]: [{ type: "string" }, { type: "object", properties: {} }] } },
        };
        const request = openaiToGeminiRequest("gemini-3.8-flash", {
          messages: [{ role: "user", content: "Choose" }],
          response_format: { type: "json_schema", json_schema: { schema } },
        }, false);

        expect(request.generationConfig.responseJsonSchema.properties.value[keyword]).toEqual(schema.properties.value[keyword]);
        expect(request.generationConfig.responseSchema).toBeUndefined();
      });
    }
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
