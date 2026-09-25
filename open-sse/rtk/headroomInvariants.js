// open-sse/rtk/headroomInvariants.js
// Guard body invariants across Headroom gateway operations.
// Only text fields may be altered by compression.
// Any breach in structure, IDs, order, tool pairing, reasoning or arguments syntax
// invalidates the compression result and triggers an immediate fail-open bypass.

export function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isJsonValue = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
};

function isValidJsonString(str) {
  if (typeof str !== "string") return false;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

const DISCARDED_ANNOTATIONS = new Set([
  "$id",
  "$schema",
  "$comment",
  "title",
  "examples",
  "example",
  "deprecated",
  "readOnly",
  "writeOnly",
  "markdownDescription",
]);

function normalizeWhitespace(str) {
  return typeof str === "string" ? str.replace(/\s+/g, " ").trim() : "";
}

function isAllowedDescriptionMutation(origDesc, compDesc) {
  if (typeof origDesc !== "string" || typeof compDesc !== "string") return false;
  if (origDesc === compDesc) return true;
  const normOrig = normalizeWhitespace(origDesc);
  const normComp = normalizeWhitespace(compDesc);
  if (normOrig === normComp) return true;
  const strippedComp = normComp.replace(/[.…\s]+$/, "");
  if (!strippedComp) return true;
  return normOrig.startsWith(strippedComp);
}

function validateSchemaInvariants(orig, comp, path) {
  if (orig === comp) return { valid: true };
  if (typeof orig === "boolean" || typeof comp === "boolean") {
    return orig === comp ? { valid: true } : { valid: false, detail: path.join(".") };
  }
  if (!isObject(orig) || !isObject(comp)) {
    if (typeof orig === "string" && typeof comp === "string" && path[path.length - 1] === "description") {
      return isAllowedDescriptionMutation(orig, comp) ? { valid: true } : { valid: false, detail: path.join(".") };
    }
    return { valid: false, detail: path.join(".") };
  }

  // 1. type
  if (orig.type !== undefined && orig.type !== comp.type) {
    return { valid: false, detail: [...path, "type"].join(".") };
  }

  // 2. required
  if (orig.required !== undefined || comp.required !== undefined) {
    if (!Array.isArray(orig.required) || !Array.isArray(comp.required)) {
      return { valid: false, detail: [...path, "required"].join(".") };
    }
    const origReq = [...orig.required].sort();
    const compReq = [...comp.required].sort();
    if (origReq.length !== compReq.length || !origReq.every((v, i) => v === compReq[i])) {
      return { valid: false, detail: [...path, "required"].join(".") };
    }
  }

  // 3. enum
  if (orig.enum !== undefined && !deepEqual(orig.enum, comp.enum)) {
    return { valid: false, detail: [...path, "enum"].join(".") };
  }

  // 4. const
  if (orig.const !== undefined && !deepEqual(orig.const, comp.const)) {
    return { valid: false, detail: [...path, "const"].join(".") };
  }

  // 5. properties
  if (orig.properties !== undefined || comp.properties !== undefined) {
    if (!isObject(orig.properties) || !isObject(comp.properties)) {
      return { valid: false, detail: [...path, "properties"].join(".") };
    }
    const origProps = Object.keys(orig.properties).sort();
    const compProps = Object.keys(comp.properties).sort();
    if (origProps.length !== compProps.length || !origProps.every((v, i) => v === compProps[i])) {
      return { valid: false, detail: [...path, "properties"].join(".") };
    }
    for (const prop of origProps) {
      const res = validateSchemaInvariants(orig.properties[prop], comp.properties[prop], [...path, "properties", prop]);
      if (!res.valid) return res;
    }
  }

  // 6. items
  if (orig.items !== undefined || comp.items !== undefined) {
    if (Array.isArray(orig.items) || Array.isArray(comp.items)) {
      if (!Array.isArray(orig.items) || !Array.isArray(comp.items) || orig.items.length !== comp.items.length) {
        return { valid: false, detail: [...path, "items"].join(".") };
      }
      for (let i = 0; i < orig.items.length; i++) {
        const res = validateSchemaInvariants(orig.items[i], comp.items[i], [...path, "items", i]);
        if (!res.valid) return res;
      }
    } else if (isObject(orig.items) && isObject(comp.items)) {
      const res = validateSchemaInvariants(orig.items, comp.items, [...path, "items"]);
      if (!res.valid) return res;
    } else if (!deepEqual(orig.items, comp.items)) {
      return { valid: false, detail: [...path, "items"].join(".") };
    }
  }

  // 7. additionalProperties
  if (orig.additionalProperties !== undefined || comp.additionalProperties !== undefined) {
    if (typeof orig.additionalProperties === "boolean" || typeof comp.additionalProperties === "boolean") {
      if (orig.additionalProperties !== comp.additionalProperties) {
        return { valid: false, detail: [...path, "additionalProperties"].join(".") };
      }
    } else if (isObject(orig.additionalProperties) && isObject(comp.additionalProperties)) {
      const res = validateSchemaInvariants(orig.additionalProperties, comp.additionalProperties, [...path, "additionalProperties"]);
      if (!res.valid) return res;
    } else if (!deepEqual(orig.additionalProperties, comp.additionalProperties)) {
      return { valid: false, detail: [...path, "additionalProperties"].join(".") };
    }
  }

  // 8. description
  if (orig.description !== undefined) {
    if (comp.description !== undefined) {
      if (!isAllowedDescriptionMutation(orig.description, comp.description)) {
        return { valid: false, detail: [...path, "description"].join(".") };
      }
    }
  } else if (comp.description !== undefined) {
    return { valid: false, detail: [...path, "description"].join(".") };
  }

  // 9. definitions / $defs
  for (const defKey of ["$defs", "definitions"]) {
    if (orig[defKey] !== undefined || comp[defKey] !== undefined) {
      if (!isObject(orig[defKey]) || !isObject(comp[defKey])) {
        return { valid: false, detail: [...path, defKey].join(".") };
      }
      const origDefs = Object.keys(orig[defKey]).sort();
      const compDefs = Object.keys(comp[defKey]).sort();
      if (origDefs.length !== compDefs.length || !origDefs.every((v, i) => v === compDefs[i])) {
        return { valid: false, detail: [...path, defKey].join(".") };
      }
      for (const d of origDefs) {
        const res = validateSchemaInvariants(orig[defKey][d], comp[defKey][d], [...path, defKey, d]);
        if (!res.valid) return res;
      }
    }
  }

  // 10. anyOf / allOf / oneOf
  for (const combKey of ["anyOf", "allOf", "oneOf"]) {
    if (orig[combKey] !== undefined || comp[combKey] !== undefined) {
      if (!Array.isArray(orig[combKey]) || !Array.isArray(comp[combKey]) || orig[combKey].length !== comp[combKey].length) {
        return { valid: false, detail: [...path, combKey].join(".") };
      }
      for (let i = 0; i < orig[combKey].length; i++) {
        const res = validateSchemaInvariants(orig[combKey][i], comp[combKey][i], [...path, combKey, i]);
        if (!res.valid) return res;
      }
    }
  }

  // 11. Extra keys in comp
  const handled = new Set(["type", "required", "enum", "const", "properties", "items", "additionalProperties", "description", "$defs", "definitions", "anyOf", "allOf", "oneOf"]);
  for (const key of Object.keys(comp)) {
    if (DISCARDED_ANNOTATIONS.has(key) || handled.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(orig, key) || !deepEqual(orig[key], comp[key])) {
      return { valid: false, detail: [...path, key].join(".") };
    }
  }

  // 12. Keys in orig dropped in comp
  for (const key of Object.keys(orig)) {
    if (DISCARDED_ANNOTATIONS.has(key) || key === "description" || handled.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(comp, key)) {
      return { valid: false, detail: [...path, key].join(".") };
    }
  }

  return { valid: true };
}

export function validateToolsInvariants(originalTools, compressedTools, transforms = []) {
  if (deepEqual(originalTools, compressedTools)) return { valid: true };

  const transformList = Array.isArray(transforms) ? transforms : [];
  const allowsCompaction = transformList.includes("tool_schema_compaction") || transformList.includes("tool_desc_compaction");
  if (!allowsCompaction) {
    return { valid: false, reason: "immutable_field_changed", detail: "tools" };
  }

  if (!Array.isArray(originalTools) || !Array.isArray(compressedTools)) {
    return { valid: false, reason: "immutable_field_changed", detail: "tools" };
  }
  if (originalTools.length !== compressedTools.length) {
    return { valid: false, reason: "immutable_field_changed", detail: "tools.length" };
  }

  for (let i = 0; i < originalTools.length; i++) {
    const origTool = originalTools[i];
    const compTool = compressedTools[i];
    if (!isObject(origTool) || !isObject(compTool)) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}` };
    }

    if (origTool.type !== compTool.type) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.type` };
    }

    const origFn = origTool.function;
    const compFn = compTool.function;
    if (Boolean(origFn) !== Boolean(compFn)) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.function` };
    }

    const origTarget = origFn || origTool;
    const compTarget = compFn || compTool;

    if (origTarget.name !== compTarget.name) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.name` };
    }

    if (origTarget.description !== undefined) {
      if (compTarget.description !== undefined) {
        if (!isAllowedDescriptionMutation(origTarget.description, compTarget.description)) {
          return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.description` };
        }
      }
    } else if (compTarget.description !== undefined) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.description` };
    }

    const origSchema = origTarget.parameters || origTarget.input_schema;
    const compSchema = compTarget.parameters || compTarget.input_schema;
    if (origSchema !== undefined) {
      if (compSchema === undefined) {
        return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.parameters` };
      }
      const schemaField = origTarget.parameters ? "parameters" : "input_schema";
      const schemaRes = validateSchemaInvariants(origSchema, compSchema, ["tools", i, schemaField]);
      if (!schemaRes.valid) {
        return { valid: false, reason: "immutable_field_changed", detail: schemaRes.detail };
      }
    } else if (compSchema !== undefined) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.parameters` };
    }

    if (origTarget.strict !== undefined && origTarget.strict !== compTarget.strict) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.strict` };
    }

    if (origTool.cache_control !== undefined && !deepEqual(origTool.cache_control, compTool.cache_control)) {
      return { valid: false, reason: "immutable_field_changed", detail: `tools.${i}.cache_control` };
    }
  }

  return { valid: true };
}

export function validateBodyInvariants(original, compressed, format, options = {}) {
  if (!isObject(original) || !isObject(compressed)) return { valid: false, reason: "invalid_body_root" };
  if (!isJsonValue(original) || !isJsonValue(compressed)) return { valid: false, reason: "invalid_json_tree" };
  const wireFormat = format || (Object.hasOwn(original, "input") ? "openai-responses" : "openai");
  if (!["openai", "claude", "openai-responses"].includes(wireFormat)) return { valid: false, reason: "unknown_format" };
  const failed = (path) => ({ valid: false, reason: "immutable_field_changed", detail: path.join(".") || "root" });

  function textPath(path) {
    const [root, index, field, part, leaf, nested, sub] = path;
    if (wireFormat === "openai") {
      return root === "messages" && typeof index === "number" && (
        (field === "content" && path.length === 3)
        || (field === "content" && typeof part === "number" && leaf === "text" && path.length === 5 && original.messages[index]?.content?.[part]?.type === "text")
      );
    }
    if (wireFormat === "claude") {
      if (root === "system") return path.length === 1 || (typeof index === "number" && field === "text" && path.length === 3 && original.system?.[index]?.type === "text");
      if (root !== "messages" || typeof index !== "number" || field !== "content") return false;
      if (path.length === 3) return true;
      const block = original.messages[index]?.content?.[part];
      if (typeof part !== "number" || !block) return false;
      if (block.type === "text") return path.length === 5 && leaf === "text";
      if (block.type !== "tool_result" || block.is_error === true || leaf !== "content") return false;
      return path.length === 5 || (path.length === 7 && typeof nested === "number" && sub === "text" && block.content?.[nested]?.type === "text");
    }
    if (wireFormat === "openai-responses") {
      if (root === "instructions" && path.length === 1) return true;
      if (root !== "input" || typeof index !== "number") return false;
      const item = original.input?.[index];
      if (!item || typeof item !== "object") return false;

      const message = item.type === "message" || (!item.type && item.role);
      if (message && field === "content") {
        if (path.length === 3) return true;
        if (typeof part === "number" && path.length === 5 && leaf === "text") {
          const block = item.content?.[part];
          return ["input_text", "output_text", "text"].includes(block?.type);
        }
      }

      const result = item.type === "function_call_output"
        || item.type === "custom_tool_call_output"
        || item.type === "local_shell_call_output"
        || item.type === "apply_patch_call_output";
      if (result && field === "output") {
        if (path.length === 3) return true;
        if (typeof part === "number" && path.length === 5 && leaf === "text") {
          const block = item.output?.[part];
          return ["input_text", "output_text", "text"].includes(block?.type);
        }
      }

      const toolInput = item.type === "custom_tool_call"
        || item.type === "local_shell_call"
        || item.type === "apply_patch_call";
      if (toolInput && field === "input" && path.length === 3) {
        return true;
      }
    }
    return false;
  }

  function checkFunctionArguments(a, b, path) {
    if (wireFormat !== "openai-responses") return null;
    const [root, index, field] = path;
    if (root !== "input" || typeof index !== "number" || field !== "arguments" || path.length !== 3) {
      return null;
    }
    const item = original.input?.[index];
    if (item?.type !== "function_call") return null;

    if (typeof a !== "string" || typeof b !== "string") {
      return failed(path);
    }
    const aValid = isValidJsonString(a);
    if (aValid) {
      if (isValidJsonString(b)) {
        return { valid: true };
      }
      return failed(path);
    }
    return a === b ? { valid: true } : failed(path);
  }

  function compare(a, b, path = []) {
    if (a === b) return null;
    if (textPath(path) && typeof a === "string" && typeof b === "string") return null;

    const argCheck = checkFunctionArguments(a, b, path);
    if (argCheck) {
      if (argCheck.valid) return null;
      return argCheck;
    }

    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return failed(path);
      for (let i = 0; i < a.length; i++) {
        const error = compare(a[i], b[i], [...path, i]);
        if (error) return error;
      }
      return null;
    }
    if (!isObject(a)) return failed(path);
    if (!isObject(b)) return failed(path);
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return failed(path);
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return failed([...path, key]);
      const next = [...path, key];
      if (path.length === 0 && key === "tools") {
        const toolsRes = validateToolsInvariants(a[key], b[key], options?.transforms);
        if (!toolsRes.valid) return toolsRes;
        continue;
      }
      const allowedRoots = wireFormat === "openai-responses"
        ? ["input", "instructions"]
        : (wireFormat === "claude" ? ["messages", "system"] : ["messages"]);
      if (!allowedRoots.includes(path[0] ?? key)) {
        if (!deepEqual(a[key], b[key])) return failed(next);
        continue;
      }
      const error = compare(a[key], b[key], next);
      if (error) return error;
    }
    return null;
  }
  return compare(original, compressed) || { valid: true };
}
