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

export function validateBodyInvariants(original, compressed, format) {
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
