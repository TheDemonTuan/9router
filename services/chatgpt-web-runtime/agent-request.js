import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { normalizeBrowserTextContent, validateBrowserChatRequest, validateBrowserResponsesRequest } from "./browser-request.js";

/**
 * @typedef {{name:string, description?:string, parameters:Record<string,unknown>, strict?:boolean}} AgentFunctionDefinition
 * @typedef {{type:"function", name:string, description?:string, parameters:Record<string,unknown>, strict?:boolean}} AgentResponseTool
 * @typedef {"auto"|"none"|"required"|{type:"function",name:string}} AgentResponseToolChoice
 * @typedef {{type:"function_call",call_id:string,name:string,arguments:string,id?:string,status?:"completed"}} AgentResponseFunctionCall
 * @typedef {{type:"function_call_output",call_id:string,output:string,id?:string,status?:"completed"}} AgentResponseFunctionOutput
 * @typedef {import("./browser-request.js").BrowserResponseMessage|AgentResponseFunctionCall|AgentResponseFunctionOutput} AgentResponseInput
 * @typedef {{id:string,type:"function",function:{name:string,arguments:string}}} AgentChatFunctionCall
 * @typedef {{role:"system"|"developer"|"user"|"assistant",content:string|{type:"text",text:string}[]|null,tool_calls?:AgentChatFunctionCall[]}|{role:"tool",tool_call_id:string,content:string|{type:"text",text:string}[]}} AgentChatMessage
 * @typedef {import("./browser-request.js").BrowserRequestCommon & {input:AgentResponseInput[],instructions?:string,tools:AgentResponseTool[],tool_choice:AgentResponseToolChoice,parallel_tool_calls:boolean,store:false}} AgentResponsesRequest
 * @typedef {import("./browser-request.js").BrowserRequestCommon & {messages:AgentChatMessage[],reasoning_effort?:string,stream_options?:{include_usage?:boolean},response_format?:{type:"text"},tools:{type:"function",function:AgentFunctionDefinition}[],tool_choice:"auto"|"none"|"required"|{type:"function",function:{name:string}},parallel_tool_calls:boolean,store:false}} AgentChatRequest
 */

