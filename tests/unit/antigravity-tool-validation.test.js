import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

// Keep real AJV workers. Only resource deadlines are shortened after both workers
// have compiled the test schemas, so startup speed is not part of the assertion.
const resources = vi.hoisted(() => ({ limits: {}, defaults: {} }));
vi.mock("../../open-sse/config/antigravitySchema.js", async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(resources.defaults, actual.ANTIGRAVITY_SCHEMA_LIMITS);
  Object.assign(resources.limits, resources.defaults);
  return { ...actual, ANTIGRAVITY_SCHEMA_LIMITS: resources.limits };
});

import {
  prepareAntigravityToolValidation,
  validateAntigravityToolCalls,
  validateAntigravityChatToolCalls,
} from "../../open-sse/translator/concerns/antigravityToolValidation.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const declaration = (schema, name = "schema_probe") => ({ name, parameters: schema });
const prepare = (schema, name) => prepareAntigravityToolValidation([declaration(schema, name)]);
const chunk = (...calls) => ({ candidates: [{ content: { parts: calls.map((functionCall) => ({ functionCall })) } }] });
const check = (context, args, name = "schema_probe", options) => validateAntigravityToolCalls(chunk({ name, args }), context, options);
const objectWith = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const capture = (promise) => promise.then(() => ({ ok: true }), (error) => ({ error }));

async function expectInvalid(context, args, { name = "schema_probe", keyword, path } = {}) {
  const outcome = await capture(check(context, args, name));
  expect(outcome.error).toMatchObject({ code: "invalid_tool_arguments" });
  expect(outcome.error.message).toContain(`Antigravity tool arguments failed validation for ${name} at `);
  if (keyword) expect(outcome.error.message).toContain(`(${keyword})`);
  if (path) expect(outcome.error.message).toContain(` at ${path} `);
  return outcome.error;
}

function taskSchema() {
  return {
    type: "object",
    properties: {
      i: { type: "string" },
      context: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: { type: "string" },
            solutionSpace: { type: "string" },
            model: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
            outputSchema: { anyOf: [{ type: "object", properties: {} }, { type: "boolean" }, { type: "string" }, { type: "null" }] },
          },
          required: ["task", "solutionSpace"],
          additionalProperties: false,
        },
      },
      model: { not: true },
    },
    required: ["i", "context", "tasks"],
    additionalProperties: false,
  };
}

function taskArgs(overrides = {}) {
  return { i: "Testing schema", context: "Synthetic context", tasks: [{ task: "Synthetic task", solutionSpace: "One fixed change", ...overrides }] };
}

afterEach(() => {
  Object.assign(resources.limits, resources.defaults);
  vi.restoreAllMocks();
});

