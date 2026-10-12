/**
 * Regression test for #4283
 *
 * Gemini Antigravity rejects tool schemas that contain unknown JSON Schema
 * keywords with: "Unknown name X: Cannot find field."
 *
 * The UNSUPPORTED_SCHEMA_CONSTRAINTS list in gemini.js did not include
 * "errorMessage" (and similar non-standard annotation keywords used by some
 * MCP tool schemas), causing 400 INVALID_ARGUMENT errors on tools with error
 * documentation fields.
 *
 * Fix: add errorMessage, errorMessages, markdownDescription, and other
 * non-standard annotation keywords to the strip list.
 */

import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("cleanJSONSchemaForAntigravity strips errorMessage recursively (#4283)", () => {
  it("strips top-level errorMessage", () => {
    const schema = {
      type: "object",
      properties: {
        code: { type: "integer" }
      },
      errorMessage: "Invalid input"
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result).not.toHaveProperty("errorMessage");
  });

  it("strips errorMessage nested inside array items", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
            errorMessage: "Must be a non-empty string"
          }
        }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.properties.tags.items).not.toHaveProperty("errorMessage");
  });

  it("strips markdownDescription from nested property", () => {
    const schema = {
      type: "object",
      properties: {
        name: {
          type: "string",
          markdownDescription: "The **name** of the resource"
        }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.properties.name).not.toHaveProperty("markdownDescription");
  });

  it("strips minProperties / maxProperties", () => {
    const schema = {
      type: "object",
      minProperties: 1,
      maxProperties: 10,
      properties: { x: { type: "string" } }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result).not.toHaveProperty("minProperties");
    expect(result).not.toHaveProperty("maxProperties");
  });

  it("leaves other valid fields intact", () => {
    const schema = {
      type: "object",
      description: "A valid tool",
      properties: {
        n: { type: "number", description: "A number" }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.description).toBe("A valid tool");
    expect(result.properties.n.description).toBe("A number");
  });

  it("retains keyword-shaped property names without treating their map as a schema", () => {
    const names = ["properties", "type", "enum", "const", "allOf", "anyOf", "items", "default", "title", "x-client"];
    const result = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: Object.fromEntries(names.map(name => [name, { type: "string", default: "strip", errorMessage: "strip" }])),
      required: names,
    });
    expect(Object.keys(result.properties)).toEqual(names);
    expect(result.required).toEqual(names);
    for (const schema of Object.values(result.properties)) expect(schema).toEqual({ type: "string" });
  });
});