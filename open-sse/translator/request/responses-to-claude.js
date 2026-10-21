import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { parseDataUri } from "../concerns/image.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { unsealClaudeReasoning } from "../concerns/claudeContinuation.js";
import { convertOpenAIToolChoice } from "./openai-to-claude.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";

function invalid(message, param = "input", code = "invalid_request_error") {
  throw Object.assign(new Error(message), { status: 400, code, param });
}

function unsupported(param) {
  invalid(`${param} is not supported by the stateless Claude Responses adapter`, param, "unsupported_parameter");
}

function object(value, param) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${param} must be an object`, param);
  return value;
}

function nonempty(value, param) {
  if (typeof value !== "string" || !value) invalid(`${param} must be a nonempty string`, param);
  return value;
}

function jsonArguments(value) {
  if (typeof value !== "string") invalid("function_call.arguments must be a complete JSON object string");
  let parsed;
  try { parsed = JSON.parse(value); } catch { invalid("function_call.arguments must be complete valid JSON"); }
  return object(parsed, "function_call.arguments");
}

function image(part, capabilities) {
  if (capabilities.vision === false) unsupported("input_image for this model");
  if (part.file_id != null) unsupported("input_image.file_id");
  if (part.detail != null && part.detail !== "auto") unsupported("input_image.detail");
  const url = nonempty(part.image_url, "input_image.image_url");
  const parsed = parseDataUri(url);
  if (parsed) {
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(parsed.mimeType)) unsupported("input_image media type");
    return { type: CLAUDE_BLOCK.IMAGE, source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 } };
  }
  if (!/^https?:\/\//.test(url)) invalid("input_image.image_url must be an HTTP URL or supported data URI");
  return { type: CLAUDE_BLOCK.IMAGE, source: { type: "url", url } };
}

function file(part, capabilities) {
  if (capabilities.pdf === false) unsupported("input_file for this model");
  if (part.file_id != null) unsupported("input_file.file_id");
  let source;
  if (part.file_data != null && part.file_url != null) invalid("input_file must supply exactly one source");
  if (part.file_url != null) {
    const url = nonempty(part.file_url, "input_file.file_url");
    if (!/^https?:\/\//.test(url)) invalid("input_file.file_url must be an HTTP URL");
    source = { type: "url", url };
  } else {
    const parsed = parseDataUri(nonempty(part.file_data, "input_file.file_data"));
    if (!parsed) invalid("input_file.file_data must be a data URI");
    if (parsed.mimeType === "application/pdf") source = { type: "base64", media_type: parsed.mimeType, data: parsed.base64 };
    else if (parsed.mimeType === "text/plain") {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parsed.base64, "base64")); }
      catch { invalid("input_file text must be valid UTF-8"); }
      source = { type: "text", media_type: "text/plain", data: text };
    }
    else unsupported("input_file media type");
  }
  return { type: CLAUDE_BLOCK.DOCUMENT, source, ...(part.filename != null ? { title: nonempty(part.filename, "input_file.filename") } : {}) };
}

function content(value, role, capabilities) {
  if (typeof value === "string") return [{ type: CLAUDE_BLOCK.TEXT, text: value }];
  if (!Array.isArray(value) || value.length === 0) invalid("Message content must be text or a nonempty content array");
  return value.map(part => {
    object(part, "content");
    if ([RESPONSES_ITEM.INPUT_TEXT, RESPONSES_ITEM.OUTPUT_TEXT, CLAUDE_BLOCK.TEXT].includes(part.type)) {
      if (typeof part.text !== "string") invalid("Text content must contain a string text field");
      if (part.annotations?.length) unsupported("output_text.annotations");
      return { type: CLAUDE_BLOCK.TEXT, text: part.text };
    }
    if (role !== ROLE.USER) unsupported(`content.${part.type}`);
    if (part.type === RESPONSES_ITEM.INPUT_IMAGE) return image(part, capabilities);
    if (part.type === RESPONSES_ITEM.INPUT_FILE) return file(part, capabilities);
    unsupported(`content.${part.type}`);
  });
}

function validateOptions(body) {
  for (const name of ["previous_response_id", "conversation", "background", "max_tool_calls", "prompt", "prompt_cache_key", "prompt_cache_retention", "context_management", "truncation", "top_logprobs", "logprobs", "frequency_penalty", "presence_penalty", "seed", "service_tier", "response_format"]) {
    if (body[name] != null && !(name === "background" && body[name] === false) && !(name === "truncation" && body[name] === "disabled")) unsupported(name);
  }
  if (body.store === true) unsupported("store");
  if (body.include != null && (!Array.isArray(body.include) || body.include.some(value => value !== "reasoning.encrypted_content"))) unsupported("include");
  if (body.reasoning?.summary != null && body.reasoning.summary !== "none" && body.reasoning.summary !== "auto") unsupported("reasoning.summary");
  if (body.text?.verbosity != null) unsupported("text.verbosity");
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== "boolean") invalid("parallel_tool_calls must be a boolean", "parallel_tool_calls");
}

export function responsesToClaudeRequest(model, body, stream, credentials = null) {
  object(body, "body");
  validateOptions(body);
  const context = credentials?._responsesClaudeContext || {};
  const provider = context.provider || "claude";
  const capabilities = getCapabilitiesForModel(provider, model);
  const ceiling = capabilities.maxOutput || DEFAULT_MAX_TOKENS;
  if (body.max_output_tokens != null && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0 || body.max_output_tokens > ceiling)) {
    invalid(`max_output_tokens must be a positive integer at most ${ceiling}`, "max_output_tokens");
  }
  const result = { model, stream, max_tokens: body.max_output_tokens ?? adjustMaxTokens({}, ceiling), messages: [], _directResponsesToClaude: true, _explicitMaxOutputTokens: body.max_output_tokens != null };
  for (const name of ["temperature", "top_p"]) if (body[name] != null) result[name] = body[name];
  const system = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== "string") invalid("instructions must be a string", "instructions");
    system.push({ type: CLAUDE_BLOCK.TEXT, text: body.instructions });
  }
  const customNames = new Set();
  const declared = new Set();
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) invalid("tools must be an array", "tools");
    result.tools = body.tools.map(tool => {
      object(tool, "tools");
      if (tool.type !== "function" && tool.type !== "custom") unsupported(`tools.${tool.type}`);
      const name = nonempty(tool.name, "tools.name");
      if (declared.has(name)) invalid(`Duplicate tool name: ${name}`, "tools");
      declared.add(name);
      let schema;
      if (tool.type === "custom") {
        if (tool.format != null && tool.format.type !== "text") unsupported("tools.custom.format");
        customNames.add(name);
        schema = { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false };
      } else schema = object(tool.parameters ?? { type: "object", properties: {} }, "tools.parameters");
      if (tool.strict != null && typeof tool.strict !== "boolean") invalid("tools.strict must be a boolean", "tools");
      return { name, ...(tool.description != null ? { description: tool.description } : {}), input_schema: schema, ...(tool.type === "custom" ? { strict: true } : tool.strict != null ? { strict: tool.strict } : {}) };
    });
  }
  if (body.tool_choice != null) {
    const choice = body.tool_choice;
    if (typeof choice === "string" && !["none", "auto", "required"].includes(choice)) unsupported("tool_choice");
    if (typeof choice === "object" && (!["function", "custom"].includes(choice?.type) || !declared.has(choice.name) || (choice.type === "custom") !== customNames.has(choice.name))) invalid("tool_choice must name a declared tool of the matching type", "tool_choice");
    result.tool_choice = convertOpenAIToolChoice(choice);
    if (!result.tools?.length && result.tool_choice.type !== "none") invalid("tool_choice requires declared tools", "tool_choice");
  }
  if (body.parallel_tool_calls === false && result.tools?.length && result.tool_choice?.type !== "none") result.tool_choice = { ...(result.tool_choice || { type: "auto" }), disable_parallel_tool_use: true };
  const format = body.text?.format;
  if (format != null && format.type !== "text") {
    if (format.type !== "json_schema") unsupported("text.format");
    object(format.schema, "text.format.schema");
    if (format.strict === false) unsupported("text.format.strict=false");
    result.output_config = { format: { type: "json_schema", schema: format.schema } };
  }

  const input = typeof body.input === "string" ? [{ role: ROLE.USER, content: body.input }] : body.input;
  if (!Array.isArray(input) || input.length === 0) invalid("input must be a string or nonempty array");
  const seenIds = new Set();
  const pending = new Map();
  const append = (role, blocks) => {
    const last = result.messages[result.messages.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else result.messages.push({ role, content: blocks });
  };
  const requireResolved = () => { if (pending.size) invalid(`Missing tool results for: ${[...pending.keys()].join(", ")}`); };
  for (const item of input) {
    object(item, "input item");
    const type = item.type || RESPONSES_ITEM.MESSAGE;
    if (type === RESPONSES_ITEM.MESSAGE) {
      if (item.role === ROLE.SYSTEM || item.role === ROLE.DEVELOPER) {
        system.push(...content(item.content, ROLE.SYSTEM, capabilities));
        continue;
      }
      if (item.role !== ROLE.USER && item.role !== ROLE.ASSISTANT) invalid("Unsupported message role");
      if (item.role !== ROLE.ASSISTANT || result.messages[result.messages.length - 1]?.role !== ROLE.ASSISTANT) requireResolved();
      append(item.role, content(item.content, item.role, capabilities));
    } else if (type === RESPONSES_ITEM.REASONING) {
      if (result.messages[result.messages.length - 1]?.role !== ROLE.ASSISTANT) requireResolved();
      if (!item.encrypted_content) invalid("Reasoning history requires native reasoning.encrypted_content; summaries cannot replace signed thinking");
      append(ROLE.ASSISTANT, unsealClaudeReasoning(item.encrypted_content, { provider, model, credentials }));
    } else if (type === RESPONSES_ITEM.FUNCTION_CALL || type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      const id = nonempty(item.call_id, "call_id");
      const name = nonempty(item.name, "name");
      if (seenIds.has(id)) invalid(`Duplicate tool call_id: ${id}`);
      const custom = type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
      if (declared.has(name) && custom !== customNames.has(name)) invalid(`Tool call kind does not match declared tool: ${name}`);
      if (custom) customNames.add(name);
      if (pending.size && result.messages[result.messages.length - 1]?.role !== ROLE.ASSISTANT) requireResolved();
      if (custom && typeof item.input !== "string") invalid("custom_tool_call.input must be a string");
      const toolInput = custom ? { input: item.input } : jsonArguments(item.arguments);
      seenIds.add(id);
      pending.set(id, custom);
      append(ROLE.ASSISTANT, [{ type: CLAUDE_BLOCK.TOOL_USE, id, name, input: toolInput }]);
    } else if (type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT || type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) {
      const id = nonempty(item.call_id, "call_id");
      if (!pending.has(id)) invalid(`Tool result ${id} is missing its preceding tool call history`);
      if (pending.get(id) !== (type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT)) invalid(`Tool result kind does not match call ${id}`);
      const output = typeof item.output === "string" ? item.output : content(item.output, ROLE.USER, capabilities);
      pending.delete(id);
      append(ROLE.USER, [{ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: id, content: output }]);
    } else unsupported(`input.${type}`);
  }
  requireResolved();
  if (!result.messages.length) invalid("input must contain a user conversation, not only system instructions");
  if (result.messages[0].role !== ROLE.USER) invalid("Conversation history must begin with a user message");
  if (result.messages[result.messages.length - 1].role !== ROLE.USER) invalid("Claude Responses input must end with a user message or tool result; assistant prefilling is unsupported");
  if (system.length) result.system = system;
  if (customNames.size) result._customToolNames = [...customNames];
  return result;
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, responsesToClaudeRequest, null);
