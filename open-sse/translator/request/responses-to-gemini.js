import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import {
  DEFAULT_SAFETY_SETTINGS,
  cleanJSONSchemaForAntigravity,
  cleanResponseSchemaForAntigravity,
  cleanResponseJsonSchemaForGemini,
  normalizeGeminiContents,
  tryParseJSON,
} from "../formats/gemini.js";
import { RESPONSES_ITEM, ROLE, GEMINI_ROLE } from "../schema/index.js";
import {
  openaiToAntigravityRequest,
  sanitizeGeminiFunctionName,
  wrapInCloudCodeEnvelope,
} from "./openai-to-gemini.js";
import { openaiResponsesToOpenAIRequest } from "./openai-responses.js";
import { postProcessForVertex } from "./openai-to-vertex.js";
import { getGeminiThoughtSignatureSync } from "../../services/thoughtSignatureStore.js";
import {
  DEFAULT_THINKING_AG_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
} from "../../config/defaultThinkingSignature.js";

function unsupported(message) {
  const error = new Error(message);
  error.code = "unsupported_feature";
  throw error;
}

function imagePart(part) {
  const url = part.image_url;
  if (typeof url !== "string" || !url) unsupported("Unsupported Responses image without image_url");
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) unsupported("Unsupported Responses image data URI");
    return {
      inlineData: {
        mime_type: url.slice(5, comma).split(";")[0],
        data: url.slice(comma + 1),
      },
    };
  }
  if (/^https?:\/\//.test(url)) return { fileData: { fileUri: url, mimeType: "image/*" } };
  unsupported("Unsupported Responses image URL");
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
      unsupported(`Unsupported Responses ${itemType} content type '${part?.type || "unknown"}'`);
    }
  }
  return parts;
}

function responseSchema(text, responseSchemaMode = "legacy") {
  const format = text?.format;
  if (!format || typeof format !== "object") return {};
  if (format.type === "json_object") return { responseMimeType: "application/json" };
  if (format.type !== "json_schema") return {};
  const schema = format.schema;
  const usesJsonSchema = responseSchemaMode === "jsonSchema";
  return {
    responseMimeType: "application/json",
    ...(schema && typeof schema === "object"
      ? {
          [usesJsonSchema ? "responseJsonSchema" : "responseSchema"]: usesJsonSchema
            ? cleanResponseJsonSchemaForGemini(schema)
            : cleanResponseSchemaForAntigravity(schema),
        }
      : {}),
  };
}

function functionDeclarations(tools) {
  const declarations = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object" || tool.type !== "function") {
      unsupported("Unsupported Responses tool for Gemini direct translation");
    }
    const fn = tool.function || tool;
    if (!fn?.name || typeof fn.name !== "string") {
      unsupported("Unsupported Responses function tool without a name");
    }
    declarations.push({
      name: sanitizeGeminiFunctionName(fn.name),
      description: String(fn.description || ""),
      parameters: cleanJSONSchemaForAntigravity(structuredClone(fn.parameters || { type: "object", properties: {} })),
    });
  }
  return declarations;
}

