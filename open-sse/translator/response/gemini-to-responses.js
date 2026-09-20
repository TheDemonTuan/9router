import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_IMAGE_MIME, RESPONSES_ITEM, ROLE } from "../schema/index.js";
import { encodeDataUri } from "../concerns/image.js";
import {
  buildOutputArray,
  buildResponseSnapshot,
  normalizeResponseId,
  normalizeResponsesUsage,
} from "../../transformer/responsesBuilder.js";

function emitFactory(state, events) {
  state.seq ??= 0;
  return (type, data) => {
    data.sequence_number = ++state.seq;
    events.push({ event: type, data: { type, ...data } });
  };
}

function ensureStarted(state, emit, response) {
  if (state.geminiResponsesStarted) return;
  state.geminiResponsesStarted = true;
  state.responseId = normalizeResponseId(response.responseId || response.id || state.responseId);
  state.created ??= Math.floor(Date.now() / 1000);
  state.model = response.modelVersion || response.model || state.model || "gemini";
  state.outputItems ??= new Map();
  state.geminiNextOutputIndex ??= 0;
  emit("response.created", { response: buildResponseSnapshot(state, { status: "in_progress", output: [], usage: null }) });
  emit("response.in_progress", { response: buildResponseSnapshot(state, { status: "in_progress", output: [], usage: null }) });
}

function startReasoning(state, emit) {
  if (state.geminiReasoning?.done) return;
  if (state.geminiReasoning) return;
  const index = state.geminiNextOutputIndex++;
  const id = `rs_${state.responseId}_${index}`;
  state.geminiReasoning = { id, index, text: "", done: false };
  emit("response.output_item.added", {
    output_index: index,
    item: { id, type: RESPONSES_ITEM.REASONING, status: "in_progress", summary: [] },
  });
  emit("response.reasoning_summary_part.added", {
    item_id: id, output_index: index, summary_index: 0,
    part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" },
  });
}

function closeReasoning(state, emit) {
  const reasoning = state.geminiReasoning;
  if (!reasoning || reasoning.done) return;
  reasoning.done = true;
  emit("response.reasoning_summary_text.done", {
    item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, text: reasoning.text,
  });
  emit("response.reasoning_summary_part.done", {
    item_id: reasoning.id, output_index: reasoning.index, summary_index: 0,
    part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning.text },
  });
  const item = {
    id: reasoning.id, type: RESPONSES_ITEM.REASONING, status: "completed",
    summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning.text }],
  };
  state.outputItems.set(reasoning.index, item);
  emit("response.output_item.done", { output_index: reasoning.index, item });
}

function startMessage(state, emit) {
  if (state.geminiMessage) return state.geminiMessage;
  const index = state.geminiNextOutputIndex++;
  const id = `msg_${state.responseId}_${index}`;
  const message = { id, index, parts: [], done: false };
  state.geminiMessage = message;
  emit("response.output_item.added", {
    output_index: index,
    item: { id, type: RESPONSES_ITEM.MESSAGE, status: "in_progress", role: ROLE.ASSISTANT, content: [] },
  });
  return message;
}

