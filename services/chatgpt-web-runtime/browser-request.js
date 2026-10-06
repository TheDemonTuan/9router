import { REASONING_LEVELS } from "./protocol.js";

/**
 * @typedef {{type: "input_text" | "output_text", text: string}} BrowserResponseText
 * @typedef {{type: "function", name: string, description?: string, parameters: Record<string, unknown>, strict?: boolean}} BrowserFunctionTool
 * @typedef {{type: "function_call", call_id: string, name: string, arguments: string}} BrowserFunctionCall
 * @typedef {{type: "function_call_output", call_id: string, output: string | BrowserResponseText[]}} BrowserFunctionOutput
 * @typedef {{type: "message", role: "system" | "developer" | "user" | "assistant", content: BrowserResponseText[]}} BrowserResponseMessage
 * @typedef {{role: "system" | "developer" | "user" | "assistant" | "tool", content: string | {type: "text", text: string}[] | null, tool_call_id?: string, tool_calls?: {id: string, type: "function", function: {name: string, arguments: string}}[]}} BrowserChatMessage
 * @typedef {{model: string, stream?: boolean, store?: false, reasoning?: {effort?: string, summary?: "auto"}, text?: {format?: {type: "text"}, verbosity?: "low" | "medium" | "high"}, parallel_tool_calls?: boolean}} BrowserRequestCommon
 * @typedef {BrowserRequestCommon & {input: (BrowserResponseMessage | BrowserFunctionCall | BrowserFunctionOutput)[], instructions?: string, tools?: BrowserFunctionTool[], tool_choice?: "auto" | "none" | "required" | {type: "function", name: string}}} BrowserResponsesRequest
 * @typedef {BrowserRequestCommon & {messages: BrowserChatMessage[], tools?: {type: "function", function: Omit<BrowserFunctionTool, "type">}[], tool_choice?: "auto" | "none" | "required" | {type: "function", function: {name: string}}, reasoning_effort?: string, stream_options?: {include_usage?: boolean}, response_format?: {type: "text"}}} BrowserChatRequest
 */

