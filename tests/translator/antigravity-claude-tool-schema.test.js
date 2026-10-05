import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { projectAntigravityClaudeToolSchema as project } from "../../open-sse/translator/concerns/antigravityToolSchema.js";

export const TASK_SCHEMA = {
  type: "object",
  properties: {
    i: { type: "string" }, context: { type: "string" },
    model: { not: true },
    tasks: { type: "array", items: {
      type: "object", properties: {
        task: { type: "string" }, solutionSpace: { type: "string" },
        model: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        outputSchema: { anyOf: [{ type: "object", properties: {} }, { type: "boolean" }, { type: "string" }, { type: "null" }] },
      }, required: ["task", "solutionSpace"], additionalProperties: false,
    } },
  }, required: ["i", "context", "tasks"], additionalProperties: false,
};

describe("Antigravity Claude final tool wire", () => {
  it.each(["claude-opus-5-5-high", "claude-sonnet-4-6"])("projects task without changing canonical schema for %s", (model) => {
    const body = { model, input: [{ role: "user", content: "Synthetic schema probe" }], tools: [{ type: "function", name: "task", parameters: structuredClone(TASK_SCHEMA) }] };
    const original = structuredClone(body);
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, model, body, true, {});
    const wire = new AntigravityExecutor().transformRequest(model, translated, true, { projectId: "synthetic", connectionId: "synthetic" });
    const declaration = wire.request.tools[0].functionDeclarations[0];
    expect(declaration.name).toBe("task");
    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters.required).toEqual(["i", "context", "tasks"]);
    expect(declaration.parameters.properties.model).toBeUndefined();
    expect(declaration.parameters.properties.tasks.items.properties.model.type).toBe("string");
    expect(declaration.parameters.properties.tasks.items.properties.outputSchema).toMatchObject({ type: "object", properties: {} });
    expect(body).toEqual(original);
    const visit = (node) => {
      for (const key of ["anyOf", "oneOf", "allOf", "not", "nullable", "reason"]) expect(node).not.toHaveProperty(key);
      expect(Array.isArray(node.type)).toBe(false);
      for (const child of Object.values(node.properties || {})) visit(child);
      if (node.items) visit(node.items);
    };
    visit(declaration.parameters);
  });
  it("does not replace a preceding custom-tool schema with a function schema", () => {
    const model = "claude-opus-5-5-high";
    const body = { model, input: [{ role: "user", content: "Synthetic" }], tools: [{ type: "custom", name: "shell" }, { type: "function", name: "probe", parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }] };
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, model, body, true, {});
    const wire = new AntigravityExecutor().transformRequest(model, translated, true, { projectId: "synthetic" });
    const [custom, fn] = wire.request.tools[0].functionDeclarations;
    expect(custom.parameters.properties.input.type).toBe("string");
    expect(custom.parameters.properties.count).toBeUndefined();
    expect(fn.parameters.properties.count.type).toBe("integer");
  });
  it("preserves false canonical tool roots until explicit schema rejection", () => {
    const model = "claude-opus-5-5-high";
    const body = { model, input: [{ role: "user", content: "Synthetic" }], tools: [{ type: "function", name: "probe", parameters: false }] };
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, model, body, true, {});
    expect(translated.request.tools[0].functionDeclarations[0].parameters).toBe(false);
    expect(() => new AntigravityExecutor().transformRequest(model, translated, true, { projectId: "synthetic" })).toThrow(/tool arguments must be an object/);
  });
  it("retains call linkage and instance keys through a synthetic second turn", () => {
    const model = "claude-opus-5-5-high";
    const args = { default: "original", title: "original", format: "original" };
    const body = { model, tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: Object.fromEntries(Object.keys(args).map(name => [name, { type: "string" }])) } }], input: [{ role: "user", content: "Synthetic first turn" }, { type: "function_call", name: "probe", call_id: "call_history", arguments: JSON.stringify(args) }, { type: "function_call_output", call_id: "call_history", output: "Synthetic constant result" }, { role: "user", content: "Synthetic final turn" }] };
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, model, structuredClone(body), true, {});
    const wire = new AntigravityExecutor().transformRequest(model, translated, true, { projectId: "synthetic" });
    const parts = wire.request.contents.flatMap(content => content.parts);
    expect(parts.find(part => part.functionCall).functionCall).toMatchObject({ id: "call_history", name: "probe", args });
    expect(parts.find(part => part.functionResponse).functionResponse).toMatchObject({ id: "call_history", name: "probe" });
    expect(Object.keys(wire.request.tools[0].functionDeclarations[0].parameters.properties)).toEqual(Object.keys(args));
  });
});

