// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";
import { buildResponseSnapshot } from "../transformer/responsesBuilder.js";

// Responses API events that signal the stream has reached a terminal state.
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return eventName || null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed" || status === "incomplete";
}

// Parse one complete SSE record. The JSON type is authoritative because Codex
// also emits data-only Responses frames.
export function parseOpenAIResponsesSSERecord(record) {
  const lines = String(record || "").replace(/\r/g, "").split("\n");
  let eventName = null;
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  const data = dataLines.join("\n");
  if (!data) return null;
  if (data === "[DONE]") return { done: true, eventName, type: eventName || null, data: null };
  try {
    const parsed = JSON.parse(data);
    return { done: false, eventName, type: getOpenAIResponsesEventName(eventName, parsed), data: parsed };
  } catch {
    return { done: false, eventName, type: eventName || null, data: null, malformed: true };
  }
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams.
export function buildAbortedResponsesTerminalBytes({ model = null, message = "stream closed before response.completed" } = {}) {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure({ model, message })}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event.
// Accept the former model string signature for external callers.
export function formatIncompleteOpenAIResponsesStreamFailure(options = {}) {
  const { model = null, message = "stream closed before response.completed" } = typeof options === "string"
    ? { model: options }
    : options;
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: buildResponseSnapshot({
        responseId: `resp_${Date.now()}`,
        status: "failed",
        model,
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message
        },
        output: []
      })
    }
  }, FORMATS.OPENAI_RESPONSES);
}
