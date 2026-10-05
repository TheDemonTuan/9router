import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { ANTIGRAVITY_SCHEMA_LIMITS as LIMITS } from "../../config/antigravitySchema.js";
import { inspectAntigravitySchema, invalidAntigravitySchema, projectAntigravityClaudeToolSchema } from "./antigravityToolSchema.js";

const require = createRequire(import.meta.url);
// Keep resolution at runtime: Turbopack otherwise replaces require.resolve with
// numeric bundle IDs, which are not paths a separate worker can require.
const resolveModule = require.resolve.bind(require);
const paths = {
  "draft-07": resolveModule("ajv"),
  "2019-09": resolveModule("ajv/dist/2019.js"),
  "2020-12": resolveModule("ajv/dist/2020.js"),
};
const workerSource = String.raw`
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
const { createRequire } = await import("node:module");
const require = createRequire(workerData.paths["draft-07"]);
const cache = new Map();
let bytes = 0;
function ajvSchema(schema) {
  const copy = structuredClone(schema);
  // The selected AJV class already supplies the accepted declaration dialect.
  // Normalize the dialect annotation (including draft-07's HTTPS spelling).
  if (copy && typeof copy === "object") delete copy.$schema;
  const visited = new WeakSet();
  const stack = [copy];
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const children = new Set(["items", "additionalProperties", "additionalItems", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]);
  const lists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    // AJV intentionally skips properties.__proto__. An exact pattern applies the
    // same canonical constraint without renaming instance keys or ref targets.
    if (node.properties && Object.hasOwn(node.properties, "__proto__")) {
      const existing = node.patternProperties?.["^__proto__$"];
      node.patternProperties = Object.fromEntries(Object.entries(node.patternProperties || {}));
      node.patternProperties["^__proto__$"] = existing === undefined ? node.properties.__proto__ : { allOf: [existing, node.properties.__proto__] };
    }
    if (node.patternProperties && Object.hasOwn(node.patternProperties, "__proto__")) {
      const existing = node.patternProperties["(?:__proto__)"];
      node.patternProperties["(?:__proto__)"] = existing === undefined ? node.patternProperties.__proto__ : { allOf: [existing, node.patternProperties.__proto__] };
    }
    // Legacy dependencies also skip this key in AJV; preserve its conditional
    // semantics using standard keywords, keeping the original ref target intact.
    if (node.dependencies && Object.hasOwn(node.dependencies, "__proto__")) {
      const dependency = node.dependencies.__proto__;
      node.allOf = [...(node.allOf || []), { if: { required: ["__proto__"] }, then: Array.isArray(dependency) ? { required: dependency } : dependency }];
    }
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key)) stack.push(...Object.values(value));
      else if (key === "dependencies") stack.push(...Object.values(value).filter(child => !Array.isArray(child)));
      else if (lists.has(key) || (key === "items" && Array.isArray(value))) stack.push(...value);
      else if (children.has(key)) stack.push(value);
    }
  }
  return copy;
}
function compiled(entry) {
  if (cache.has(entry.key)) {
    const value = cache.get(entry.key); cache.delete(entry.key); cache.set(entry.key, value); return value.validate;
  }
  const exported = require(workerData.paths[entry.dialect]);
  const Ajv = exported.default || exported;
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, inlineRefs: false, addUsedSchema: false, logger: false });
  let validate;
  try {
    const key = "urn:9router:tool:" + entry.key;
    ajv.addSchema(ajvSchema(entry.schema), key);
    validate = ajv.getSchema(key);
  }
  catch {
    const error = new Error("schema compilation failed");
    error.kind = "schema";
    error.nameForSchema = entry.name;
    error.schemaPath = "#" + (ajv.errors?.[0]?.instancePath || "");
    throw error;
  }
  const size = Buffer.byteLength(entry.json);
  while (cache.size && (cache.size >= workerData.limits.cacheEntries || bytes + size > workerData.limits.cacheBytes)) {
    const key = cache.keys().next().value; bytes -= cache.get(key).size; cache.delete(key);
  }
  if (size <= workerData.limits.cacheBytes) { cache.set(entry.key, { validate, size }); bytes += size; }
  return validate;
}
parentPort.on("message", ({ id, kind, entries, calls }) => {
  try {
    const validators = new Map(entries.map(entry => [entry.name, compiled(entry)]));
    if (kind === "calls") for (const call of calls) {
      const validate = validators.get(call.name);
      if (!validate || !validate(call.args)) {
        const first = validate?.errors?.[0];
        parentPort.postMessage({ id, failure: { kind: "arguments", name: call.name, path: first?.instancePath || "", keyword: first?.keyword || "unknown_tool" } }); return;
      }
    }
    parentPort.postMessage({ id });
  } catch (error) { parentPort.postMessage({ id, failure: { kind: error.kind || "unavailable", name: error.nameForSchema, path: error.schemaPath } }); }
});
})();
`;
const slots = new Set();
const queue = [];
let nextId = 0;
const unavailable = () => Object.assign(new Error("Antigravity tool argument validation unavailable"), { code: "tool_validation_unavailable", status: 503 });
const aborted = (signal) => signal?.reason || Object.assign(new Error("Client aborted validation"), { name: "AbortError", code: "CLIENT_ABORT" });
function dispose(slot) {
  slots.delete(slot);
  clearTimeout(slot.idleTimer);
  slot.worker.removeAllListeners();
  void slot.worker.terminate();
}
function finish(slot, failure, kill = false) {
  const job = slot.job;
  if (!job) return;
  slot.job = null;
  clearTimeout(job.timer);
  job.signal?.removeEventListener("abort", job.onAbort);
  if (kill) dispose(slot);
  else {
    slot.worker.unref();
    slot.idleTimer = setTimeout(() => { if (!slot.job) dispose(slot); }, LIMITS.idleTimeoutMs);
    slot.idleTimer.unref?.();
  }
  if (failure) job.reject(failure); else job.resolve();
  pump();
}
function start(slot, job) {
  clearTimeout(slot.idleTimer);
  clearTimeout(job.waitTimer);
  slot.job = job;
  job.slot = slot;
  slot.worker.ref();
  job.timer = setTimeout(() => finish(slot, unavailable(), true), LIMITS.jobTimeoutMs);
  slot.worker.postMessage({ id: job.id, ...job.payload });
}
function pump() {
  while (queue.length) {
    let slot = [...slots].find(candidate => !candidate.job);
    if (!slot && slots.size < LIMITS.workers) {
      try {
        const worker = new Worker(workerSource, { eval: true, workerData: { paths, limits: LIMITS } });
        slot = { worker, job: null, idleTimer: null };
        slots.add(slot);
        worker.on("message", ({ id, failure }) => {
          if (slot.job?.id !== id) return;
          let error;
          if (failure?.kind === "schema") error = invalidAntigravitySchema(failure.name || "tool", failure.path || "#", "schema compilation failed");
          else if (failure?.kind === "arguments") error = argumentError(failure.name, failure.path, failure.keyword);
          else if (failure) error = unavailable();
          finish(slot, error);
        });
        worker.on("error", () => finish(slot, unavailable(), true));
        worker.on("exit", () => { if (slot.job) finish(slot, unavailable(), true); else { slots.delete(slot); pump(); } });
      } catch {
        const job = queue.shift(); clearTimeout(job.waitTimer); job.signal?.removeEventListener("abort", job.onAbort); job.reject(unavailable()); continue;
      }
    }
    if (!slot) return;
    start(slot, queue.shift());
  }
}
function run(payload, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (queue.length >= LIMITS.queuedJobs) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const job = { id: ++nextId, payload, signal, resolve, reject, slot: null };
    job.onAbort = () => {
      if (job.slot?.job === job) finish(job.slot, aborted(signal), true);
      else {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(job.waitTimer); signal?.removeEventListener("abort", job.onAbort); reject(aborted(signal));
      }
    };
    signal?.addEventListener("abort", job.onAbort, { once: true });
    job.waitTimer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1); signal?.removeEventListener("abort", job.onAbort); reject(unavailable());
    }, LIMITS.queueTimeoutMs);
    queue.push(job); pump();
  });
}
function argumentError(name, path = "", keyword = "type") {
  return Object.assign(new Error(`Antigravity tool arguments failed validation for ${name} at ${path || "/"} (${keyword})`), { code: "invalid_tool_arguments" });
}
function dialectFor(schema, name) {
  const explicit = typeof schema === "object" && schema?.$schema;
  const dialects = {
    "http://json-schema.org/draft-07/schema": "draft-07",
    "https://json-schema.org/draft-07/schema": "draft-07",
    "https://json-schema.org/draft/2019-09/schema": "2019-09",
    "https://json-schema.org/draft/2020-12/schema": "2020-12",
  };
  let tuple = false;
  let prefix = false;
  const visit = [schema];
  // Preflight has already bounded depth/size; instance-valued annotations are excluded.
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const children = new Set(["items", "additionalProperties", "additionalItems", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]);
  const lists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
  while (visit.length) {
    const node = visit.pop();
    if (!node || typeof node !== "object") continue;
    tuple ||= Array.isArray(node.items);
    prefix ||= node.prefixItems !== undefined;
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key)) visit.push(...Object.values(value));
      else if (key === "dependencies") visit.push(...Object.values(value).filter(child => !Array.isArray(child)));
      else if (lists.has(key) || (key === "items" && Array.isArray(value))) visit.push(...value);
      else if (children.has(key)) visit.push(value);
      else if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && (typeof value !== "string" || (value !== "#" && !value.startsWith("#/")))) throw invalidAntigravitySchema(name, `#/${key}`, "only local JSON Pointer references are supported");
    }
  }
  if (tuple && prefix) throw invalidAntigravitySchema(name, "#/items", "cannot mix tuple items and prefixItems");
  const dialect = explicit ? dialects[String(explicit).replace(/#$/, "")] : tuple ? "draft-07" : "2020-12";
  if (!dialect || (tuple && dialect !== "draft-07") || (prefix && dialect === "draft-07")) throw invalidAntigravitySchema(name, "#/$schema", "unsupported schema dialect");
  return dialect;
}
function wireName(name) {
  if (typeof name !== "string" || !name) throw invalidAntigravitySchema("tool", "#/name", "missing tool name");
  let result = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(result)) result = `_${result}`;
  return result.substring(0, 64);
}

