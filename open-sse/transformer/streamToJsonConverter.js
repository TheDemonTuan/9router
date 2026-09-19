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
import { parseOpenAIResponsesSSERecord } from "../utils/responsesStreamHelpers.js";

function updateResponseState(response, state, authoritativeOutput = false) {
  if (!response || typeof response !== "object") return;
  if (response.id) state.responseId = response.id;
  if (response.created_at) state.created = response.created_at;
  if (response.model) state.model = response.model;
  for (const [source, target] of [["instructions", "instructions"], ["parallel_tool_calls", "parallelToolCalls"], ["previous_response_id", "previousResponseId"], ["reasoning", "reasoning"], ["store", "store"], ["text", "text"], ["tool_choice", "toolChoice"], ["tools", "tools"], ["truncation", "truncation"], ["metadata", "metadata"], ["error", "error"], ["incomplete_details", "incomplete_details"]]) {
    if (response[source] !== undefined) state[target] = response[source];
  }
  if (response.status) state.status = response.status;
  if (response.usage) state.usage = normalizeResponsesUsage(response.usage);
  // A terminal output, including [], is authoritative.
  if (authoritativeOutput && Array.isArray(response.output)) {
    state.items.clear();
    response.output.forEach((item, idx) => state.items.set(idx, item));
    state.authoritativeOutput = true;
  }
}

function processSSEMessage(msg, state) {
  const record = parseOpenAIResponsesSSERecord(msg);
  if (!record || record.done || record.malformed || !record.data) return;
  const { type: eventType, data: parsed } = record;
  const terminal = eventType === "response.completed" || eventType === "response.done" || eventType === "response.failed" || eventType === "response.incomplete";
  updateResponseState(parsed.response, state, terminal);

  if (eventType === "response.output_item.done" && !state.authoritativeOutput && parsed.item) {
    state.items.set(parsed.output_index ?? state.items.size, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = parsed.response?.status || "completed";
  } else if (eventType === "response.failed") {
    state.status = "failed";
  } else if (eventType === "response.incomplete") {
    state.status = "incomplete";
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
    items: new Map(),
    authoritativeOutput: false
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n|\r\r/);
      buffer = messages.pop() || "";

      for (const msg of messages) processSSEMessage(msg, state);
    }

    // Flush UTF-8 decoder and remaining frame (last event may lack delimiter).
    buffer += decoder.decode();
    if (buffer.trim()) processSSEMessage(buffer, state);
  } finally {
    reader.releaseLock();
  }

  const disconnected = state.status === "in_progress";
  return buildResponseSnapshot(state, {
    output: buildOutputArray(state.items),
    status: disconnected ? "failed" : state.status,
    error: disconnected ? {
      type: "stream_error",
      code: "stream_disconnected",
      message: "stream closed before response.completed"
    } : state.error,
    usage: state.usage
  });
}