describe("Antigravity canonical tool argument validation", () => {
  it("accepts every original nested task union branch without altering the schema or arguments", async () => {
    const schema = taskSchema();
    const original = structuredClone(schema);
    const context = await prepare(schema, "task");
    for (const model of ["model-a", ["model-a", "model-b"]]) {
      for (const outputSchema of [{ properties: { value: { type: "string" } } }, false, true, "schema", null]) {
        const args = taskArgs({ model, outputSchema });
        const snapshot = structuredClone(args);
        await expect(check(context, args, "task")).resolves.toBeUndefined();
        expect(args).toEqual(snapshot);
      }
    }
    await expect(check(context, taskArgs(), "task")).resolves.toBeUndefined();
    expect(schema).toEqual(original);
  });

  it.each([
    ["number model", () => taskArgs({ model: 42 })],
    ["non-string model list element", () => taskArgs({ model: ["model-a", 42] })],
    ["number outputSchema", () => taskArgs({ outputSchema: 42 })],
    ["forbidden root model", () => ({ ...taskArgs(), model: "forbidden" })],
    ["missing nested required field", () => ({ ...taskArgs(), tasks: [{ task: "Synthetic task" }] })],
    ["missing root required field", () => { const args = taskArgs(); delete args.context; return args; }],
    ["unexpected root field", () => ({ ...taskArgs(), extra: true })],
    ["unexpected nested field", () => taskArgs({ extra: true })],
  ])("rejects %s against the canonical schema", async (_label, buildArgs) => {
    const context = await prepare(taskSchema(), "task");
    await expectInvalid(context, buildArgs(), { name: "task" });
  });

  it.each([
    { anyOf: [{ type: "string" }, { type: "null" }] },
    { type: ["string", "null"] },
  ])("preserves nullable required fields independently of wire omission guidance: %j", async (nullable) => {
    const context = await prepare(objectWith({ value: nullable }));
    await expect(check(context, { value: null })).resolves.toBeUndefined();
    await expect(check(context, { value: "ok" })).resolves.toBeUndefined();
    await expectInvalid(context, {}, { keyword: "required" });
  });

  it("accepts an empty-object and parameterless tool without inventing required arguments", async () => {
    const empty = await prepare({ type: "object", properties: {}, additionalProperties: false });
    await expect(check(empty, {})).resolves.toBeUndefined();
    await expect(check(empty, undefined)).resolves.toBeUndefined();
    await expectInvalid(empty, { reason: "not a declared field" }, { keyword: "additionalProperties" });
    const parameterless = await prepareAntigravityToolValidation([{ name: "schema_probe" }]);
    await expect(check(parameterless, undefined)).resolves.toBeUndefined();
    const permissive = await prepare(true);
    await expect(check(permissive, {})).resolves.toBeUndefined();
  });

  it.each([null, [], "{}", 1, true])("rejects non-object raw arguments without JSON parsing or coercion: %j", async (args) => {
    const context = await prepare({ type: "object", properties: {} });
    await expectInvalid(context, args, { keyword: "type" });
  });

  it("rejects unknown tool names and checks all candidates and calls in a chunk", async () => {
    const context = await prepare(objectWith({ value: { type: "string" } }));
    await expectInvalid(context, { value: "ok" }, { name: "undeclared", keyword: "unknown_tool" });
    const response = {
      response: {
        candidates: [
          { content: { parts: [{ functionCall: { name: "schema_probe", args: { value: "ok" } } }] } },
          { content: { parts: [{ text: "Synthetic text" }, { functionCall: { name: "schema_probe", args: { value: 4 } } }] } },
        ],
      },
    };
    await expect(validateAntigravityToolCalls(response, context)).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    await expect(validateAntigravityToolCalls(chunk(
      { name: "schema_probe", args: { value: "ok" } },
      { name: "schema_probe", args: {} },
    ), context)).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("validates Chat aggregate JSON and restored names against the same original types", async () => {
    const context = await prepareAntigravityToolValidation([
      { name: "schema_probe", originalName: "schema probe", parameters: taskSchema() },
    ]);
    const chat = (args, name = "schema probe") => ({ choices: [{ message: { tool_calls: [{
      id: "call_synthetic", type: "function", function: { name, arguments: JSON.stringify(args) },
    }] } }] });
    const completion = chat(taskArgs({ model: ["a", "b"], outputSchema: false }));
    const before = structuredClone(completion);
    await expect(validateAntigravityChatToolCalls(completion, context)).resolves.toBeUndefined();
    expect(completion).toEqual(before);
    await expect(validateAntigravityChatToolCalls(chat(taskArgs({ model: 4 })), context)).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    await expect(validateAntigravityChatToolCalls(chat([], "schema_probe"), context)).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    const malformed = chat({});
    malformed.choices[0].message.tool_calls[0].function.arguments = "{unfinished";
    await expect(validateAntigravityChatToolCalls(malformed, context)).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("retains keyword-looking, extension-looking, and __proto__ property names as data", async () => {
    const names = ["default", "enum", "anyOf", "x-user-id", "__proto__"];
    const properties = Object.fromEntries(names.map((name) => [name, { type: "string" }]));
    const args = Object.fromEntries(names.map((name) => [name, `synthetic-${name}`]));
    const context = await prepare(objectWith(properties));
    await expect(check(context, args)).resolves.toBeUndefined();
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    for (const name of names) {
      const incomplete = structuredClone(args);
      delete incomplete[name];
      await expectInvalid(context, incomplete, { keyword: "required" });
    }
    const wrongType = Object.fromEntries(Object.entries(args).map(([name, value]) => [name, name === "__proto__" ? 7 : value]));
    await expectInvalid(context, wrongType);
    expect(Object.prototype).not.toHaveProperty("synthetic-pollution");
  });

  it("does not traverse object enum values or annotations as schema nodes", async () => {
    const value = JSON.parse('{"default":{"type":"not-a-schema-type"},"enum":[],"anyOf":"data","x-user-id":4,"__proto__":{"synthetic-pollution":true},"$ref":"https://example.invalid/data-only"}');
    const schema = objectWith({ value: { type: "object", enum: [value], default: value, examples: [value] } });
    const snapshot = structuredClone(schema);
    const context = await prepare(schema);
    await expect(check(context, { value: structuredClone(value) })).resolves.toBeUndefined();
    await expectInvalid(context, { value: { ...value, "x-user-id": 5 } }, { keyword: "enum" });
    expect(schema).toEqual(snapshot);
    expect(Object.prototype).not.toHaveProperty("synthetic-pollution");
  });

  it.each([
    ["numeric", { type: "integer", enum: [1, 2] }, 1, "1"],
    ["boolean", { type: "boolean", enum: [true] }, true, "true"],
    ["const", { const: false }, false, "false"],
  ])("enforces typed %s values without stringification", async (_label, field, valid, invalid) => {
    const context = await prepare(objectWith({ value: field }));
    await expect(check(context, { value: valid })).resolves.toBeUndefined();
    await expectInvalid(context, { value: invalid });
  });

  it("does not insert defaults, coerce numbers, or remove additional properties", async () => {
    const context = await prepare(objectWith({ value: { type: "integer", default: 1 } }));
    for (const args of [{}, { value: "1" }, { value: 1, extra: true }]) {
      const original = structuredClone(args);
      await expectInvalid(context, args);
      expect(args).toEqual(original);
    }
  });

  it("keeps argument and enum/const values out of failure messages", async () => {
    const context = await prepare(objectWith({ value: { const: "SYNTHETIC_ALLOWED_SECRET" } }));
    const error = await expectInvalid(context, { value: "SYNTHETIC_INVALID_SECRET" }, { keyword: "const", path: "/value" });
    expect(error.message).not.toContain("SYNTHETIC_ALLOWED_SECRET");
    expect(error.message).not.toContain("SYNTHETIC_INVALID_SECRET");
  });
});

describe("canonical compositions, references, and dialects", () => {
  it("enforces exactly-one semantics when oneOf branches overlap", async () => {
    const context = await prepare(objectWith({ value: { oneOf: [{ type: "integer" }, { type: "number" }] } }));
    await expect(check(context, { value: 1.5 })).resolves.toBeUndefined();
    await expectInvalid(context, { value: 1 }, { keyword: "oneOf" });
    await expectInvalid(context, { value: "1" });
  });

  it("enforces allOf property conjunctions and the union of required fields", async () => {
    const schema = {
      type: "object",
      allOf: [
        { properties: { count: { type: "number", minimum: 2 }, left: { type: "string" } }, required: ["count", "left"] },
        { properties: { count: { type: "integer", maximum: 4 }, right: { type: "string" } }, required: ["right"] },
      ],
    };
    const context = await prepare(schema);
    await expect(check(context, { count: 3, left: "a", right: "b" })).resolves.toBeUndefined();
    for (const args of [{ count: 1, left: "a", right: "b" }, { count: 5, left: "a", right: "b" }, { count: 2.5, left: "a", right: "b" }, { count: 3, left: "a" }]) {
      await expectInvalid(context, args);
    }
  });

  it("retains conflicting allOf constraints when wire projection requires fallback", async () => {
    const context = await prepare(objectWith({ value: { allOf: [{ type: "number", minimum: 5 }, { type: "number", minimum: 1, maximum: 3 }] } }));
    for (const value of [0, 2, 6]) await expectInvalid(context, { value });
  });

  it.each(["$defs", "definitions"])("resolves escaped local JSON Pointers in %s with own-key lookup", async (mapName) => {
    const schema = objectWith({ value: { $ref: `#/${mapName}/a~1b~0c` }, special: { $ref: `#/${mapName}/__proto__` } });
    schema[mapName] = Object.fromEntries([
      ["a/b~c", { type: "string", pattern: "^ok$" }],
      ["__proto__", { type: "integer" }],
    ]);
    const context = await prepare(schema);
    await expect(check(context, { value: "ok", special: 1 })).resolves.toBeUndefined();
    await expectInvalid(context, { value: "no", special: 1 }, { keyword: "pattern" });
    await expectInvalid(context, { value: "ok", special: "1" });
  });

  it("treats local $ref siblings as conjunction rather than overwriting the target", async () => {
    const schema = objectWith({ value: { $ref: "#/$defs/count", maximum: 3 } });
    schema.$defs = { count: { type: "integer", minimum: 2 } };
    const context = await prepare(schema);
    await expect(check(context, { value: 2 })).resolves.toBeUndefined();
    await expectInvalid(context, { value: 1 });
    await expectInvalid(context, { value: 4 });
  });

  it.each(["#/$defs/missing", "#/$defs/a~2b", "https://example.invalid/schema", "file:///synthetic/schema.json"])("rejects missing, malformed, or remote ref %s before dispatch", async ($ref) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network must not be used"));
    await expect(prepare(objectWith({ value: { $ref } }))).rejects.toMatchObject({ code: "invalid_tool_schema" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates finite recursive arguments against the full schema despite wire fallback", async () => {
    const schema = {
      type: "object",
      properties: { value: { type: "integer" }, next: { anyOf: [{ $ref: "#" }, { type: "null" }] } },
      required: ["value"], additionalProperties: false,
    };
    const context = await prepare(schema);
    await expect(check(context, { value: 1, next: { value: 2, next: { value: 3, next: null } } })).resolves.toBeUndefined();
    await expectInvalid(context, { value: 1, next: { value: "2" } });
    await expectInvalid(context, { value: 1, next: { extra: true } });
  });

  it("still enforces canonical refs when acyclic expansion exceeds the wire projection budget", async () => {
    const defs = {};
    defs.level15 = { type: "integer" };
    for (let level = 14; level >= 0; level--) {
      defs[`level${level}`] = {
        type: "object", properties: {
          left: { $ref: `#/$defs/level${level + 1}` },
          right: { $ref: `#/$defs/level${level + 1}` },
        }, additionalProperties: false,
      };
    }
    const schema = { ...objectWith({ tree: { $ref: "#/$defs/level0" } }), $defs: defs };
    const context = await prepare(schema);
    await expect(check(context, { tree: {} })).resolves.toBeUndefined();
    let badLeaf = "not-an-integer";
    for (let level = 14; level >= 0; level--) badLeaf = { left: badLeaf };
    await expectInvalid(context, { tree: badLeaf });
  });

  it.each([
    ["draft-07 explicit", "http://json-schema.org/draft-07/schema#", false],
    ["draft-07 inferred tuple", undefined, false],
    ["2020-12 explicit", "https://json-schema.org/draft/2020-12/schema", true],
    ["2020-12 inferred", undefined, true],
  ])("enforces tuple position and trailing items in %s", async (_label, dialect, modern) => {
    const tuple = modern
      ? { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false, minItems: 2 }
      : { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false, minItems: 2 };
    const schema = objectWith({ pair: tuple });
    if (dialect) schema.$schema = dialect;
    const context = await prepare(schema);
    await expect(check(context, { pair: ["ok", 1] })).resolves.toBeUndefined();
    await expectInvalid(context, { pair: [1, "ok"] });
    await expectInvalid(context, { pair: ["ok", 1, true] });
    await expectInvalid(context, { pair: ["ok"] });
  });

  it("supports explicit 2019-09 dependentRequired without reducing it to a wire hint", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object", properties: { left: { type: "string" }, right: { type: "string" } },
      dependentRequired: { left: ["right"] }, additionalProperties: false,
    };
    const context = await prepare(schema);
    await expect(check(context, {})).resolves.toBeUndefined();
    await expect(check(context, { left: "a", right: "b" })).resolves.toBeUndefined();
    await expectInvalid(context, { left: "a" }, { keyword: "dependentRequired" });
  });

  it("enforces conditionals, not, boolean schemas, and patternProperties", async () => {
    const schema = {
      type: "object", properties: {
        mode: { enum: ["left", "right"] }, left: { type: "integer" }, right: { type: "string" }, prohibited: false,
      },
      patternProperties: { "^x-": { type: "boolean" } }, additionalProperties: false,
      required: ["mode"],
      if: { properties: { mode: { const: "left" } } },
      then: { required: ["left"] }, else: { required: ["right"] },
      not: { required: ["left", "right"] },
    };
    const context = await prepare(schema);
    await expect(check(context, { mode: "left", left: 1, "x-flag": true })).resolves.toBeUndefined();
    await expect(check(context, { mode: "right", right: "ok" })).resolves.toBeUndefined();
    for (const args of [{ mode: "left" }, { mode: "left", left: 1, right: "both" }, { mode: "right", right: "ok", prohibited: true }, { mode: "left", left: 1, "x-flag": "true" }]) {
      await expectInvalid(context, args);
    }
  });

  it("treats format and unknown extension keywords as annotations", async () => {
    const context = await prepare(objectWith({ value: { type: "string", format: "email", "x-custom-keyword": { anyOf: "annotation data" } } }));
    await expect(check(context, { value: "not-an-email" })).resolves.toBeUndefined();
  });

  it.each([
    { $schema: "http://json-schema.org/draft-04/schema#" },
    { $schema: "https://example.invalid/unsupported-dialect" },
    { $async: true },
    { properties: { tuple: { type: "array", items: [{ type: "string" }], prefixItems: [{ type: "string" }] } } },
    { $schema: "http://json-schema.org/draft-07/schema#", properties: { tuple: { type: "array", prefixItems: [{ type: "string" }] } } },
  ])("rejects unsupported dialect or asynchronous/mixed tuple schema: %j", async (extra) => {
    await expect(prepare({ type: "object", ...extra })).rejects.toMatchObject({ code: "invalid_tool_schema" });
  });

  it("isolates schemas sharing $id across concurrent contexts and repeated cached validation", async () => {
    const id = "https://example.invalid/shared-id";
    const [strings, integers] = await Promise.all([
      prepare({ ...objectWith({ value: { type: "string" } }), $id: id }),
      prepare({ ...objectWith({ value: { type: "integer" } }), $id: id }),
    ]);
    for (let round = 0; round < 3; round++) {
      await Promise.all([
        expect(check(strings, { value: "ok" })).resolves.toBeUndefined(),
        expect(check(integers, { value: 1 })).resolves.toBeUndefined(),
        expectInvalid(strings, { value: 1 }),
        expectInvalid(integers, { value: "1" }),
      ]);
    }
  });
});

describe("fail-closed schema and argument resource limits", () => {
  it("rejects oversized schemas, including the aggregate bytes across declarations", async () => {
    const bytes = resources.defaults.canonicalBytes;
    await expect(prepare({ type: "object", description: "x".repeat(bytes) })).rejects.toMatchObject({ code: "invalid_tool_schema" });
    const half = { type: "object", description: "x".repeat(Math.floor(bytes / 2) + 1) };
    await expect(prepareAntigravityToolValidation([declaration(half, "left"), declaration(half, "right")])).rejects.toMatchObject({ code: "invalid_tool_schema" });
  });

  it("rejects schema depth before recursive projection or compile", async () => {
    let schema = { type: "string" };
    for (let level = 0; level <= resources.defaults.depth; level++) schema = objectWith({ child: schema });
    await expect(prepare(schema)).rejects.toMatchObject({ code: "invalid_tool_schema" });
  });

  it("rejects total canonical nodes across otherwise individually bounded declarations", async () => {
    const count = Math.floor(resources.defaults.nodes / 2) + 1;
    const properties = Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, { type: "string" }]));
    const schema = { type: "object", properties };
    await expect(prepareAntigravityToolValidation([declaration(schema, "left"), declaration(schema, "right")])).rejects.toMatchObject({ code: "invalid_tool_schema" });
  });

  it("rejects oversized arguments without truncation or attempting recovery", async () => {
    const context = await prepare(objectWith({ value: { type: "string" } }));
    const args = { value: "x".repeat(resources.defaults.argumentBytes) };
    await expectInvalid(context, args);
    expect(args.value.length).toBe(resources.defaults.argumentBytes);
  });

  it.each([
    { type: "string" }, { type: "array", items: { type: "string" } }, false,
    { type: "object", properties: [] }, { type: "object", required: "value" },
    { type: "object", properties: { value: { enum: [] } } },
    { type: "object", properties: { value: { const: 1, enum: [2] } } },
  ])("rejects malformed or non-object tool schemas rather than applying permissive fallback: %j", async (schema) => {
    await expect(prepare(schema)).rejects.toMatchObject({ code: "invalid_tool_schema" });
  });

  it("rejects mutually exclusive fields and colliding names but accepts exact duplicate declarations", async () => {
    const schema = objectWith({ value: { type: "string" } });
    await expect(prepareAntigravityToolValidation([{ name: "probe", parameters: schema, parametersJsonSchema: schema }])).rejects.toMatchObject({ code: "invalid_tool_schema" });
    await expect(prepareAntigravityToolValidation([declaration(schema, "probe space"), declaration(schema, "probe_space")])).rejects.toMatchObject({ code: "invalid_tool_schema" });
    await expect(prepareAntigravityToolValidation([declaration(schema, "probe"), declaration(objectWith({ value: { type: "integer" } }), "probe")])).rejects.toMatchObject({ code: "invalid_tool_schema" });
    const duplicate = await prepareAntigravityToolValidation([declaration(schema), declaration(structuredClone(schema))]);
    await expect(check(duplicate, { value: "ok" })).resolves.toBeUndefined();
    const jsonSchema = await prepareAntigravityToolValidation([{ name: "schema_probe", parametersJsonSchema: schema }]);
    await expect(check(jsonSchema, { value: "ok" })).resolves.toBeUndefined();
  });
});