function emitText(state, emit, text) {
  const message = startMessage(state, emit);
  let part = message.parts.at(-1);
  if (!part || part.type !== RESPONSES_ITEM.OUTPUT_TEXT) {
    part = { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" };
    part.index = message.parts.length;
    message.parts.push(part);
    emit("response.content_part.added", {
      item_id: message.id, output_index: message.index, content_index: part.index,
      part: { ...part },
    });
  }
  part.text += text;
  emit("response.output_text.delta", {
    item_id: message.id, output_index: message.index, content_index: part.index, delta: text, logprobs: [],
  });
}

function emitImage(state, emit, inlineData) {
  const message = startMessage(state, emit);
  const part = {
    type: "output_image",
    image_url: encodeDataUri(inlineData.mimeType || inlineData.mime_type || DEFAULT_IMAGE_MIME, inlineData.data),
    index: message.parts.length,
  };
  message.parts.push(part);
  emit("response.content_part.added", {
    item_id: message.id, output_index: message.index, content_index: part.index, part: { type: part.type, image_url: part.image_url },
  });
  emit("response.content_part.done", {
    item_id: message.id, output_index: message.index, content_index: part.index, part: { type: part.type, image_url: part.image_url },
  });
}

function closeMessage(state, emit) {
  const message = state.geminiMessage;
  if (!message || message.done) return;
  message.done = true;
  const content = message.parts.map(({ index, ...part }) => part);
  for (const part of message.parts) {
    if (part.type !== RESPONSES_ITEM.OUTPUT_TEXT) continue;
    emit("response.output_text.done", {
      item_id: message.id, output_index: message.index, content_index: part.index, text: part.text, logprobs: [],
    });
    emit("response.content_part.done", {
      item_id: message.id, output_index: message.index, content_index: part.index,
      part: { type: part.type, annotations: [], logprobs: [], text: part.text },
    });
  }
  const item = { id: message.id, type: RESPONSES_ITEM.MESSAGE, status: "completed", role: ROLE.ASSISTANT, content };
  state.outputItems.set(message.index, item);
  emit("response.output_item.done", { output_index: message.index, item });
}

function emitFunctionCall(state, emit, call) {
  if (!call?.name) return;
  const callId = call.id || `call_${state.responseId}_${state.geminiFunctionCalls?.size || 0}`;
  state.geminiFunctionCalls ??= new Map();
  if (state.geminiFunctionCalls.has(callId)) return;
  const index = state.geminiNextOutputIndex++;
  const argumentsText = JSON.stringify(call.args || {});
  const item = {
    id: `fc_${callId}`, type: RESPONSES_ITEM.FUNCTION_CALL, status: "in_progress",
    call_id: callId, name: call.name, arguments: "",
  };
  state.geminiFunctionCalls.set(callId, { ...item, index, argumentsText, done: false });
  emit("response.output_item.added", { output_index: index, item });
  if (argumentsText) emit("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: argumentsText });
}

function closeFunctionCalls(state, emit) {
  for (const call of state.geminiFunctionCalls?.values() || []) {
    if (call.done) continue;
    call.done = true;
    emit("response.function_call_arguments.done", { item_id: call.id, output_index: call.index, arguments: call.argumentsText });
    const item = { ...call, status: "completed", arguments: call.argumentsText };
    delete item.index;
    delete item.argumentsText;
    delete item.done;
    state.outputItems.set(call.index, item);
    emit("response.output_item.done", { output_index: call.index, item });
  }
}

function complete(state, emit) {
  if (state.geminiCompleted) return;
  state.geminiCompleted = true;
  emit("response.completed", {
    response: buildResponseSnapshot(state, {
      status: "completed", output: buildOutputArray(state.outputItems), usage: state.usage || null,
    }),
  });
}

export function geminiToResponsesResponse(chunk, state) {
  const events = [];
  if (!chunk) {
    if (!state.geminiResponsesStarted) return events;
    const emit = emitFactory(state, events);
    closeMessage(state, emit);
    closeReasoning(state, emit);
    closeFunctionCalls(state, emit);
    complete(state, emit);
    return events;
  }
  const response = chunk.response || chunk;
  const candidate = response?.candidates?.[0];
  if (!candidate) return events;
  const emit = emitFactory(state, events);
  ensureStarted(state, emit, response);
  const usage = response.usageMetadata || chunk.usageMetadata;
  if (usage) {
    state.usage = normalizeResponsesUsage({
      input_tokens: usage.promptTokenCount,
      output_tokens: usage.candidatesTokenCount,
      total_tokens: usage.totalTokenCount,
      input_tokens_details: { cached_tokens: usage.cachedContentTokenCount || 0 },
      output_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount || 0 },
    });
  }
  for (const part of candidate.content?.parts || []) {
    if (part.thought === true && part.text) {
      startReasoning(state, emit);
      state.geminiReasoning.text += part.text;
      emit("response.reasoning_summary_text.delta", {
        item_id: state.geminiReasoning.id, output_index: state.geminiReasoning.index, summary_index: 0, delta: part.text,
      });
      continue;
    }
    closeReasoning(state, emit);
    if (part.text) emitText(state, emit, part.text);
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) emitImage(state, emit, inlineData);
    if (part.functionCall) {
      closeMessage(state, emit);
      emitFunctionCall(state, emit, part.functionCall);
    }
  }
  if (candidate.finishReason) {
    closeMessage(state, emit);
    closeReasoning(state, emit);
    closeFunctionCalls(state, emit);
    complete(state, emit);
  }
  return events;
}

register(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, null, geminiToResponsesResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI_RESPONSES, null, geminiToResponsesResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI_RESPONSES, null, geminiToResponsesResponse);
