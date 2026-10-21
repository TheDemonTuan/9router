import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, CLAUDE_STOP, RESPONSES_ITEM, ROLE } from "../schema/index.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { ClaudeCustomInputDecoder } from "../concerns/claudeCustomInput.js";
import { hasClaudeContinuationScope, sealClaudeReasoning } from "../concerns/claudeContinuation.js";
import { stripCloakSuffix } from "../../utils/claudeCloaking.js";
import { buildResponseSnapshot, normalizeResponseId } from "../../transformer/responsesBuilder.js";

function emitter(state, events) {
  return (type, data) => {
    state.seq = (state.seq || 0) + 1;
    events.push({ event: type, data: { type, ...data, sequence_number: state.seq } });
  };
}

function start(state, emit, message = {}) {
  if (state.claudeResponses) return;
  state.responseId = normalizeResponseId(message.id || state.responseId);
  state.created ??= Math.floor(Date.now() / 1000);
  state.model = message.model || state.model || null;
  state.outputItems = new Map();
  state.claudeResponses = { blocks: new Map(), callIds: new Set(), next: 0, usage: {}, stopReason: null, started: false };
  emit("response.created", { response: buildResponseSnapshot(state, { status: "in_progress", output: [], usage: null }) });
  emit("response.in_progress", { response: buildResponseSnapshot(state, { status: "in_progress", output: [], usage: null }) });
}

function usage(state, raw) {
  if (!raw || typeof raw !== "object") return;
  Object.assign(state.claudeResponses.usage, raw);
  state.usage = toOpenAIUsage(state.claudeResponses.usage, FORMATS.CLAUDE);
}

function context(state) {
  return { provider: state.provider, model: state.model, ...state.credentials?._responsesClaudeContext, credentials: state.credentials };
}

function itemFor(block, status) {
  if (block.kind === CLAUDE_BLOCK.TEXT) {
    return { id: block.id, type: RESPONSES_ITEM.MESSAGE, status, role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: block.text.join(""), annotations: [], logprobs: [] }] };
  }
  if (block.kind === CLAUDE_BLOCK.TOOL_USE) {
    return { id: block.id, type: block.custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      status, call_id: block.callId, name: block.name,
      ...(block.custom ? { input: block.input.join("") } : { arguments: block.json.join("") }) };
  }
  return { id: block.id, type: RESPONSES_ITEM.REASONING, status,
    summary: [],
    ...(block.kind === CLAUDE_BLOCK.THINKING ? { content: [{ type: RESPONSES_ITEM.REASONING_TEXT, text: block.text.join("") }] } : {}),
    ...(block.encrypted ? { encrypted_content: block.encrypted } : {}) };
}

function addText(block, emit, text) {
  if (!text) return;
  block.text.push(text);
  const reasoning = block.kind === CLAUDE_BLOCK.THINKING;
  emit(reasoning ? "response.reasoning_text.delta" : "response.output_text.delta", {
    item_id: block.id, output_index: block.index, content_index: 0,
    ...(!reasoning ? { logprobs: [] } : {}), delta: text,
  });
}

function addArguments(block, emit, fragment) {
  if (!fragment) return;
  block.json.push(fragment);
  const delta = block.custom ? block.decoder.push(fragment) : fragment;
  if (block.custom && delta) block.input.push(delta);
  if (delta) emit(block.custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", {
    item_id: block.id, output_index: block.index, delta,
  });
}

