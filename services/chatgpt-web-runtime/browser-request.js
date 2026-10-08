import { REASONING_LEVELS } from "./protocol.js";

/**
 * @typedef {{type: "input_text" | "output_text", text: string}} BrowserResponseText
 * @typedef {{type: "message", role: "system" | "developer" | "user" | "assistant", content: BrowserResponseText[]}} BrowserResponseMessage
 * @typedef {{role: "system" | "developer" | "user" | "assistant", content: string | {type: "text", text: string}[]}} BrowserChatMessage
 * @typedef {{model: string, stream?: boolean, store?: false, reasoning?: {effort?: string, summary?: "auto"}, text?: {format?: {type: "text"}, verbosity?: "low" | "medium" | "high"}}} BrowserRequestCommon
 * @typedef {BrowserRequestCommon & {input: BrowserResponseMessage[], instructions?: string}} BrowserResponsesRequest
 * @typedef {BrowserRequestCommon & {messages: BrowserChatMessage[], reasoning_effort?: string, stream_options?: {include_usage?: boolean}, response_format?: {type: "text"}}} BrowserChatRequest
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
/** Shared text normalization; callers supply their own safe error type. */
export function normalizeBrowserTextContent(value, role, chat, reject = fail) {
  const canonicalType = chat ? "text" : role === "assistant" ? "output_text" : "input_text";
  if (typeof value === "string") return chat ? value : [{ type: canonicalType, text: value }];
  if (!Array.isArray(value)) reject("message.content");
  return value.map(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) reject("content");
    if (Object.keys(part).some(key => !["type", "text"].includes(key))) reject("content");
    if (!(chat ? ["text"] : ["text", canonicalType]).includes(part.type) || typeof part.text !== "string") reject("content.type");
    return { type: canonicalType, text: part.text };
  });
}
function messages(value, chat) {
  if (!Array.isArray(value) || !value.length) fail(chat ? "messages" : "input");
  let userText = false;
  const normalized = value.map(item => {
    object(item, "message");
    keys(item, chat ? ["role", "content"] : ["type", "role", "content"], "message");
    if (!roles.includes(item.role) || !chat && item.type !== undefined && item.type !== "message") fail("message.role");
    const content = normalizeBrowserTextContent(item.content, item.role, chat);
    if (item.role === "user" && (typeof content === "string" ? content.trim() : content.some(part => part.text.trim()))) userText = true;
    return chat ? { role: item.role, content: typeof item.content === "string" ? item.content : content }
      : { type: "message", role: item.role, content };
  });
  if (!userText) fail(chat ? "messages" : "input");
  return normalized;
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
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length)) fail("tools");
  if (value.tool_choice !== undefined && value.tool_choice !== "none") fail("tool_choice");
  if (value.parallel_tool_calls !== undefined && value.parallel_tool_calls !== false) fail("parallel_tool_calls");
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
