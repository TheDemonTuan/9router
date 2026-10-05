import { ANTIGRAVITY_SCHEMA_LIMITS as LIMITS } from "../../config/antigravitySchema.js";

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const pointer = (path, key) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const children = new Set(["items", "additionalProperties", "additionalItems", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]);
const lists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const same = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && same(a[key], b[key]));
};
const empty = () => ({ type: "object", properties: {} });
class ProjectionUnavailable extends Error {}

export function isAntigravityClaudeModel(model) {
  return String(model || "").toLowerCase().includes("claude");
}

export function invalidAntigravitySchema(toolName, path, reason) {
  const error = new Error(`Invalid Antigravity tool schema for ${toolName} at ${path || "#"}: ${reason}`);
  error.code = "invalid_tool_schema";
  return error;
}

// Iterative preflight bounds input before any recursive projection or AJV work.
export function inspectAntigravitySchema(schema, { toolName = "tool" } = {}) {
  let json;
  try { json = JSON.stringify(schema); } catch { throw invalidAntigravitySchema(toolName, "#", "schema must be JSON"); }
  if (json === undefined || Buffer.byteLength(json) > LIMITS.canonicalBytes) throw invalidAntigravitySchema(toolName, "#", "schema byte limit exceeded");
  const stack = [[schema, "#", 0]];
  let count = 0;
  while (stack.length) {
    const [node, path, depth] = stack.pop();
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw invalidAntigravitySchema(toolName, path, "schema complexity limit exceeded");
    if (typeof node === "boolean") continue;
    if (!record(node)) throw invalidAntigravitySchema(toolName, path, "expected object or boolean schema");
    for (const [key, value] of Object.entries(node)) {
      const location = pointer(path, key);
      if (maps.has(key)) {
        if (!record(value)) throw invalidAntigravitySchema(toolName, location, "expected schema map");
        for (const [name, child] of Object.entries(value)) stack.push([child, pointer(location, name), depth + 1]);
      } else if (lists.has(key) || (key === "items" && Array.isArray(value))) {
        if (!Array.isArray(value) || !value.length) throw invalidAntigravitySchema(toolName, location, "expected nonempty schema array");
        value.forEach((child, index) => stack.push([child, pointer(location, index), depth + 1]));
      } else if (children.has(key)) stack.push([value, location, depth + 1]);
      else if (key === "dependencies") {
        if (!record(value)) throw invalidAntigravitySchema(toolName, location, "expected dependency map");
        for (const [name, child] of Object.entries(value)) {
          if (Array.isArray(child)) {
            if (!child.every(item => typeof item === "string")) throw invalidAntigravitySchema(toolName, pointer(location, name), "invalid property dependency");
          } else stack.push([child, pointer(location, name), depth + 1]);
        }
      }
      else if (key === "type" && !(typeof value === "string" ? types.has(value) : Array.isArray(value) && value.length && value.every(type => types.has(type)))) throw invalidAntigravitySchema(toolName, location, "invalid type");
      else if (key === "required" && (!Array.isArray(value) || !value.every(name => typeof name === "string") || new Set(value).size !== value.length)) throw invalidAntigravitySchema(toolName, location, "invalid required array");
      else if (key === "enum" && (!Array.isArray(value) || !value.length)) throw invalidAntigravitySchema(toolName, location, "empty or invalid enum");
      else if (key === "$ref" && typeof value !== "string") throw invalidAntigravitySchema(toolName, location, "invalid reference");
      else if (key === "$async") throw invalidAntigravitySchema(toolName, location, "async schemas are unsupported");
    }
  }
  return { json, bytes: Buffer.byteLength(json), nodes: count };
}