export class BrowserRequestError extends Error {
  constructor(field) {
    const safeField = /^[a-zA-Z0-9_.]+$/.test(field) ? field : "request";
    super(`Browser-only text requests do not support this value for ${safeField}`);
    this.name = "BrowserRequestError";
    this.code = "unsupported_browser_request";
    this.status = 400;
  }
}
const fail = field => { throw new BrowserRequestError(field); };
const object = (value, field) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value;
};
const keys = (value, allowed, field) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`);
};
const roles = ["system", "developer", "user", "assistant"];
function textContent(value, chat, role, result = false) {
  const canonicalType = chat ? "text" : role === "assistant" ? "output_text" : "input_text";
  if (typeof value === "string") return chat || result ? value : [{ type: canonicalType, text: value }];
  if (!Array.isArray(value)) fail("message.content");
  return value.map(part => {
    object(part, "content");
    keys(part, !chat && !result ? ["type", "text", "annotations", "logprobs"] : ["type", "text"], "content");
    const allowed = chat ? ["text"] : result ? ["input_text", "text", "output_text"] : ["text", canonicalType];
    if (!allowed.includes(part.type) || typeof part.text !== "string") fail("content.type");
    if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) fail("content.annotations");
    if (part.logprobs !== undefined && part.logprobs !== null && (!Array.isArray(part.logprobs) || part.logprobs.length)) fail("content.logprobs");
    return { type: canonicalType, text: part.text };
  });
}
function argumentsObject(value) {
  if (typeof value !== "string") fail("arguments");
  try { object(JSON.parse(value), "arguments"); } catch { fail("arguments"); }
  return value;
}
function messages(value, chat) {
  if (!Array.isArray(value) || !value.length) fail(chat ? "messages" : "input");
  let userText = false;
  const seen = new Set();
  const pending = new Set();
  let returningResults = false;
  const call = id => {
    if (pending.size && returningResults) fail("unresolved_tool_calls");
    if (!pending.size) returningResults = false;
    if (typeof id !== "string" || !id.length || seen.has(id)) fail("call_id");
    seen.add(id); pending.add(id);
  };
  const output = id => {
    if (typeof id !== "string" || !pending.delete(id)) fail("tool_call_id");
    returningResults = pending.size > 0;
  };
  const normalized = value.map(item => {
    object(item, "message");
    if (chat && item.role === "tool") {
      keys(item, ["role", "tool_call_id", "content"], "message");
      output(item.tool_call_id);
      return { role: "tool", tool_call_id: item.tool_call_id, content: textContent(item.content, true, "tool", true) };
    }
    if (!chat && item.type === "function_call_output") {
      keys(item, ["type", "call_id", "output", "id"], "message");
      if (item.id !== undefined && typeof item.id !== "string") fail("message.id");
      output(item.call_id);
      return { type: "function_call_output", call_id: item.call_id, output: textContent(item.output, false, "tool", true) };
    }
    if (!chat && item.type === "function_call") {
      keys(item, ["type", "call_id", "name", "arguments", "id", "status"], "message");
      if (item.id !== undefined && typeof item.id !== "string" || item.status !== undefined && item.status !== "completed") fail("message.status");
      if (typeof item.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) fail("function.name");
      call(item.call_id);
      return { type: "function_call", call_id: item.call_id, name: item.name, arguments: argumentsObject(item.arguments) };
    }
    if (pending.size) fail("unresolved_tool_calls");
    keys(item, chat ? ["role", "content", "tool_calls"] : ["type", "role", "content", "id", "status"], "message");
    if (!roles.includes(item.role) || !chat && item.type !== undefined && item.type !== "message") fail("message.role");
    if (!chat && (item.id !== undefined && typeof item.id !== "string" || item.status !== undefined && (item.role !== "assistant" || item.status !== "completed"))) fail("message.status");
    let toolCalls;
    if (chat && item.tool_calls !== undefined) {
      if (item.role !== "assistant" || !Array.isArray(item.tool_calls) || !item.tool_calls.length) fail("tool_calls");
      toolCalls = item.tool_calls.map(entry => {
        object(entry, "tool_call"); keys(entry, ["id", "type", "function"], "tool_call");
        object(entry.function, "function"); keys(entry.function, ["name", "arguments"], "function");
        if (entry.type !== "function" || typeof entry.function.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.function.name)) fail("function.name");
        call(entry.id);
        return { id: entry.id, type: "function", function: { name: entry.function.name, arguments: argumentsObject(entry.function.arguments) } };
      });
    }
    const content = toolCalls && item.content == null ? null : textContent(item.content, chat, item.role);
    if (item.role === "user" && (typeof content === "string" ? content.trim() : content.some(part => part.text.trim()))) userText = true;
    return chat ? { role: item.role, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
      : { type: "message", role: item.role, content };
  });
  if (pending.size) fail("unresolved_tool_calls");
  if (!userText) fail(chat ? "messages" : "input");
  return normalized;
}
function toolPolicy(value, chat, result) {
  const names = new Set();
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) fail("tools");
    result.tools = value.tools.map(tool => {
      object(tool, "tool");
      keys(tool, chat ? ["type", "function"] : ["type", "name", "description", "parameters", "strict"], "tool");
      if (tool.type !== "function") fail("tool.type");
      const fn = chat ? object(tool.function, "function") : tool;
      if (chat) keys(fn, ["name", "description", "parameters", "strict"], "function");
      if (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name) || names.has(fn.name)) fail("function.name");
      names.add(fn.name);
      if (fn.description !== undefined && typeof fn.description !== "string") fail("function.description");
      if (fn.strict !== undefined && fn.strict !== null && typeof fn.strict !== "boolean") fail("function.strict");
      const parameters = fn.parameters === undefined ? { type: "object", properties: {} } : object(fn.parameters, "function.parameters");
      const definition = { name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), parameters, ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}) };
      return chat ? { type: "function", function: definition } : { type: "function", ...definition };
    });
  }
  if (result.tools?.length === 0) delete result.tools;
  let choice = value.tool_choice;
  if (choice !== undefined && !["auto", "none", "required"].includes(choice)) {
    object(choice, "tool_choice"); keys(choice, chat ? ["type", "function"] : ["type", "name"], "tool_choice");
    if (choice.type !== "function") fail("tool_choice.type");
    const fn = chat ? object(choice.function, "tool_choice.function") : choice;
    if (chat) keys(fn, ["name"], "tool_choice.function");
    if (!names.has(fn.name)) fail("tool_choice.name");
    choice = chat ? { type: "function", function: { name: fn.name } } : { type: "function", name: fn.name };
  }
  if (choice === "required" && !names.size) fail("tool_choice");
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") fail("parallel_tool_calls");
  if (names.size || browserRequestUsesTools(value)) {
    result.tool_choice = choice ?? (names.size ? "auto" : "none");
    result.parallel_tool_calls = value.parallel_tool_calls ?? true;
  } else {
    if (choice !== undefined && choice !== "none") result.tool_choice = choice;
  }
}
/** Selects the client protocol only; never grants native execution authority. */
export function browserRequestUsesTools(value) {
  if (!value || typeof value !== "object") return false;
  return Array.isArray(value.tools) && value.tools.length > 0
    || Array.isArray(value.messages) && value.messages.some(item => item?.role === "tool" || Array.isArray(item?.tool_calls) && item.tool_calls.length > 0)
    || Array.isArray(value.input) && value.input.some(item => item?.type === "function_call" || item?.type === "function_call_output");
}
function common(value, chat) {
  object(value, "request");
  keys(value, ["model", "stream", "reasoning", "text", "store", "tools", "tool_choice", "parallel_tool_calls", "metadata", "user", "prompt_cache_key",
    ...(chat ? ["messages", "reasoning_effort", "stream_options", "n", "response_format"] : ["input", "instructions"])], "request");
  if (typeof value.model !== "string" || !value.model.trim()) fail("model");
  const result = { model: value.model };
  if (value.stream !== undefined) {
    if (typeof value.stream !== "boolean") fail("stream");
    result.stream = value.stream;
  }
  if (value.store !== undefined && value.store !== false) fail("store");
  if (value.store === false) result.store = false;
  toolPolicy(value, chat, result);
  let effort;
  if (value.reasoning !== undefined) {
    object(value.reasoning, "reasoning"); keys(value.reasoning, ["effort", "summary"], "reasoning");
    effort = value.reasoning.effort;
    if (effort !== undefined && !REASONING_LEVELS.includes(effort)) fail("reasoning.effort");
    if (value.reasoning.summary !== undefined && value.reasoning.summary !== "auto") fail("reasoning.summary");
    result.reasoning = { ...(effort !== undefined ? { effort } : {}), ...(value.reasoning.summary === "auto" ? { summary: "auto" } : {}) };
  }
  if (chat && value.reasoning_effort !== undefined) {
    if (!REASONING_LEVELS.includes(value.reasoning_effort) || effort !== undefined && effort !== value.reasoning_effort) fail("reasoning_effort");
    result.reasoning_effort = value.reasoning_effort;
  }
  if (value.text !== undefined) {
    object(value.text, "text"); keys(value.text, ["format", "verbosity"], "text");
    const text = {};
    if (value.text.format !== undefined) {
      object(value.text.format, "text.format"); keys(value.text.format, ["type"], "text.format");
      if (value.text.format.type !== "text") fail("text.format");
      text.format = { type: "text" };
    }
    if (value.text.verbosity !== undefined) {
      if (!["low", "medium", "high"].includes(value.text.verbosity)) fail("text.verbosity");
      text.verbosity = value.text.verbosity;
    }
    result.text = text;
  }
  // Benign metadata is validated, but never enters a browser prompt or execution identity.
  if (value.metadata !== undefined && value.metadata !== null) {
    object(value.metadata, "metadata");
    if (Object.keys(value.metadata).length > 16 || Object.entries(value.metadata).some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 512)) fail("metadata");
  }
  for (const key of ["user", "prompt_cache_key"]) if (value[key] !== undefined && typeof value[key] !== "string") fail(key);
  return result;
}
/** @param {unknown} value @returns {BrowserResponsesRequest} */
export function validateBrowserResponsesRequest(value) {
  const result = common(value, false);
  const input = typeof value.input === "string" ? [{ role: "user", content: value.input }] : value.input;
  result.input = messages(input, false);
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== "string") fail("instructions");
    result.instructions = value.instructions;
  }
  return result;
}
/** @param {unknown} value @returns {BrowserChatRequest} */
export function validateBrowserChatRequest(value) {
  const result = common(value, true);
  result.messages = messages(value.messages, true);
  if (value.n !== undefined && value.n !== 1) fail("n");
  if (value.response_format !== undefined) {
    object(value.response_format, "response_format"); keys(value.response_format, ["type"], "response_format");
    if (value.response_format.type !== "text") fail("response_format");
    result.response_format = { type: "text" };
  }
  if (value.stream_options !== undefined) {
    object(value.stream_options, "stream_options"); keys(value.stream_options, ["include_usage"], "stream_options");
    if (value.stream_options.include_usage !== undefined && typeof value.stream_options.include_usage !== "boolean") fail("stream_options.include_usage");
    result.stream_options = { ...value.stream_options };
  }
  return result;
}
