import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import {
  cleanJSONSchemaForAntigravity,
  cleanResponseSchemaForAntigravity,
  normalizeGeminiContents,
  tryParseJSON,
} from "../formats/gemini.js";
import { RESPONSES_ITEM, ROLE, GEMINI_ROLE } from "../schema/index.js";
import {
  sanitizeGeminiFunctionName,
  wrapInCloudCodeEnvelope,
} from "./openai-to-gemini.js";
import {
  DEFAULT_THINKING_AG_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
} from "../../config/defaultThinkingSignature.js";

function imagePart(part) {
  const url = part.image_url;
  if (typeof url !== "string" || !url) {
    const error = new Error("Unsupported Responses image without image_url");
    error.code = "unsupported_feature";
    throw error;
  }
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) {
      const error = new Error("Unsupported Responses image data URI");
      error.code = "unsupported_feature";
      throw error;
    }
    return {
      inlineData: {
        mime_type: url.slice(5, comma).split(";")[0],
        data: url.slice(comma + 1),
      },
    };
  }
  if (/^https?:\/\//.test(url)) return { fileData: { fileUri: url, mimeType: "image/*" } };
  const error = new Error("Unsupported Responses image URL");
  error.code = "unsupported_feature";
  throw error;
}

function contentParts(content, itemType) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (part?.type === RESPONSES_ITEM.INPUT_TEXT || part?.type === RESPONSES_ITEM.OUTPUT_TEXT) {
      if (typeof part.text === "string" && part.text) parts.push({ text: part.text });
    } else if (part?.type === RESPONSES_ITEM.INPUT_IMAGE) {
      parts.push(imagePart(part));
    } else {
      const error = new Error(`Unsupported Responses ${itemType} content type '${part?.type || "unknown"}'`);
      error.code = "unsupported_feature";
      throw error;
    }
  }
  return parts;
}

function responseSchema(text) {
  const format = text?.format;
  if (!format || typeof format !== "object") return {};
  if (format.type === "json_object") return { responseMimeType: "application/json" };
  if (format.type !== "json_schema") return {};
  const schema = format.schema;
  return {
    responseMimeType: "application/json",
    ...(schema && typeof schema === "object"
      ? { responseSchema: cleanResponseSchemaForAntigravity(schema) }
      : {}),
  };
}

function functionDeclarations(tools) {
  const declarations = [];
  for (const tool of tools || []) {
    const fn = tool?.function || tool;
    if (tool?.type && tool.type !== "function") continue;
    if (!fn?.name || typeof fn.name !== "string") continue;
    declarations.push({
      name: sanitizeGeminiFunctionName(fn.name),
      description: String(fn.description || ""),
      parameters: cleanJSONSchemaForAntigravity(structuredClone(fn.parameters || { type: "object", properties: {} })),
    });
  }
  return declarations;
}

export function responsesToGeminiBase(model, body, signature) {
  const result = {
    model,
    contents: [],
    generationConfig: responseSchema(body.text),
  };
  if (body.instructions) {
    result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [{ text: String(body.instructions) }] };
  }
  if (body.temperature !== undefined) result.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) result.generationConfig.topP = body.top_p;
  if (body.top_k !== undefined) result.generationConfig.topK = body.top_k;
  if (body.max_output_tokens !== undefined) result.generationConfig.maxOutputTokens = body.max_output_tokens;

  const calls = new Map();
  const input = normalizeResponsesInput(body.input);
  if (!input) return result;
  for (const item of input) {
    const type = item?.type || (item?.role ? RESPONSES_ITEM.MESSAGE : null);
    if (type === RESPONSES_ITEM.MESSAGE) {
      const role = item.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER;
      const parts = contentParts(item.content, "message");
      if (parts.length) result.contents.push({ role, parts });
      continue;
    }
    if (type === RESPONSES_ITEM.REASONING) {
      const text = [...(item.summary || []), ...(item.content || [])]
        .map((part) => part?.text || "").filter(Boolean).join("\n");
      if (text) result.contents.push({ role: GEMINI_ROLE.MODEL, parts: [{ thought: true, text }, { thoughtSignature: signature, text: "" }] });
      continue;
    }
    if (type === RESPONSES_ITEM.FUNCTION_CALL) {
      if (!item.call_id || !item.name) {
        const error = new Error("Unsupported Responses function call without id or name");
        error.code = "unsupported_feature";
        throw error;
      }
      const name = sanitizeGeminiFunctionName(item.name);
      calls.set(item.call_id, name);
      const args = tryParseJSON(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})) || {};
      result.contents.push({ role: GEMINI_ROLE.MODEL, parts: [{ functionCall: { id: item.call_id, name, args }, thoughtSignature: signature }] });
      continue;
    }
    if (type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      const name = calls.get(item.call_id);
      if (!name) {
        const error = new Error("Unsupported Responses orphan function call output");
        error.code = "unsupported_feature";
        throw error;
      }
      const parsed = tryParseJSON(typeof item.output === "string" ? item.output : JSON.stringify(item.output));
      result.contents.push({ role: GEMINI_ROLE.USER, parts: [{
        functionResponse: { id: item.call_id, name, response: { result: parsed && typeof parsed === "object" ? parsed : (parsed ?? item.output ?? "") } },
      }] });
      continue;
    }
    const error = new Error(`Unsupported Responses input item '${type || "unknown"}'`);
    error.code = "unsupported_feature";
    throw error;
  }
  result.contents = normalizeGeminiContents(result.contents);
  const declarations = functionDeclarations(body.tools);
  if (declarations.length) result.tools = [{ functionDeclarations: declarations }];
  return result;
}

export function responsesToGeminiRequest(model, body) {
  return responsesToGeminiBase(model, body, DEFAULT_THINKING_AG_SIGNATURE);
}

export function responsesToGeminiCLIRequest(model, body, stream, credentials) {
  return wrapInCloudCodeEnvelope(model, responsesToGeminiBase(model, body, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE), credentials);
}

export function responsesToAntigravityRequest(model, body, stream, credentials) {
  return wrapInCloudCodeEnvelope(model, responsesToGeminiBase(model, body, DEFAULT_THINKING_AG_SIGNATURE), credentials, true);
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, responsesToGeminiRequest, null);
register(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI_CLI, responsesToGeminiCLIRequest, null);
register(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, responsesToAntigravityRequest, null);
