import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import type { CodexParsedRequest, CodexTool } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptWebAdapterError } from "./adapter-error";

export interface BrowserClientToolOutput {
  content: string | null;
  calls: BrokerToolRequest[];
}
export interface BrowserClientToolProtocol {
  tools: CodexTool[];
  toolChoice: "auto" | "none" | "required" | { name: string };
  parallelToolCalls: boolean;
  parse(answer: string): BrowserClientToolOutput;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never {
  throw new ChatGptWebAdapterError("Browser client function decision failed validation", {
    status: 502, errorType: "server_error", code: "browser_tool_output_invalid", retryable: false,
  });
}

export function createBrowserClientToolProtocol(parsed: CodexParsedRequest): BrowserClientToolProtocol | undefined {
  const tools = parsed.context.tools || [];
  const history = parsed.context.messages.some(message => message.role === "toolResult"
    || message.role === "assistant" && message.content.some(part => part.type === "toolCall"));
  if (!tools.length && !history) return undefined;
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: true });
    addFormats(ajv);
    try {
      const validate = ajv.compile(tool.parameters);
      if ("$async" in validate && validate.$async === true) throw new Error("Async schema is not supported");
      validators.set(tool.name, validate);
    }
    catch {
      throw new ChatGptWebAdapterError("Client function schema cannot be compiled", {
        status: 400, errorType: "invalid_request_error", code: "invalid_tool_schema", retryable: false,
      });
    }
  }
  const choice = parsed.options.toolChoice ?? (tools.length ? "auto" : "none");
  if (typeof choice === "object" && !("name" in choice)) invalid();
  const toolChoice = choice as BrowserClientToolProtocol["toolChoice"];
  const parallelToolCalls = parsed.options.parallelToolCalls ?? true;
  return {
    tools, toolChoice, parallelToolCalls,
    parse(answer) {
      let text = answer.trim();
      const fence = /^```json\s*\n([\s\S]*?)\n```$/.exec(text);
      if (fence) text = fence[1];
      let value: unknown;
      try { value = JSON.parse(text); } catch { invalid(); }
      if (!record(value) || Object.keys(value).length !== 2 || !("content" in value) || !("tool_calls" in value)
        || !Array.isArray(value.tool_calls) || value.content !== null && typeof value.content !== "string") invalid();
      if (!value.tool_calls.length && typeof value.content !== "string") invalid();
      if (toolChoice === "none" && value.tool_calls.length || toolChoice === "required" && !value.tool_calls.length
        || typeof toolChoice === "object" && !value.tool_calls.length || !parallelToolCalls && value.tool_calls.length > 1) invalid();
      const decisions = value.tool_calls.map(entry => {
        if (!record(entry) || Object.keys(entry).length !== 2 || typeof entry.name !== "string" || !record(entry.arguments)) invalid();
        const validate = validators.get(entry.name);
        if (!validate || !validate(entry.arguments) || typeof toolChoice === "object" && entry.name !== toolChoice.name) invalid();
        return { wireName: entry.name, freeform: false, arguments: entry.arguments };
      });
      return { content: value.content as string | null, calls: decisions.map(decision => ({ ...decision, callId: `call_${randomUUID().replaceAll("-", "")}` })) };
    },
  };
}