// This regex and input are deliberately synthetic. A synchronous validation on
// the HTTP/event-loop thread would prevent the heartbeat and abort timers firing.
const pathological = { value: `${"a".repeat(100000)}!` };
async function warmWorkers() {
  const schema = objectWith({ value: { type: "string", pattern: "^(a+)+$" } });
  const contexts = await Promise.all([prepare(schema), prepare(schema)]);
  await Promise.all(contexts.map((context) => check(context, { value: "aaa" })));
  return contexts;
}

describe("real worker deadlines and cancellation", () => {
  it("terminates pathological validation at its deadline while the event loop remains responsive", async () => {
    const [context] = await warmWorkers();
    resources.limits.jobTimeoutMs = 500;
    const pending = capture(check(context, pathological));
    const first = await Promise.race([
      pending.then(() => "validation"),
      delay(25).then(() => "heartbeat"),
    ]);
    const result = await pending;
    expect(first).toBe("heartbeat");
    expect(result.error).toMatchObject({ code: "invalid_tool_arguments" });
    expect(result.error.message).toBe("Antigravity tool argument validation unavailable");
    Object.assign(resources.limits, resources.defaults);
    await expect(check(context, { value: "aaa" })).resolves.toBeUndefined();
  }, 10000);

  it("preserves an active client abort and permits subsequent validation after worker termination", async () => {
    const [context] = await warmWorkers();
    const controller = new AbortController();
    const reason = new DOMException("Synthetic active abort", "AbortError");
    const pending = capture(check(context, pathological, "schema_probe", { signal: controller.signal }));
    try {
      await delay(25);
      controller.abort(reason);
      const result = await pending;
      expect(result.error).toBe(reason);
      await expect(check(context, { value: "aaa" })).resolves.toBeUndefined();
    } finally {
      controller.abort(reason);
      await pending;
    }
  }, 10000);

  it("cancels queued validation without waiting for occupied workers and cleans up active jobs", async () => {
    const contexts = await warmWorkers();
    const active = [new AbortController(), new AbortController()];
    const blockers = contexts.map((context, index) => capture(check(context, pathological, "schema_probe", { signal: active[index].signal })));
    const queued = new AbortController();
    const reason = new DOMException("Synthetic queued abort", "AbortError");
    const pending = capture(check(contexts[0], { value: "aaa" }, "schema_probe", { signal: queued.signal }));
    try {
      queued.abort(reason);
      const result = await pending;
      expect(result.error).toBe(reason);
      active.forEach((controller) => controller.abort(new DOMException("Synthetic cleanup", "AbortError")));
      await Promise.all(blockers);
      await expect(check(contexts[0], { value: "aaa" })).resolves.toBeUndefined();
    } finally {
      queued.abort(reason);
      active.forEach((controller) => controller.abort());
      await Promise.all(blockers);
      await pending;
    }
  }, 10000);

  it("fails closed when a queued job exceeds its wait deadline", async () => {
    const contexts = await warmWorkers();
    resources.limits.queueTimeoutMs = 150;
    const active = [new AbortController(), new AbortController()];
    const blockers = contexts.map((context, index) => capture(check(context, pathological, "schema_probe", { signal: active[index].signal })));
    const pending = capture(check(contexts[0], { value: "aaa" }));
    try {
      const result = await pending;
      expect(result.error).toMatchObject({ code: "invalid_tool_arguments" });
      expect(result.error.message).toBe("Antigravity tool argument validation unavailable");
    } finally {
      active.forEach((controller) => controller.abort());
      await Promise.all(blockers);
      await pending;
    }
    Object.assign(resources.limits, resources.defaults);
    await expect(check(contexts[0], { value: "aaa" })).resolves.toBeUndefined();
  }, 10000);

  it("rejects an already-aborted prepare without turning the client abort into a schema failure", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic preparation abort", "AbortError");
    controller.abort(reason);
    const result = await capture(prepareAntigravityToolValidation([declaration({ type: "object" })], { signal: controller.signal }));
    expect(result.error).toBe(reason);
  });

  it("allows a process to exit after real validation without waiting for idle workers", async () => {
    const moduleUrl = new URL("../../open-sse/translator/concerns/antigravityToolValidation.js", import.meta.url).href;
    const script = `
      const { prepareAntigravityToolValidation, validateAntigravityToolCalls } = await import(process.argv[1]);
      const context = await prepareAntigravityToolValidation([{ name: "probe", parameters: { type: "object" } }]);
      await validateAntigravityToolCalls({ candidates: [{ content: { parts: [{ functionCall: { name: "probe", args: {} } }] } }] }, context);
      process.stdout.write("validated");
    `;
    const child = spawn("node", ["--input-type=module", "--eval", script, moduleUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    let deadlineExpired = false;
    const timer = setTimeout(() => { deadlineExpired = true; child.kill(); }, 8000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(deadlineExpired).toBe(false);
      expect(result, stderr).toEqual({ code: 0, signal: null });
      expect(stdout).toBe("validated");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 10000);

  it("does not start validation work for text-only chunks, even when a schema worker would be unavailable", async () => {
    const [context] = await warmWorkers();
    resources.limits.jobTimeoutMs = 0;
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic no-call abort", "AbortError"));
    await expect(validateAntigravityToolCalls({ candidates: [{ content: { parts: [{ text: "Only synthetic text" }] } }] }, context, { signal: controller.signal })).resolves.toBeUndefined();
    await expect(validateAntigravityChatToolCalls({ choices: [{ message: { content: "Only synthetic text" } }] }, context, { signal: controller.signal })).resolves.toBeUndefined();
  }, 10000);
});

describe("canonical prototype map constraints", () => {
  it("enforces prototype-named properties inside legacy schema dependencies", async () => {
    const schema = JSON.parse('{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","dependencies":{"trigger":{"properties":{"__proto__":{"type":"string"}}}}}');
    const context = await prepare(schema);
    await expect(check(context, JSON.parse('{"trigger":true,"__proto__":"ok"}'))).resolves.toBeUndefined();
    await expectInvalid(context, JSON.parse('{"trigger":true,"__proto__":123}'));
  });
  it("enforces a literal prototype-named regex without changing instance names", async () => {
    const context = await prepare(JSON.parse('{"type":"object","patternProperties":{"__proto__":{"type":"string"}}}'));
    await expect(check(context, JSON.parse('{"x__proto__x":"ok"}'))).resolves.toBeUndefined();
    await expectInvalid(context, JSON.parse('{"x__proto__x":123}'));
  });
  it.each(['["other"]', '{"required":["other"]}'])("enforces prototype-triggered legacy dependency %s", async (dependency) => {
    const schema = JSON.parse('{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","dependencies":{"__proto__":' + dependency + '}}');
    const context = await prepare(schema);
    await expect(check(context, {})).resolves.toBeUndefined();
    await expect(check(context, JSON.parse('{"__proto__":1,"other":true}'))).resolves.toBeUndefined();
    await expectInvalid(context, JSON.parse('{"__proto__":1}'));
  });
  it("accepts the HTTPS draft-07 spelling using the chosen draft validator", async () => {
    const context = await prepare({ $schema: "https://json-schema.org/draft-07/schema#", ...objectWith({ value: { type: "integer" } }) });
    await expect(check(context, { value: 1 })).resolves.toBeUndefined();
    await expectInvalid(context, { value: "1" });
  });
});
