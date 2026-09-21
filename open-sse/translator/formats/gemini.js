// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "deprecated", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE && item.file?.file_data?.startsWith("data:")) {
        const url = item.file.file_data;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimeType = url.substring(5, commaIndex).split(";")[0];
          const data = url.substring(commaIndex + 1);
          parts.push({ inlineData: { mime_type: mimeType, data: data } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Helper: Remove unsupported keywords recursively from object/array
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }

    const value = obj[key];
    if (value && typeof value === "object") {
      removeUnsupportedKeywords(value, keywords);
    }
  }
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertConstToEnum(value);
    }
  }
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map(v => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!obj.type) {
      obj.type = "string";
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      convertEnumValuesToStrings(value);
    }
  }
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};

    for (const item of obj.allOf) {
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }
    }

    delete obj.allOf;
    if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required) obj.required = [...(obj.required || []), ...merged.required];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      mergeAllOf(value);
    }
  }
}

// Gemini has no multi-branch composition equivalent. Only null unions map to nullable.
function flattenAnyOfOneOf(obj, schemaKind = "tool") {
  if (!obj || typeof obj !== "object") return;

  for (const key of ["anyOf", "oneOf"]) {
    if (!Array.isArray(obj[key]) || obj[key].length === 0) continue;
    const nonNull = obj[key].filter(item => item?.type !== "null");
    if (obj[key].length !== 2 || nonNull.length !== 1) {
      const error = new Error(`Unsupported ${schemaKind} schema ${key}: Gemini cannot represent multi-branch composition`);
      error.code = "unsupported_feature";
      throw error;
    }
    delete obj[key];
    Object.assign(obj, nonNull[0]);
    obj.nullable = true;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") flattenAnyOfOneOf(value, schemaKind);
  }
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter(t => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      flattenTypeArrays(value);
    }
  }
}

// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
  for (const v of Object.values(obj)) if (v && typeof v === "object") ensureObjectType(v);
}

// Gemini cannot represent heterogeneous tuples.
function convertPrefixItems(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj.prefixItems) && obj.prefixItems.length > 0) {
    if (!obj.items && obj.prefixItems.length === 1) {
      obj.items = obj.prefixItems[0];
    } else if (!obj.items) {
      const error = new Error("Unsupported response schema prefixItems: Gemini cannot represent tuples");
      error.code = "unsupported_feature";
      throw error;
    }
    delete obj.prefixItems;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") convertPrefixItems(value);
  }
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "array" && !obj.items) {
    obj.items = { type: "string" };
  }
  for (const v of Object.values(obj)) if (v && typeof v === "object") ensureArrayItems(v);
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter(field =>
        Object.prototype.hasOwnProperty.call(obj.properties, field)
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        cleanupRequired(value);
      }
    }
  }

  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    // Empty schema {} (no type, no properties) after $ref removal — treat as object with placeholder
    if (Object.keys(obj).length === 0) {
      obj.type = "object";
      obj.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool"
        }
      };
      obj.required = ["reason"];
      return;
    }

    if (obj.type === "object") {
      if (!obj.properties || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool"
          }
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested objects
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        addPlaceholders(value);
      }
    }
  }

  addPlaceholders(cleaned);

  return cleaned;
}