describe("Claude CCA schema projection", () => {
  const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
  it("retains special property names and does not traverse instance enum values", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"default":{"type":"string"},"enum":{"type":"string"},"anyOf":{"type":"string"},"x-user-id":{"enum":[{"default":1,"anyOf":false}]}}}');
    const before = structuredClone(schema);
    const wire = project(schema).parameters;
    expect(Object.keys(wire.properties)).toEqual(Object.keys(schema.properties));
    expect(Object.getPrototypeOf(wire.properties)).toBe(Object.prototype);
    expect(wire.properties["x-user-id"].description).toContain('{"default":1,"anyOf":false}');
    expect(schema).toEqual(before);
    expect(project(wire).parameters).toEqual(wire);
  });
  it("keeps parent required and intersects object-union required fields", () => {
    const schema = object({ payload: { required: ["parent"], anyOf: [object({ parent: { type: "string" }, shared: { type: "string" }, left: { type: "integer" } }, ["shared", "left"]), object({ parent: { type: "string" }, shared: { type: "integer" }, right: { type: "boolean" } }, ["shared", "right"])] } });
    const wire = project(schema).parameters.properties.payload;
    expect(Object.keys(wire.properties)).toEqual(["parent", "shared", "left", "right"]);
    expect(wire.required).toEqual(["parent", "shared"]);
    expect(wire.properties.shared.type).toBe("string");
  });
  it("unions string enum branches without changing enum element types", () => {
    const wire = project(object({ value: { oneOf: [{ enum: ["a", "b"] }, { enum: ["b", "c"] }] }, count: { type: "integer", enum: [1, 2] } })).parameters;
    expect(wire.properties.value.enum).toEqual(["a", "b", "c"]);
    expect(wire.properties.count.type).toBe("integer");
    expect(wire.properties.count.enum).toBeUndefined();
    expect(wire.properties.count.description).toContain("[1,2]");
  });
  it("conjoins object properties/required instead of last-write-wins", () => {
    const wire = project({ allOf: [object({ value: { type: "number", minimum: 1 } }, ["value"]), object({ value: { type: "integer", maximum: 3 }, other: { type: "string" } }, ["other"])] }).parameters;
    expect(wire.required).toEqual(["value", "other"]);
    expect(wire.properties.value).toEqual({ type: "integer", minimum: 1, maximum: 3 });
    expect(() => project(object({ value: { allOf: [{ type: "string" }, { type: "number" }] } }))).toThrow(/incompatible conjunction/);
  });
  it("falls back rather than rejects a satisfiable lossy-union conjunction", () => {
    const result = project(object({ value: { allOf: [{ anyOf: [{ type: "number" }, { type: "string" }] }, { type: "string" }] } }));
    expect(result.parameters).toMatchObject({ type: "object", properties: {} });
    expect(result.issues).toContainEqual({ path: "#", keyword: "projection", action: "tool_fallback" });
  });
  it("preserves numeric/object const meaning without order-sensitive equality", () => {
    const result = project(object({ value: { enum: [{ a: 1, b: 2 }], const: { b: 2, a: 1 } } }));
    expect(result.parameters.properties.value.type).toBe("object");
    expect(() => project(object({ value: { enum: [1], const: 2 } }))).toThrow(/const and enum/);
  });
  it("removes nullable required only from wire and keeps empty objects empty", () => {
    const schema = object({ value: { type: ["string", "null"] }, empty: { type: "object", properties: {} } }, ["value", "empty"]);
    const wire = project(schema).parameters;
    expect(wire.required).toEqual(["empty"]);
    expect(wire.properties.value.type).toBe("string");
    expect(wire.properties.empty).toEqual({ type: "object", properties: {} });
    expect(schema.required).toEqual(["value", "empty"]);
  });
  it("resolves array JSON Pointers and retains ref siblings as conjunction", () => {
    const schema = object({ value: { $ref: "#/$defs/options/anyOf/0", maximum: 3 } });
    schema.$defs = { options: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }] } };
    expect(project(schema).parameters.properties.value).toEqual({ type: "integer", minimum: 1, maximum: 3 });
  });
  it("bounds guidance after mixed-union collapse and repeated projection", () => {
    const schema = object({ value: { anyOf: [{ enum: [{ v: "a".repeat(10000) }] }, { type: "boolean" }] } });
    const wire = project(schema).parameters;
    expect(Buffer.byteLength(wire.properties.value.description)).toBeLessThanOrEqual(512);
    expect(wire.properties.value.description).toContain("[guidance truncated]");
    expect(project(wire).parameters).toEqual(wire);
  });
  it("uses the first non-null type and tuple branch without inventing items", () => {
    const wire = project(object({ value: { type: ["null", "string", "array"], items: { type: "integer" } }, tuple: { type: "array", items: [{ type: "string" }, { type: "integer" }] } })).parameters;
    expect(wire.properties.value.type).toBe("string");
    expect(wire.properties.tuple.items.type).toBe("string");
    expect(project(object({ value: { enum: [[1]] } })).parameters.properties).toEqual({});
  });
  it.each([false, { type: "array", items: { type: "string" } }, { type: "string" }])("rejects non-object root %j without dropping a tool", (schema) => {
    expect(() => project(schema)).toThrow(/tool arguments must be an object/);
  });
});