function beginBlock(state, emit, index, native) {
  const stream = state.claudeResponses;
  if (!Number.isInteger(index) || index < 0 || stream.blocks.has(index)) throw new Error("Duplicate or invalid Claude content block index");
  if (![CLAUDE_BLOCK.TEXT, CLAUDE_BLOCK.THINKING, CLAUDE_BLOCK.REDACTED_THINKING, CLAUDE_BLOCK.TOOL_USE].includes(native?.type)) {
    throw new Error(`Unsupported Claude content block: ${native?.type || "unknown"}`);
  }
  const outputIndex = stream.next++;
  const block = { kind: native.type, index: outputIndex, text: [], json: [], input: [], native: { ...native }, closed: false, done: false };
  if (native.type === CLAUDE_BLOCK.TOOL_USE) {
    if (typeof native.id !== "string" || !native.id || typeof native.name !== "string" || !native.name || stream.callIds.has(native.id)) {
      throw new Error("Duplicate or missing Claude tool call ID/name");
    }
    if (!native.input || typeof native.input !== "object" || Array.isArray(native.input)) throw new Error("Claude tool input must be a JSON object");
    stream.callIds.add(native.id);
    block.name = state.toolNameMap?.get(native.name) || stripCloakSuffix(native.name) || native.name;
    block.callId = native.id;
    block.custom = state.customToolNames?.has(block.name) || false;
    block.id = `${block.custom ? "ctc" : "fc"}_${state.responseId}_${outputIndex}`;
    if (block.custom) block.decoder = new ClaudeCustomInputDecoder();
    block.initialInput = native.input;
  } else block.id = `${native.type === CLAUDE_BLOCK.TEXT ? "msg" : "rs"}_${state.responseId}_${outputIndex}`;
  stream.blocks.set(index, block);
  const item = itemFor(block, "in_progress");
  if (block.kind === CLAUDE_BLOCK.TEXT) item.content = [];
  if (block.kind === CLAUDE_BLOCK.THINKING) item.content = [];
  state.outputItems.set(block.index, item);
  emit("response.output_item.added", { output_index: block.index, item });
  if (block.kind === CLAUDE_BLOCK.TEXT) {
    emit("response.content_part.added", { item_id: block.id, output_index: block.index, content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, text: "", annotations: [], logprobs: [] } });
    addText(block, emit, native.text || "");
  } else if (block.kind === CLAUDE_BLOCK.THINKING) {
    emit("response.content_part.added", { item_id: block.id, output_index: block.index, content_index: 0,
      part: { type: RESPONSES_ITEM.REASONING_TEXT, text: "" } });
    addText(block, emit, native.thinking || "");
  }
  return block;
}

function validateTool(block, emit) {
  // Claude streams an empty initial input object; use it only if no JSON deltas arrived.
  if (!block.json.length) addArguments(block, emit, JSON.stringify(block.initialInput));
  const raw = block.json.join("");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (block.custom && (!block.decoder.complete || typeof parsed.input !== "string" || Object.keys(parsed).length !== 1)) return false;
    return true;
  } catch { return false; }
}

function closeBlock(state, emit, block, status = "completed", preserveNative = true) {
  if (block.done) return;
  if (preserveNative && (block.kind === CLAUDE_BLOCK.THINKING || block.kind === CLAUDE_BLOCK.REDACTED_THINKING)) {
    const native = block.kind === CLAUDE_BLOCK.THINKING
      ? { ...block.native, thinking: block.text.join(""), signature: block.native.signature || "" }
      : block.native;
    const ctx = context(state);
    if ((block.kind === CLAUDE_BLOCK.REDACTED_THINKING || native.signature) && hasClaudeContinuationScope(ctx)) {
      block.encrypted = sealClaudeReasoning([native], ctx);
    }
  }
  block.done = true;
  const item = itemFor(block, status);
  if (block.kind === CLAUDE_BLOCK.TEXT) {
    emit("response.output_text.done", { item_id: block.id, output_index: block.index, content_index: 0, text: item.content[0].text, logprobs: [] });
    emit("response.content_part.done", { item_id: block.id, output_index: block.index, content_index: 0, part: item.content[0] });
  } else if (block.kind === CLAUDE_BLOCK.THINKING) {
    const reasoningText = block.text.join("");
    emit("response.reasoning_text.done", { item_id: block.id, output_index: block.index, content_index: 0, text: reasoningText });
    emit("response.reasoning_summary_text.done", { item_id: block.id, output_index: block.index, summary_index: 0, text: reasoningText });
    emit("response.content_part.done", { item_id: block.id, output_index: block.index, content_index: 0, part: item.content[0] });
  } else if (block.kind === CLAUDE_BLOCK.TOOL_USE && status === "completed") {
    emit(block.custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", {
      item_id: block.id, output_index: block.index,
      ...(block.custom ? { input: item.input } : { arguments: item.arguments }),
    });
  }
  state.outputItems.set(block.index, item);
  emit("response.output_item.done", { output_index: block.index, item });
}