export const AGENT_MAX_TOOLS = 128;
export const AGENT_MAX_CALLS = 128;
export const AGENT_MAX_ARGUMENT_BYTES = 1024 * 1024;
export const AGENT_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const AGENT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const schemaConstructors = { "draft-07": Ajv, "2019-09": Ajv2019, "2020-12": Ajv2020 };
const schemaValidators = new Map();
/** @param {Record<string, unknown>} schema @returns {"draft-07"|"2019-09"|"2020-12"} */
export function agentSchemaDialect(schema) {
  if (schema.$schema === undefined) return "draft-07";
  if (typeof schema.$schema !== "string") fail("function.parameters");
  switch (schema.$schema.replace(/#$/, "")) {
    case "http://json-schema.org/draft-07/schema":
    case "https://json-schema.org/draft-07/schema": return "draft-07";
    case "https://json-schema.org/draft/2019-09/schema": return "2019-09";
    case "https://json-schema.org/draft/2020-12/schema": return "2020-12";
    default: return fail("function.parameters");
  }
}
/** @param {Record<string, unknown>} schema @param {boolean} validateFormats */
export function createAgentSchemaValidator(schema, validateFormats = false) {
  const dialect = agentSchemaDialect(schema), Validator = schemaConstructors[dialect];
  const validator = new Validator({ strict: false, validateFormats, coerceTypes: false, useDefaults: false, removeAdditional: false });
  if (dialect === "draft-07") validator.addMetaSchema({ $ref: "http://json-schema.org/draft-07/schema" }, "https://json-schema.org/draft-07/schema");
  return validator;
}
const bytes = value => new TextEncoder().encode(value).byteLength;
export class AgentRequestError extends Error {
  constructor(field = "request") {
    super(`OpenAI-compatible agent requests do not support this value for ${/^[a-zA-Z0-9_.]+$/.test(field) ? field : "request"}`);
    this.name = "AgentRequestError";
    this.code = "unsupported_agent_request";
    this.status = 400;
  }
}
const fail = field => { throw new AgentRequestError(field); };
const object = (value, field) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value;
};
const keys = (value, allowed, field) => {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(field);
};
const id = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 64) fail("call_id");
  return value;
};
const name = value => {
  if (typeof value !== "string" || !AGENT_TOOL_NAME.test(value)) fail("function.name");
  return value;
};
export function validateAgentArguments(value) {
  if (typeof value !== "string" || bytes(value) > AGENT_MAX_ARGUMENT_BYTES) fail("function.arguments");
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail("function.arguments"); }
  object(parsed, "function.arguments");
  return parsed;
}
// Only document-local references are allowed. No schema can load a URL or another document.
/** @param {unknown} value @returns {Record<string, unknown>} */
export function validateAgentSchema(value) {
  object(value, "function.parameters");
  try {
    const dialect = agentSchemaDialect(value);
    let validator = schemaValidators.get(dialect);
    if (!validator) { validator = createAgentSchemaValidator(value); schemaValidators.set(dialect, validator); }
    if (bytes(JSON.stringify(value)) > AGENT_MAX_ARGUMENT_BYTES || !validator.validateSchema(value)) fail("function.parameters");
  } catch { fail("function.parameters"); }
  const walk = item => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { for (const child of item) walk(child); return; }
    for (const [key, child] of Object.entries(item)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && (typeof child !== "string" || !child.startsWith("#"))) fail("function.parameters");
      if (key === "$id") fail("function.parameters");
      walk(child);
    }
  };
  walk(value);
  try { return structuredClone(value); } catch { fail("function.parameters"); }
}
function tools(value, chat) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AGENT_MAX_TOOLS) fail("tools");
  const names = new Set();
  return value.map(tool => {
    keys(tool, chat ? ["type", "function"] : ["type", "name", "description", "parameters", "strict"], "tools");
    if (tool.type !== "function") fail("tools.type");
    const fn = chat ? tool.function : tool;
    if (chat) keys(fn, ["name", "description", "parameters", "strict"], "function");
    const toolName = name(fn.name);
    if (names.has(toolName)) fail("tools.name");
    names.add(toolName);
    if (fn.description !== undefined && typeof fn.description !== "string") fail("function.description");
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") fail("function.strict");
    const normalized = { name: toolName, ...(fn.description !== undefined ? { description: fn.description } : {}), parameters: validateAgentSchema(fn.parameters === undefined ? { type: "object", properties: {} } : fn.parameters), ...(fn.strict !== undefined ? { strict: fn.strict } : {}) };
    return chat ? { type: "function", function: normalized } : { type: "function", ...normalized };
  });
}
function choice(value, inventory, chat) {
  const selected = value ?? "auto";
  const names = inventory.map(tool => chat ? tool.function.name : tool.name);
  if (typeof selected === "string") {
    if (!["auto", "none", "required"].includes(selected) || selected === "required" && !names.length) fail("tool_choice");
    return selected;
  }
  keys(selected, chat ? ["type", "function"] : ["type", "name"], "tool_choice");
  if (selected.type !== "function") fail("tool_choice");
  if (chat) keys(selected.function, ["name"], "tool_choice.function");
  const selectedName = name(chat ? selected.function.name : selected.name);
  if (!names.includes(selectedName)) fail("tool_choice");
  return chat ? { type: "function", function: { name: selectedName } } : { type: "function", name: selectedName };
}
function validate(value, chat) {
  object(value, "request");
  // Reuse the text lane's strict option allowlist, including its unsupported-control policy.
  // Only the separately validated tool fields and history are replaced in this projection.
  const projected = { ...value, tools: [], tool_choice: "none", parallel_tool_calls: false };
  if (chat) projected.messages = [{ role: "user", content: "validation" }];
  else projected.input = [{ role: "user", content: "validation" }];
  let result;
  try { result = chat ? validateBrowserChatRequest(projected) : validateBrowserResponsesRequest(projected); }
  catch { fail("request"); }
  result.tools = tools(value.tools, chat);
  result.tool_choice = choice(value.tool_choice, result.tools, chat);
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") fail("parallel_tool_calls");
  result.parallel_tool_calls = value.parallel_tool_calls ?? true;
  result.store = false;
  const input = chat ? value.messages : typeof value.input === "string" ? [{ role: "user", content: value.input }] : value.input;
  if (!Array.isArray(input) || !input.length) fail(chat ? "messages" : "input");
  const seen = new Set();
  const pending = new Set();
  let hasUser = false;
  let batchBytes = 0;
  let batchCount = 0;
  let resultsStarted = false;
  const call = (callId, toolName, args) => {
    id(callId); name(toolName); validateAgentArguments(args);
    if (seen.has(callId) || resultsStarted) fail("call_id");
    seen.add(callId); pending.add(callId);
    batchBytes += bytes(args); batchCount++;
    if (batchCount > AGENT_MAX_CALLS || batchBytes > AGENT_MAX_BATCH_BYTES) fail("function.arguments");
  };
  const output = (callId, content) => {
    id(callId);
    if (!pending.delete(callId)) fail("tool_result");
    resultsStarted = true;
    if (!pending.size) { batchBytes = 0; batchCount = 0; resultsStarted = false; }
    return content;
  };
  const normalized = input.map(item => {
    object(item, "message");
    if (!chat && item.type === "function_call") {
      keys(item, ["type", "call_id", "name", "arguments", "id", "status"], "function_call");
      if (item.id !== undefined) id(item.id);
      if (item.status !== undefined && item.status !== "completed") fail("function_call.status");
      call(item.call_id, item.name, item.arguments);
      return { ...item };
    }
    if (!chat && item.type === "function_call_output") {
      keys(item, ["type", "call_id", "output", "id", "status"], "function_call_output");
      if (item.id !== undefined) id(item.id);
      if (item.status !== undefined && item.status !== "completed") fail("function_call_output.status");
      if (typeof item.output !== "string") fail("function_call_output.output");
      output(item.call_id, item.output);
      return { ...item };
    }
    if (chat && item.role === "tool") {
      keys(item, ["role", "tool_call_id", "content"], "tool_result");
      const content = normalizeBrowserTextContent(item.content, "tool", true, fail);
      output(item.tool_call_id, content);
      return { role: "tool", tool_call_id: item.tool_call_id, content };
    }
    if (pending.size) fail("history.unresolved_calls");
    keys(item, chat ? ["role", "content", "tool_calls"] : ["type", "role", "content"], "message");
    if (!["system", "developer", "user", "assistant"].includes(item.role) || !chat && item.type !== undefined && item.type !== "message") fail("message.role");
    const hasCalls = chat && item.tool_calls !== undefined;
    if (hasCalls && (item.role !== "assistant" || !Array.isArray(item.tool_calls) || !item.tool_calls.length || item.tool_calls.length > AGENT_MAX_CALLS)) fail("tool_calls");
    const content = hasCalls && item.content == null ? item.content ?? null : normalizeBrowserTextContent(item.content, item.role, chat, fail);
    if (item.role === "user" && (typeof content === "string" ? content.trim() : content.some(part => part.text.trim()))) hasUser = true;
    const message = chat ? { role: item.role, content } : { type: "message", role: item.role, content };
    if (hasCalls) message.tool_calls = item.tool_calls.map(toolCall => {
      keys(toolCall, ["id", "type", "function"], "tool_calls");
      if (toolCall.type !== "function") fail("tool_calls.type");
      keys(toolCall.function, ["name", "arguments"], "tool_calls.function");
      call(toolCall.id, toolCall.function.name, toolCall.function.arguments);
      return { id: toolCall.id, type: "function", function: { ...toolCall.function } };
    });
    return message;
  });
  if (!hasUser || pending.size) fail("history.unresolved_calls");
  if (chat) result.messages = normalized;
  else result.input = normalized;
  return result;
}
/** @param {unknown} value @returns {AgentChatRequest} */
export function validateAgentChatRequest(value) { return validate(value, true); }
/** @param {unknown} value @returns {AgentResponsesRequest} */
export function validateAgentResponsesRequest(value) { return validate(value, false); }