function toolConfig(body, declarations) {
  if (body.parallel_tool_calls === false && declarations.length) {
    unsupported("Unsupported Responses parallel_tool_calls=false for Gemini direct translation");
  }

  const choice = body.tool_choice;
  if (choice === undefined || choice === "auto") return declarations.length ? { functionCallingConfig: { mode: "AUTO" } } : undefined;
  if (choice === "none") return declarations.length ? { functionCallingConfig: { mode: "NONE" } } : undefined;
  if (choice === "required") {
    if (!declarations.length) unsupported("Responses tool_choice=required requires a function tool");
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (choice && typeof choice === "object" && choice.type === "function" && typeof choice.name === "string" && choice.name) {
    const name = sanitizeGeminiFunctionName(choice.name);
    if (!declarations.some((declaration) => declaration.name === name)) {
      unsupported("Responses tool_choice names an undeclared function");
    }
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
  }
  unsupported("Unsupported Responses tool_choice for Gemini direct translation");
}

export function responsesToGeminiBase(model, body, signature, sessionId = null, responseSchemaMode = "legacy") {
  const result = {
    model,
    contents: [],
    generationConfig: responseSchema(body.text, responseSchemaMode),
    safetySettings: DEFAULT_SAFETY_SETTINGS,
  };
  if (body.instructions) {
    result.systemInstruction = { role: GEMINI_ROLE.USER, parts: [{ text: String(body.instructions) }] };
  }
  if (body.temperature !== undefined) result.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) result.generationConfig.topP = body.top_p;
  if (body.top_k !== undefined) result.generationConfig.topK = body.top_k;
  if (body.max_output_tokens !== undefined) result.generationConfig.maxOutputTokens = body.max_output_tokens;

  const calls = new Map();
  let firstFunctionCallSeen = false;
  const input = normalizeResponsesInput(body.input);
  if (input) {
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
        if (!item.call_id || !item.name) unsupported("Unsupported Responses function call without id or name");
        const name = sanitizeGeminiFunctionName(item.name);
        const cachedSignature = getGeminiThoughtSignatureSync(item.call_id, sessionId, model);
        const callSignature = cachedSignature || (!firstFunctionCallSeen ? signature : undefined);
        firstFunctionCallSeen = true;
        calls.set(item.call_id, name);
        const args = tryParseJSON(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})) || {};
        const part = { functionCall: { id: item.call_id, name, args } };
        if (callSignature) part.thoughtSignature = callSignature;
        result.contents.push({ role: GEMINI_ROLE.MODEL, parts: [part] });
        continue;
      }
      if (type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
        const name = calls.get(item.call_id);
        if (!name) unsupported("Unsupported Responses orphan function call output");
        const parsed = tryParseJSON(typeof item.output === "string" ? item.output : JSON.stringify(item.output));
        result.contents.push({ role: GEMINI_ROLE.USER, parts: [{
          functionResponse: { id: item.call_id, name, response: { result: parsed && typeof parsed === "object" ? parsed : (parsed ?? item.output ?? "") } },
        }] });
        continue;
      }
      unsupported(`Unsupported Responses input item '${type || "unknown"}'`);
    }
    result.contents = normalizeGeminiContents(result.contents);
  }

  const declarations = functionDeclarations(body.tools);
  if (declarations.length) result.tools = [{ functionDeclarations: declarations }];
  const config = toolConfig(body, declarations);
  if (config) result.toolConfig = config;
  return result;
}

export function responsesToGeminiRequest(model, body, stream, credentials = null) {
  return responsesToGeminiBase(model, body, DEFAULT_THINKING_AG_SIGNATURE, credentials?._clientSessionId, "jsonSchema");
}

export function responsesToVertexRequest(model, body, stream, credentials = null) {
  return postProcessForVertex(responsesToGeminiRequest(model, body, stream, credentials));
}

export function responsesToGeminiCLIRequest(model, body, stream, credentials = null) {
  return wrapInCloudCodeEnvelope(model, responsesToGeminiBase(model, body, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE, credentials?._clientSessionId), credentials);
}

export function responsesToAntigravityRequest(model, body, stream, credentials = null) {
  if (String(model || "").toLowerCase().includes("claude")) {
    return openaiToAntigravityRequest(model, openaiResponsesToOpenAIRequest(model, body, stream, credentials), stream, credentials);
  }
  return wrapInCloudCodeEnvelope(model, responsesToGeminiBase(model, body, DEFAULT_THINKING_AG_SIGNATURE, credentials?._clientSessionId), credentials, true);
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, responsesToGeminiRequest, null);
register(FORMATS.OPENAI_RESPONSES, FORMATS.VERTEX, responsesToVertexRequest, null);
register(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI_CLI, responsesToGeminiCLIRequest, null);
register(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, responsesToAntigravityRequest, null);