export function projectAntigravityClaudeToolSchema(schema, { toolName = "tool" } = {}) {
  const root = schema === undefined ? empty() : schema;
  inspectAntigravitySchema(root, { toolName });
  const issues = [];
  let expanded = 0;
  let guidanceBytes = 0;
  const activeRefs = new Set();
  const guidanceAtNode = new WeakMap();
  const lossyUnions = new WeakSet();
  let expansionDepth = 0;
  const cloneProjected = (node) => {
    const copy = Object.fromEntries(Object.entries(node));
    guidanceAtNode.set(copy, guidanceAtNode.get(node) || 0);
    if (lossyUnions.has(node)) lossyUnions.add(copy);
    return copy;
  };
  const fail = (path, reason) => { throw invalidAntigravitySchema(toolName, path, reason); };
  const hint = (node, path, keyword, text) => {
    issues.push({ path, keyword, action: "guidance" });
    if (!text || node.description?.includes(`Schema guidance: ${text}`)) return;
    const marker = " [guidance truncated]";
    const separatorBytes = node.description ? 1 : 0;
    const available = Math.min(LIMITS.guidanceNodeBytes - (guidanceAtNode.get(node) || 0), LIMITS.guidanceToolBytes - guidanceBytes) - separatorBytes;
    if (available <= Buffer.byteLength(marker)) return;
    let suffix = `Schema guidance: ${text}`;
    if (Buffer.byteLength(suffix) > available) {
      let low = 0;
      let high = Math.min(suffix.length, available);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(suffix.slice(0, middle) + marker) <= available) low = middle;
        else high = middle - 1;
      }
      suffix = suffix.slice(0, low).replace(/[\uD800-\uDBFF]$/, "") + marker;
    }
    guidanceBytes += Buffer.byteLength(suffix) + separatorBytes;
    guidanceAtNode.set(node, (guidanceAtNode.get(node) || 0) + Buffer.byteLength(suffix) + separatorBytes);
    node.description = node.description ? `${node.description}\n${suffix}` : suffix;
  };
  const resolve = (ref, path) => {
    if (ref !== "#" && !ref.startsWith("#/")) fail(path, "only local JSON Pointer references are supported");
    let node = root;
    if (ref !== "#") for (const token of ref.slice(2).split("/")) {
      if (/~(?![01])/u.test(token)) fail(path, "invalid JSON Pointer escape");
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if ((!record(node) && !Array.isArray(node)) || !own(node, key)) fail(path, "unresolved local reference");
      node = node[key];
    }
    return node;
  };
  // Inspect references even in annotations-to-be-projected constraints, never silently lose a bad ref.
  const checkRefs = (node, path = "#") => {
    if (!record(node)) return;
    if (own(node, "$ref")) resolve(node.$ref, pointer(path, "$ref"));
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key)) for (const [name, child] of Object.entries(value)) checkRefs(child, pointer(pointer(path, key), name));
      else if (key === "dependencies") for (const [name, child] of Object.entries(value)) { if (!Array.isArray(child)) checkRefs(child, pointer(pointer(path, key), name)); }
      else if (lists.has(key) || (key === "items" && Array.isArray(value))) value.forEach((child, index) => checkRefs(child, pointer(pointer(path, key), index)));
      else if (children.has(key)) checkRefs(value, pointer(path, key));
    }
  };
  checkRefs(root);
  const merge = (a, b, union, path) => {
    const result = cloneProjected(a);
    if (lossyUnions.has(b)) lossyUnions.add(result);
    if (!a.description && b.description) guidanceAtNode.set(result, guidanceAtNode.get(b) || 0);
    for (const [key, value] of Object.entries(b)) {
      if (!own(result, key)) { Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true }); continue; }
      if (key === "properties") {
        const entries = new Map(Object.entries(result.properties));
        for (const [name, child] of Object.entries(value)) entries.set(name, entries.has(name) ? merge(entries.get(name), child, union, pointer(path, name)) : child);
        result.properties = Object.fromEntries(entries);
      } else if (key === "required") result.required = union ? result.required.filter(name => value.includes(name)) : [...new Set([...result.required, ...value])];
      else if (key === "description") { /* Parent guidance/description wins. */ }
      else if (same(result[key], value)) continue;
      else if (key === "type" && !union && [result.type, value].every(type => type === "number" || type === "integer")) result.type = "integer";
      else if (union) {
        hint(result, path, "anyOf", `Alternative ${key} constraint retained only in canonical validation.`);
        if (key === "type") return result;
        delete result[key];
      } else if (key === "type" && (lossyUnions.has(a) || lossyUnions.has(b))) throw new ProjectionUnavailable("union projection conflicts with conjunction");
      else if (key === "type") fail(path, "incompatible conjunction types");
      else throw new ProjectionUnavailable("conflicting conjunction constraints");
    }
    return result;
  };
  const walk = (node, path) => {
    if (++expansionDepth > LIMITS.depth) {
      expansionDepth--;
      throw new ProjectionUnavailable("expanded reference depth exceeds projection budget");
    }
    try { return walkNode(node, path); } finally { expansionDepth--; }
  };
  const walkNode = (node, path) => {
    if (++expanded > LIMITS.expandedNodes) throw new ProjectionUnavailable("expanded schema exceeds projection budget");
    if (node === false || (record(node) && (node.not === true || (record(node.not) && !Object.keys(node.not).length)))) return { forbidden: true };
    if (node === true) return { value: {} };
    if (own(node, "$ref")) {
      if (activeRefs.has(node.$ref)) throw new ProjectionUnavailable("recursive schema requires canonical validation");
      activeRefs.add(node.$ref);
      const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
      const target = walk(resolve(node.$ref, path), path);
      const result = Object.keys(siblings).length ? conjunction([target, walk(siblings, path)], path) : target;
      activeRefs.delete(node.$ref);
      return result;
    }
    let output = {};
    let nullable = node.nullable === true;
    if (typeof node.description === "string") output.description = node.description;
    if (typeof node.type === "string") {
      if (node.type === "null") return { nullOnly: true, nullable: true };
      output.type = node.type;
    }
    for (const key of ["minimum", "maximum", "pattern"]) if (own(node, key)) output[key] = node[key];
    if (node.properties) {
      output.type ||= "object";
      const entries = [];
      const required = [...(node.required || [])];
      for (const [name, child] of Object.entries(node.properties)) {
        const projected = walk(child, pointer(pointer(path, "properties"), name));
        if (projected.forbidden) {
          if (required.includes(name)) fail(path, "required property is forbidden");
          issues.push({ path: pointer(path, name), keyword: "not", action: "omit" });
          continue;
        }
        if (projected.nullOnly) {
          if (required.includes(name)) throw new ProjectionUnavailable("required null-only field");
          continue;
        }
        entries.push([name, projected.value]);
        if (projected.nullable) {
          const index = required.indexOf(name);
          if (index >= 0) required.splice(index, 1);
        }
      }
      output.properties = Object.fromEntries(entries);
      if (required.length) output.required = required;
    } else if (node.required?.length) output.required = [...node.required];
    if ((node.items !== undefined || node.prefixItems) && (!Array.isArray(node.type) || node.type.find(type => type !== "null") === "array")) {
      output.type ||= "array";
      const itemSchemas = node.prefixItems || (Array.isArray(node.items) ? node.items : null);
      const item = itemSchemas ? union(itemSchemas.map((child, index) => walk(child, pointer(pointer(path, "items"), index))), path) : walk(node.items, pointer(path, "items"));
      if (!item.value || !item.value.type) throw new ProjectionUnavailable("array items cannot be represented");
      output.items = item.value;
      if (itemSchemas) hint(output, path, "items", "Tuple positions are enforced by canonical validation.");
    } else if (output.type === "array") throw new ProjectionUnavailable("array has no item schema");
    let values = node.enum;
    if (own(node, "const")) values = values ? values.filter(value => same(value, node.const)) : [node.const];
    if (values) {
      if (!values.length) fail(path, "const and enum constraints conflict");
      if (values.every(value => typeof value === "string")) output.enum = [...new Set(values)];
      else {
        const valueTypes = [...new Set(values.map(value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value))];
        if (!output.type && valueTypes.length === 1 && valueTypes[0] !== "null") output.type = valueTypes[0];
        hint(output, path, "enum", `Allowed typed JSON values: ${JSON.stringify(values)}.`);
      }
    }
    for (const key of ["anyOf", "oneOf"]) if (node[key]) {
      const choice = union(node[key].map((child, index) => walk(child, pointer(pointer(path, key), index))), path);
      nullable ||= choice.nullable;
      if (!choice.value) return choice;
      output = merge(output, choice.value, false, path);
      hint(output, path, key, `Canonical ${key} alternatives: ${node[key].map(branch => typeof branch === "boolean" ? String(branch) : Array.isArray(branch.type) ? branch.type.join("|") : branch.type || (branch.properties ? "object" : "unconstrained")).join(", ")}. Projection is guidance, not an equivalent schema.`);
    }
    if (Array.isArray(node.type)) {
      const choice = union(node.type.map(type => walk({ type, ...(type === "array" && node.items !== undefined ? { items: node.items } : {}) }, pointer(path, "type"))), path);
      nullable ||= choice.nullable;
      if (!choice.value) return choice;
      output = merge(output, choice.value, false, path);
      hint(output, path, "type", `Canonical types: ${node.type.join(", ")}.`);
    }
    if (node.allOf) {
      const conjunctionResult = conjunction([{ value: output }, ...node.allOf.map((child, index) => walk(child, pointer(pointer(path, "allOf"), index)))], path);
      if (!conjunctionResult.value) return conjunctionResult;
      output = conjunctionResult.value;
    }
    for (const [key] of Object.entries(node)) {
      if (["type", "description", "properties", "required", "items", "prefixItems", "enum", "const", "minimum", "maximum", "pattern", "anyOf", "oneOf", "allOf", "$defs", "definitions"].includes(key)) continue;
      hint(output, path, key, `Canonical ${key} constraint/annotation is not represented on the wire.`);
    }
    if (output.type === "object") output.properties ||= {};
    if (output.type === "array" && !output.items) throw new ProjectionUnavailable("inferred array lacks item representation");
    return { value: output, nullable };
  };
  const union = (branches, path) => {
    const nullable = branches.some(branch => branch.nullOnly || branch.nullable);
    const usable = branches.filter(branch => branch.value);
    if (!usable.length) return branches.some(branch => branch.nullOnly) ? { nullOnly: true, nullable } : { forbidden: true };
    let value = usable[0].value;
    if (usable.every(branch => branch.value.enum?.every(item => typeof item === "string"))) {
      value = cloneProjected(value);
      value.enum = [...new Set(usable.flatMap(branch => branch.value.enum))];
    }
    else if (usable.every(branch => branch.value.type === "object")) {
      value = cloneProjected(value);
      value.required = [...(value.required || [])];
      for (const branch of usable.slice(1)) {
        const alternative = cloneProjected(branch.value);
        alternative.required ||= [];
        value = merge(value, alternative, true, path);
      }
      if (!value.required.length) delete value.required;
    }
    if (usable.length > 1) lossyUnions.add(value);
    return { value, nullable };
  };
  const conjunction = (branches, path) => {
    if (branches.some(branch => branch.forbidden)) return { forbidden: true };
    if (branches.some(branch => branch.nullOnly)) throw new ProjectionUnavailable("null conjunction cannot be represented");
    let value = {};
    for (const branch of branches) value = merge(value, branch.value, false, path);
    return { value, nullable: branches.every(branch => branch.nullable) };
  };
  if (root === false || (record(root) && root.type && root.type !== "object" && !(Array.isArray(root.type) && root.type.includes("object")))) fail("#", "tool arguments must be an object schema");
  let parameters;
  try {
    const projected = walk(root, "#");
    if (projected.forbidden || projected.nullOnly) fail("#", "tool arguments must be an object schema");
    parameters = projected.value;
    if (parameters.type && parameters.type !== "object") fail("#", "tool arguments must be an object schema");
    parameters.type = "object";
    parameters.properties ||= {};
  } catch (error) {
    if (!(error instanceof ProjectionUnavailable)) throw error;
    parameters = empty();
    hint(parameters, "#", "projection", `Canonical schema requires tool-level fallback: ${error.message}. Fields: ${Object.keys(root.properties || {}).join(", ")}.`);
    issues.push({ path: "#", keyword: "projection", action: "tool_fallback" });
  }
  return { parameters, projected: !same(root, parameters), issues };
}