// Weak keys tie preflight projections to this request's canonical schema objects.
// Nothing is attached to the provider body or retained after the request dies.
const preparedProjections = new WeakMap();
export function takePreparedAntigravityProjection(schema) {
  if (!schema || typeof schema !== "object") return null;
  const projection = preparedProjections.get(schema);
  preparedProjections.delete(schema);
  return projection || null;
}

export async function prepareAntigravityToolValidation(declarations, { signal } = {}) {
  const entries = [];
  const names = new Map();
  let totalBytes = 0;
  let totalNodes = 0;
  for (const declaration of declarations) {
    const name = wireName(declaration.name);
    const originalName = declaration.originalName || declaration.name;
    if (Object.hasOwn(declaration, "parameters") && Object.hasOwn(declaration, "parametersJsonSchema")) throw invalidAntigravitySchema(originalName, "#", "parameters and parametersJsonSchema are mutually exclusive");
    const sourceSchema = Object.hasOwn(declaration, "parametersJsonSchema") ? declaration.parametersJsonSchema : declaration.parameters;
    const schema = structuredClone(sourceSchema === undefined ? { type: "object", properties: {} } : sourceSchema);
    const { json, bytes, nodes } = inspectAntigravitySchema(schema, { toolName: originalName });
    totalBytes += bytes; totalNodes += nodes;
    if (totalBytes > LIMITS.canonicalBytes || totalNodes > LIMITS.nodes) throw invalidAntigravitySchema(originalName, "#", "request schema resource limit exceeded");
    // Projection is preflighted here too: malformed schemas never reach provider dispatch.
    const projection = projectAntigravityClaudeToolSchema(schema, { toolName: originalName });
    if (sourceSchema && typeof sourceSchema === "object") preparedProjections.set(sourceSchema, projection.parameters);
    const dialect = dialectFor(schema, originalName);
    const key = createHash("sha256").update(dialect).update("\0").update(json).digest("hex");
    if (names.has(name)) {
      const previous = names.get(name);
      if (previous.originalName !== originalName || previous.key !== key) throw invalidAntigravitySchema(originalName, "#/name", "tool name collision");
      continue;
    }
    const entry = { name, originalName, schema, json, dialect, key };
    entries.push(entry); names.set(name, entry); names.set(originalName, entry);
  }
  if (entries.length) await run({ kind: "prepare", entries }, signal);
  return { entries, names, signal };
}
function normalizeCall(name, args, context) {
  const entry = context.names.get(name);
  if (!entry) throw argumentError(name, "", "unknown_tool");
  const value = args === undefined ? {} : args;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw argumentError(name, "", "type");
  let json;
  try { json = JSON.stringify(value); } catch { throw argumentError(name, "", "json"); }
  if (Buffer.byteLength(json) > LIMITS.argumentBytes) throw argumentError(name, "", "argument_limit");
  return { name: entry.name, args: value };
}
async function validateCalls(calls, context, signal) {
  if (!context || !calls.length) return;
  signal ||= context.signal;
  try { await run({ kind: "calls", entries: context.entries.filter(entry => calls.some(call => call.name === entry.name)), calls }, signal); }
  catch (error) {
    if (signal?.aborted) throw aborted(signal);
    if (error.code === "invalid_tool_arguments") throw error;
    throw Object.assign(new Error("Antigravity tool argument validation unavailable"), { code: "invalid_tool_arguments" });
  }
}
export async function validateAntigravityToolCalls(providerChunk, context, { signal } = {}) {
  if (!context) return;
  const response = providerChunk?.response || providerChunk;
  const calls = [];
  for (const candidate of response?.candidates || []) for (const part of candidate.content?.parts || []) {
    if (Object.hasOwn(part, "functionCall")) calls.push(normalizeCall(part.functionCall?.name, part.functionCall?.args, context));
  }
  await validateCalls(calls, context, signal);
}
export async function validateAntigravityChatToolCalls(completion, context, { signal } = {}) {
  if (!context) return;
  const calls = [];
  for (const choice of completion?.choices || []) for (const call of choice.message?.tool_calls || []) {
    let args;
    try { args = call.function?.arguments === undefined ? {} : JSON.parse(call.function.arguments); }
    catch { throw argumentError(call.function?.name, "", "json"); }
    calls.push(normalizeCall(call.function?.name, args, context));
  }
  await validateCalls(calls, context, signal);
}