function terminal(state, emit, status, details = {}) {
  if (state.claudeResponsesTerminal) return;
  state.claudeResponsesTerminal = true;
  state.claudeResponsesTerminalStatus = status;
  emit(`response.${status}`, { response: buildResponseSnapshot(state, { status, ...details }) });
}

function fail(state, emit, message, code) {
  start(state, emit);
  for (const block of state.claudeResponses.blocks.values()) {
    if (block.done) continue;
    // Even valid buffered tools cannot be executed after an interrupted stream.
    if (block.kind === CLAUDE_BLOCK.TOOL_USE && !block.json.length) {
      addArguments(block, emit, JSON.stringify(block.initialInput));
    }
    closeBlock(state, emit, block, "incomplete", false);
  }
  terminal(state, emit, "failed", { error: { type: "server_error", code, message } });
}

export function failClaudeResponses(state, message, code = "stream_disconnected") {
  if (state.claudeResponsesTerminal) return [];
  const events = [];
  const emit = emitter(state, events);
  try { fail(state, emit, message, code); }
  catch (error) { terminal(state, emit, "failed", { error: { type: "server_error", code: "continuation_error", message: error.message } }); }
  return events;
}

function addRefusal(state, emit) {
  const index = state.claudeResponses.next++;
  const id = `msg_${state.responseId}_${index}`;
  const refusal = state.claudeResponses.stopDetails?.explanation || "";
  const part = { type: RESPONSES_ITEM.REFUSAL, refusal };
  emit("response.output_item.added", { output_index: index, item: { id, type: RESPONSES_ITEM.MESSAGE, status: "in_progress", role: ROLE.ASSISTANT, content: [] } });
  emit("response.content_part.added", { item_id: id, output_index: index, content_index: 0, part: { ...part, refusal: "" } });
  if (refusal) emit("response.refusal.delta", { item_id: id, output_index: index, content_index: 0, delta: refusal });
  emit("response.refusal.done", { item_id: id, output_index: index, content_index: 0, refusal });
  emit("response.content_part.done", { item_id: id, output_index: index, content_index: 0, part });
  const item = { id, type: RESPONSES_ITEM.MESSAGE, status: "completed", role: ROLE.ASSISTANT, content: [part] };
  state.outputItems.set(index, item);
  emit("response.output_item.done", { output_index: index, item });
}

function finish(state, emit) {
  const stream = state.claudeResponses;
  const reason = stream.stopReason;
  const incompleteReason = reason === CLAUDE_STOP.MAX_TOKENS || reason === "model_context_window_exceeded" ? "max_output_tokens" : null;
  const accepted = [CLAUDE_STOP.END_TURN, CLAUDE_STOP.STOP_SEQUENCE, CLAUDE_STOP.TOOL_USE, CLAUDE_STOP.REFUSAL].includes(reason);
  if (!accepted && !incompleteReason) { fail(state, emit, `Claude stream ended with unsupported stop reason: ${reason || "missing"}`, "provider_error"); return; }
  let invalid = false;
  for (const block of stream.blocks.values()) {
    if (block.kind === CLAUDE_BLOCK.TOOL_USE) {
      block.valid = block.closed && validateTool(block, emit);
      if (!block.valid) invalid = true;
    } else if (!block.closed) invalid = true;
  }
  for (const block of stream.blocks.values()) {
    closeBlock(state, emit, block, block.closed && (block.kind !== CLAUDE_BLOCK.TOOL_USE || (block.valid && !incompleteReason && !invalid)) ? "completed" : "incomplete");
  }
  if (reason === CLAUDE_STOP.REFUSAL) addRefusal(state, emit);
  if (incompleteReason) terminal(state, emit, "incomplete", { incomplete_details: { reason: incompleteReason } });
  else if (invalid) terminal(state, emit, "failed", { error: { type: "server_error", code: "invalid_provider_response", message: "Claude returned an unclosed block or malformed tool input" } });
  else terminal(state, emit, "completed");
}