// Response schemas keep closed-object and nullable semantics. Tool schemas use
// the stricter cleaner above because Antigravity validates tool parameters more narrowly.
export function cleanResponseSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const root = structuredClone(schema);

  const localRef = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
    return ref.slice(2).split("/").reduce((value, part) => value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  };
  const merge = (base, extension) => {
    const merged = { ...base, ...extension };
    if (base?.properties || extension?.properties) merged.properties = { ...(base?.properties || {}), ...(extension?.properties || {}) };
    if (base?.required || extension?.required) merged.required = [...new Set([...(base?.required || []), ...(extension?.required || [])])];
    return merged;
  };
  const unsupportedComposition = (keyword) => {
    const error = new Error(`Unsupported response schema ${keyword}: Gemini cannot represent multi-branch composition`);
    error.code = "unsupported_feature";
    throw error;
  };
  const walk = (node, resolving = new Set()) => {
    if (Array.isArray(node)) return node.map(item => walk(item, resolving));
    if (!node || typeof node !== "object") return node;

    if (node.$ref) {
      const target = localRef(node.$ref);
      if (target && !resolving.has(node.$ref)) {
        const nextResolving = new Set(resolving);
        nextResolving.add(node.$ref);
        const { $ref, ...siblings } = node;
        return walk(merge(structuredClone(target), siblings), nextResolving);
      }
    }

    if (Array.isArray(node.type) && node.type.includes("null")) {
      const types = node.type.filter(type => type !== "null");
      node.type = types.length === 1 ? types[0] : types;
      node.nullable = true;
    }
    if (Array.isArray(node.allOf)) {
      const own = { ...node };
      delete own.allOf;
      node = node.allOf.reduce((merged, item) => merge(merged, walk(item, resolving)), own);
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (!Array.isArray(node[key]) || node[key].length === 0) continue;
      const variants = node[key].map(item => walk(item, resolving));
      const nonNull = variants.filter(item => item?.type !== "null");
      if (variants.length !== 2 || nonNull.length !== 1) unsupportedComposition(key);
      delete node[key];
      node = merge(node, nonNull[0]);
      node.nullable = true;
    }
    if (node.properties && !node.type) node.type = "object";
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) node.properties[key] = walk(value, resolving);
    }
    if (Array.isArray(node.prefixItems) && node.prefixItems.length) {
      const variants = node.prefixItems.map(item => walk(item, resolving));
      if (!node.items && variants.length !== 1) unsupportedComposition("prefixItems");
      if (!node.items) node.items = variants[0];
      delete node.prefixItems;
    }
    if (node.items) node.items = walk(node.items, resolving);
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      node.additionalProperties = walk(node.additionalProperties, resolving);
    }
    for (const key of ["$schema", "$id", "$defs", "definitions", "$ref"]) delete node[key];
    return node;
  };

  return walk(root);
}

// Gemini JSON Schema fields preserve composition and validation semantics. Strip
// only document-level metadata/vendor extensions that are not request schema.
const GEMINI_JSON_SCHEMA_IGNORED_KEYWORDS = new Set([
  "$schema", "$id", "$comment",
]);

function cleanGeminiJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !GEMINI_JSON_SCHEMA_IGNORED_KEYWORDS.has(key) && !key.startsWith("x-"))
        .map(([key, entry]) => [key, clean(entry)])
    );
  };
  return clean(schema);
}

export function cleanResponseJsonSchemaForGemini(schema) {
  return cleanGeminiJsonSchema(schema);
}

export function cleanToolJsonSchemaForGemini(schema) {
  return cleanGeminiJsonSchema(schema);
}

export function buildResponseSchemaFallbackInstruction(schema) {
  return [
    "Return valid JSON matching the following JSON Schema. Do not wrap the JSON in markdown fences.",
    JSON.stringify(schema),
  ].join("\n");
}

export function cleanLegacyResponseSchemaOrFallback(schema) {
  try {
    return { schema: cleanResponseSchemaForAntigravity(schema), fallbackInstruction: null, validationSchema: null };
  } catch (error) {
    if (error?.code !== "unsupported_feature") throw error;
    return {
      schema: null,
      fallbackInstruction: buildResponseSchemaFallbackInstruction(schema),
      validationSchema: structuredClone(schema),
    };
  }
}

// Merge adjacent same-role messages, strip empty parts, ensure valid generation bounds.
export function normalizeGeminiContents(contents, { requireTrailingUser = false } = {}) {
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) last.parts.push(...parts);
    else out.push({ ...c, parts: [...parts] });
  }
  if (out.length > 0 && out[0].role !== "user") out.unshift({ role: "user", parts: [{ text: "..." }] });
  if (requireTrailingUser && out.at(-1)?.role === "model") out.push({ role: "user", parts: [{ text: "" }] });
  return out;
}


