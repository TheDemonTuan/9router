/** Converts a Responses SSE stream to one canonical Responses JSON response. */
import { ResponsesAccumulator } from "./responsesAccumulator.js";

export async function convertResponsesStreamToJson(stream, { model = null } = {}) {
  const accumulator = new ResponsesAccumulator({ model });
  if (!stream || typeof stream.getReader !== "function") {
    return accumulator.snapshot();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split(/\r?\n\r?\n|\r\r/);
      buffer = records.pop() || "";
      for (const record of records) accumulator.observeRecord(record);
    }
    buffer += decoder.decode();
    if (buffer.trim()) accumulator.observeRecord(buffer);
  } finally {
    reader.releaseLock();
  }
  return accumulator.snapshot();
}
