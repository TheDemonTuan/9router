const MAX_ERRORS = 8;

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function pointerValue(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce((value, part) => {
    if (value === undefined || value === null) return undefined;
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    return value[key];
  }, root);
}

function addError(errors, path, message) {
  if (errors.length < MAX_ERRORS) errors.push(`${path} ${message}`);
}

function validateNode(value, schema, root, path, refs) {
  if (schema === true || schema === undefined || schema === null) return [];
  if (schema === false) return [`${path} is not allowed`];
  if (typeof schema !== "object") return [];

  if (schema.$ref) {
    if (refs.has(schema.$ref)) return [];
    const target = pointerValue(root, schema.$ref);
    if (target === undefined) return [`${path} has unresolved reference ${schema.$ref}`];
    const nextRefs = new Set(refs);
    nextRefs.add(schema.$ref);
    const errors = validateNode(value, target, root, path, nextRefs);
    const siblings = { ...schema };
    delete siblings.$ref;
    if (Object.keys(siblings).length) errors.push(...validateNode(value, siblings, root, path, nextRefs));
    return errors.slice(0, MAX_ERRORS);
  }

  const errors = [];
  const fail = (message) => addError(errors, path, message);

  if (schema.const !== undefined && !sameJson(value, schema.const)) fail("must equal const");
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(value, item))) fail("must match enum");

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  const acceptsNull = schema.nullable === true && value === null;
  if (types.length && !acceptsNull && !types.includes(jsonType(value)) && !(types.includes("number") && typeof value === "number")) {
    fail(`must be ${types.join(" or ")}`);
    return errors;
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) errors.push(...validateNode(value, branch, root, path, refs));
  }

  for (const keyword of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    const branchErrors = schema[keyword].map((branch) => validateNode(value, branch, root, path, refs));
    const matches = branchErrors.filter((branch) => branch.length === 0).length;
    const valid = keyword === "oneOf" ? matches === 1 : matches > 0;
    if (!valid) fail(keyword === "oneOf" ? "must match exactly one branch" : "must match at least one branch");
  }

  if (schema.not && validateNode(value, schema.not, root, path, refs).length === 0) fail("must not match schema");

  const type = jsonType(value);
  if (type === "object") {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`is missing required property ${key}`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateNode(value[key], childSchema, root, `${path}.${key}`, refs));
      }
    }
    const patterns = schema.patternProperties && typeof schema.patternProperties === "object"
      ? Object.entries(schema.patternProperties).map(([pattern, child]) => [new RegExp(pattern), child])
      : [];
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      const matching = patterns.filter(([pattern]) => pattern.test(key));
      if (matching.length) {
        for (const [, childSchema] of matching) errors.push(...validateNode(child, childSchema, root, `${path}.${key}`, refs));
      } else if (schema.additionalProperties === false) {
        fail(`has unexpected property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateNode(child, schema.additionalProperties, root, `${path}.${key}`, refs));
      }
    }
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) fail(`must have at least ${schema.minProperties} properties`);
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) fail(`must have at most ${schema.maxProperties} properties`);
  } else if (type === "array") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`must contain at least ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((item, index) => value.some((other, otherIndex) => otherIndex < index && sameJson(item, other)))) fail("must contain unique items");
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((child, index) => {
        if (index < value.length) errors.push(...validateNode(value[index], child, root, `${path}[${index}]`, refs));
      });
    }
    if (schema.items && !Array.isArray(schema.items)) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index += 1) {
        errors.push(...validateNode(value[index], schema.items, root, `${path}[${index}]`, refs));
      }
    }
    if (schema.contains && !value.some((item, index) => validateNode(item, schema.contains, root, `${path}[${index}]`, refs).length === 0)) fail("must contain a matching item");
  } else if (type === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(`must have length >= ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(`must have length <= ${schema.maxLength}`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) fail("must match pattern");
      } catch {
        fail("has invalid pattern");
      }
    }
  } else if (type === "number" || type === "integer") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) fail(`must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) fail(`must be < ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === "number" && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON) fail(`must be a multiple of ${schema.multipleOf}`);
  }

  return errors.slice(0, MAX_ERRORS);
}

export function validateJsonSchema(value, schema) {
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const errors = validateNode(value, schema, schema, "$", new Set());
  return { valid: errors.length === 0, errors };
}

function stripJsonFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function validateJsonText(text, schema) {
  const raw = stripJsonFence(text);
  if (!raw) return { valid: false, errors: ["response is empty"] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ["response is not valid JSON"] };
  }
  return { ...validateJsonSchema(value, schema), value };
}

export function extractStructuredResponseText(response) {
  if (!response || typeof response !== "object") return { text: "", skipped: true };
  if (Array.isArray(response.choices)) {
    const message = response.choices[0]?.message;
    if (message?.tool_calls?.length) return { text: "", skipped: true };
    return { text: typeof message?.content === "string" ? message.content : "", skipped: false };
  }
  if (typeof response.output_text === "string") return { text: response.output_text, skipped: false };
  if (Array.isArray(response.output)) {
    const text = response.output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .filter((part) => part?.type === "output_text" || typeof part?.text === "string")
      .map((part) => part.text || "")
      .join("");
    const hasToolCall = response.output.some((item) => item?.type === "function_call" || item?.type === "computer_call");
    return { text, skipped: hasToolCall && !text };
  }
  if (Array.isArray(response.content)) {
    const hasToolCall = response.content.some((part) => part?.type === "tool_use");
    const text = response.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
    return { text, skipped: hasToolCall && !text };
  }
  const candidate = response.response?.candidates?.[0] || response.candidates?.[0];
  if (candidate?.content?.parts) {
    const hasToolCall = candidate.content.parts.some((part) => part?.functionCall);
    const text = candidate.content.parts.filter((part) => part?.text && part.thought !== true).map((part) => part.text).join("");
    return { text, skipped: hasToolCall && !text };
  }
  return { text: "", skipped: true };
}

export function validateStructuredResponse(response, schema) {
  if (!schema) return { valid: true, skipped: true, errors: [] };
  const extracted = extractStructuredResponseText(response);
  if (extracted.skipped) return { valid: true, skipped: true, errors: [] };
  return validateJsonText(extracted.text, schema);
}
