import { buildOutputArray, buildResponseSnapshot, normalizeResponsesUsage } from "./responsesBuilder.js";
import { isOpenAIResponsesTerminalEvent, parseOpenAIResponsesSSERecord } from "../utils/responsesStreamHelpers.js";

function outputIndex(event, fallback) {
  return Number.isInteger(event?.output_index) ? event.output_index : fallback;
}

function outputTextItem(index, text) {
  return {
    id: `msg_${index}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCallItem(index, call) {
  return {
    id: call.itemId || `fc_${call.callId || index}`,
    type: "function_call",
    status: "completed",
    call_id: call.callId || "",
    name: call.name || "",
    arguments: call.arguments || "",
  };
}

function completeRecoveredItem(item) {
  if (item?.type === "message") {
    return {
      ...item,
      status: "completed",
      role: item.role || "assistant",
      content: (Array.isArray(item.content) ? item.content : []).map(part => part?.type === "output_text"
        ? { ...part, annotations: Array.isArray(part.annotations) ? part.annotations : [] }
        : part),
    };
  }
  if (item?.type === "function_call") {
    return { ...item, status: "completed", call_id: item.call_id || "", name: item.name || "", arguments: item.arguments || "" };
  }
  return item;
}

/** Accumulates Responses events for terminal recovery without consuming unknown events. */
export class ResponsesAccumulator {
  constructor({ model = null } = {}) {
    this.state = {
      responseId: "",
      created: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
      usage: null,
      items: new Map(),
      text: new Map(),
      calls: new Map(),
      terminalOutput: null,
      terminalOutputBefore: 0,
      events: 0,
      doneItems: 0,
      reasoningIndexes: new Set(),
      terminal: false,
    };
  }

  updateResponse(response) {
    if (!response || typeof response !== "object") return;
    if (response.id) this.state.responseId = response.id;
    if (response.created_at) this.state.created = response.created_at;
    if (response.model) this.state.model = response.model;
    if (response.status) this.state.status = response.status;
    if (response.usage) this.state.usage = normalizeResponsesUsage(response.usage);
  }

  observeRecord(record) {
    const parsed = parseOpenAIResponsesSSERecord(record);
    if (!parsed?.data) return parsed;
    this.observe(parsed.type, parsed.data);
    return parsed;
  }

  observe(type, event) {
    this.state.events++;
    this.updateResponse(event?.response);
    if (isOpenAIResponsesTerminalEvent(type, event) && Array.isArray(event?.response?.output)) {
      this.state.terminalOutput = event.response.output;
      this.state.terminalOutputBefore = event.response.output.length;
    }
    const index = outputIndex(event, this.state.items.size);
    if (type === "response.output_item.added" && event.item) {
      this.state.items.set(index, event.item);
      if (event.item.type === "reasoning") this.state.reasoningIndexes.add(index);
      if (event.item.type === "function_call") {
        this.state.calls.set(index, {
          itemId: event.item.id,
          callId: event.item.call_id,
          name: event.item.name,
          arguments: event.item.arguments || "",
        });
      }
    }
    if (type === "response.output_item.done" && event.item) {
      this.state.items.set(index, event.item);
      this.state.doneItems++;
      if (event.item.type === "reasoning") this.state.reasoningIndexes.add(index);
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      this.state.text.set(index, (this.state.text.get(index) || "") + event.delta);
    }
    if (type === "response.output_text.done" && typeof event.text === "string") this.state.text.set(index, event.text);
    if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const call = this.state.calls.get(index) || {};
      call.itemId ||= event.item_id;
      call.arguments = (call.arguments || "") + event.delta;
      this.state.calls.set(index, call);
    }
    if (type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
      const call = this.state.calls.get(index) || {};
      call.itemId ||= event.item_id;
      call.arguments = event.arguments;
      this.state.calls.set(index, call);
    }
    if (isOpenAIResponsesTerminalEvent(type, event)) {
      const status = event.response?.status;
      this.state.terminal = type === "response.completed" || type === "response.done" || type === "response.failed" || type === "response.incomplete" || type === "error" || status === "completed" || status === "failed" || status === "incomplete";
      if (type === "response.completed" || type === "response.done" || status === "completed") this.state.status = "completed";
      else if (type === "response.failed" || type === "error" || status === "failed") this.state.status = "failed";
      else if (type === "response.incomplete" || status === "incomplete") this.state.status = "incomplete";
    }
  }

  recoveredOutput({ enrich = false } = {}) {
    if (Array.isArray(this.state.terminalOutput) && this.state.terminalOutput.length > 0) return this.state.terminalOutput;
    const items = new Map(this.state.items);
    for (const [index, text] of this.state.text) {
      if (!text) continue;
      const item = items.get(index);
      if (item?.type === "message") {
        const content = Array.isArray(item.content) ? [...item.content] : [];
        const textPart = content.find(part => part?.type === "output_text");
        if (textPart) textPart.text = text;
        else content.push({ type: "output_text", text, annotations: [] });
        items.set(index, { ...item, status: "completed", role: item.role || "assistant", content });
      } else if (!item) items.set(index, outputTextItem(index, text));
    }
    for (const [index, call] of this.state.calls) {
      const item = items.get(index);
      if (item?.type === "function_call") {
        items.set(index, { ...item, status: "completed", call_id: item.call_id || call.callId || "", name: item.name || call.name || "", arguments: call.arguments || item.arguments || "" });
      } else if (!item && (call.name || call.callId || call.arguments)) items.set(index, functionCallItem(index, call));
    }
    const output = buildOutputArray(items);
    return enrich ? output.map(completeRecoveredItem) : output;
  }

  diagnostics() {
    const output = this.recoveredOutput({ enrich: true });
    const textChars = output.reduce((total, item) => total + (item?.type === "message"
      ? (item.content || []).reduce((sum, part) => sum + (part?.type === "output_text" && typeof part.text === "string" ? part.text.length : 0), 0)
      : 0), 0);
    return {
      events: this.state.events,
      doneItems: this.state.doneItems,
      textChars,
      toolCalls: output.filter(item => item?.type === "function_call").length,
      reasoningItems: this.state.reasoningIndexes.size,
      terminalOutputBefore: this.state.terminalOutputBefore,
      terminalOutputAfter: output.length,
      status: this.state.status,
    };
  }

  enrichTerminal(event) {
    if (!event?.response || !["response.completed", "response.done"].includes(event.type)) return event;
    const output = event.response.output;
    if (Array.isArray(output) && output.length > 0) return event;
    const recovered = this.recoveredOutput({ enrich: true });
    if (recovered.length === 0) return event;
    return { ...event, response: buildResponseSnapshot({ ...this.state, responseId: event.response.id || this.state.responseId }, { ...event.response, status: event.response.status || "completed", output: recovered }) };
  }

  snapshot() {
    const disconnected = !this.state.terminal;
    return buildResponseSnapshot(this.state, {
      status: disconnected ? "failed" : this.state.status,
      output: this.recoveredOutput({ enrich: true }),
      error: disconnected ? { type: "stream_error", code: "stream_disconnected", message: "stream closed before response.completed" } : null,
      usage: this.state.usage,
    });
  }
}
