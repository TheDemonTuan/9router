/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

import {
  buildResponseSnapshot,
  buildOutputArray,
  normalizeResponsesUsage
} from "./responsesBuilder.js";

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  const r = parsed.response;
  if (r && typeof r === "object") {
    if (r.id) state.responseId = r.id;
    if (r.created_at) state.created = r.created_at;
    if (r.model) state.model = r.model;
    if (r.instructions !== undefined) state.instructions = r.instructions;
    if (r.parallel_tool_calls !== undefined) state.parallelToolCalls = r.parallel_tool_calls;
    if (r.previous_response_id !== undefined) state.previousResponseId = r.previous_response_id;
    if (r.reasoning !== undefined) state.reasoning = r.reasoning;
    if (r.store !== undefined) state.store = r.store;
    if (r.text !== undefined) state.text = r.text;
    if (r.tool_choice !== undefined) state.toolChoice = r.tool_choice;
    if (r.tools !== undefined) state.tools = r.tools;
    if (r.truncation !== undefined) state.truncation = r.truncation;
    if (r.metadata !== undefined) state.metadata = r.metadata;
    if (r.error !== undefined) state.error = r.error;
    if (r.status) state.status = r.status;
    if (r.usage) state.usage = normalizeResponsesUsage(r.usage);
    if (Array.isArray(r.output) && r.output.length > 0) {
      r.output.forEach((item, idx) => {
        state.items.set(idx, item);
      });
    }
  }

  if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? state.items.size, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return buildResponseSnapshot({
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      status: "failed",
      error: { type: "stream_error", message: "Invalid or empty stream" },
      output: [],
      usage: null
    });
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model: null,
    usage: null,
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  return buildResponseSnapshot(state, {
    output: buildOutputArray(state.items),
    status: state.status === "in_progress" ? "completed" : (state.status || "completed"),
    usage: state.usage
  });
}