export function claudeToResponsesResponse(chunk, state) {
  if (state.claudeResponsesTerminal) return [];
  if (!chunk) return failClaudeResponses(state, "Claude stream closed before message_stop");
  const events = [];
  const emit = emitter(state, events);
  if (chunk.type === "ping") return events;
  try {
    if (chunk.type === "message_start") {
      if (state.claudeResponses?.started) throw new Error("Duplicate Claude message_start");
      start(state, emit, chunk.message);
      state.claudeResponses.started = true;
      usage(state, chunk.message?.usage);
      if (chunk.message?.stop_reason) state.claudeResponses.stopReason = chunk.message.stop_reason;
      for (const [index, block] of (chunk.message?.content || []).entries()) beginBlock(state, emit, index, block);
      return events;
    }
    start(state, emit);
    if (chunk.type === "error") {
      fail(state, emit, chunk.error?.message || "Claude upstream error", chunk.error?.type || "provider_error");
      return events;
    }
    if (!state.claudeResponses.started) throw new Error("Claude stream event arrived before message_start");
    switch (chunk.type) {
      case "content_block_start":
        beginBlock(state, emit, chunk.index, chunk.content_block);
        break;
      case "content_block_delta": {
        const block = state.claudeResponses.blocks.get(chunk.index);
        if (!block || block.closed) throw new Error("Claude delta references a missing or closed block");
        const delta = chunk.delta;
        if (delta?.type === "text_delta" && block.kind === CLAUDE_BLOCK.TEXT) addText(block, emit, delta.text);
        else if (delta?.type === "thinking_delta" && block.kind === CLAUDE_BLOCK.THINKING) addText(block, emit, delta.thinking);
        else if (delta?.type === "signature_delta" && block.kind === CLAUDE_BLOCK.THINKING) block.native.signature = (block.native.signature || "") + (delta.signature || "");
        else if (delta?.type === "input_json_delta" && block.kind === CLAUDE_BLOCK.TOOL_USE) addArguments(block, emit, delta.partial_json);
        else throw new Error(`Unsupported Claude block delta: ${delta?.type || "unknown"}`);
        break;
      }
      case "content_block_stop": {
        const block = state.claudeResponses.blocks.get(chunk.index);
        if (!block || block.closed) throw new Error("Duplicate or missing Claude block stop");
        block.closed = true;
        // Tool completion is deferred until message_stop proves the stream ended cleanly.
        if (block.kind !== CLAUDE_BLOCK.TOOL_USE) closeBlock(state, emit, block);
        break;
      }
      case "message_delta":
        usage(state, chunk.usage);
        if (chunk.delta?.stop_reason) state.claudeResponses.stopReason = chunk.delta.stop_reason;
        if (chunk.delta?.stop_details) state.claudeResponses.stopDetails = chunk.delta.stop_details;
        break;
      case "message_stop":
        finish(state, emit);
        break;
      default:
        throw new Error(`Unsupported Claude stream event: ${chunk.type || "unknown"}`);
    }
  } catch (error) {
    fail(state, emit, error.message, "invalid_provider_response");
  }
  return events;
}

export function convertClaudeResponseToResponses(json, options = {}) {
  const state = { ...options, customToolNames: options.customToolNames instanceof Set ? options.customToolNames : new Set(options.customToolNames || []) };
  const events = [];
  if (json?.type === "error" || json?.error) {
    events.push(...claudeToResponsesResponse({ type: "error", error: json.error || json }, state));
  } else if (!json || !Array.isArray(json.content)) {
    events.push(...failClaudeResponses(state, "Claude response has no content array", "invalid_provider_response"));
  } else {
    events.push(...claudeToResponsesResponse({ type: "message_start", message: { ...json, content: [] } }, state));
    json.content.forEach((block, index) => {
      events.push(...claudeToResponsesResponse({ type: "content_block_start", index, content_block: block }, state));
      events.push(...claudeToResponsesResponse({ type: "content_block_stop", index }, state));
    });
    events.push(...claudeToResponsesResponse({ type: "message_delta", delta: { stop_reason: json.stop_reason, stop_details: json.stop_details }, usage: json.usage }, state));
    events.push(...claudeToResponsesResponse({ type: "message_stop" }, state));
  }
  return events.at(-1)?.data?.response || buildResponseSnapshot(state, { status: "failed" });
}

register(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, null, claudeToResponsesResponse);
