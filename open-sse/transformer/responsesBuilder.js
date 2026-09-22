import { ROLE, RESPONSES_ITEM } from "../translator/schema/index.js";

/**
 * Normalizes OpenAI/provider response ID into standard resp_* prefix.
 */
export function normalizeResponseId(id) {
  if (!id) return `resp_${Date.now()}`;
  if (typeof id !== "string") return `resp_${id}`;
  if (id.startsWith("resp_")) return id;
  if (id.startsWith("chatcmpl-")) return id.replace(/^chatcmpl-/, "resp_");
  return `resp_${id}`;
}

/**
 * Normalizes usage payload to OpenAI Responses API schema.
 */
export function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = [usage.input_tokens, usage.prompt_tokens].find(Number.isFinite) ?? 0;
  const outputTokens = [usage.output_tokens, usage.completion_tokens].find(Number.isFinite) ?? 0;
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : (inputTokens + outputTokens);

  const responseUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };

  const cachedTokens = [usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens].find(Number.isFinite);
  const reasoningTokens = [usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens].find(Number.isFinite);
  if (Number.isFinite(cachedTokens)) responseUsage.input_tokens_details = { cached_tokens: cachedTokens };
  if (Number.isFinite(reasoningTokens)) responseUsage.output_tokens_details = { reasoning_tokens: reasoningTokens };

  return responseUsage;
}

/**
 * Builds array of output items from a Map, preserving index order.
 */
export function buildOutputArray(items) {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (items instanceof Map) {
    if (items.size === 0) return [];
    const maxIndex = Math.max(...items.keys());
    const result = [];
    for (let i = 0; i <= maxIndex; i++) {
      const item = items.get(i);
      if (item) result.push(item);
    }
    return result;
  }
  return [];
}

/**
 * Extracts raw program/input from JSON-encoded custom tool call arguments.
 */
export function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

/**
 * Canonical Responses API Response object builder.
 * Guarantees spec-compliant fields across stream, non-stream, and terminal error paths.
 *
 * ponytail: static fields default to standard Responses API values; upgrade if provider exposes granular metadata.
 */
export function buildResponseSnapshot(state = {}, overrides = {}) {
  const id = overrides.id ?? state.responseId ?? state.id ?? `resp_${Date.now()}`;
  const created_at = overrides.created_at ?? state.created ?? state.created_at ?? Math.floor(Date.now() / 1000);
  const status = overrides.status ?? state.status ?? "in_progress";
  const model = overrides.model ?? state.model ?? null;
  const error = overrides.error ?? state.error ?? null;
  const incomplete_details = overrides.incomplete_details ?? state.incomplete_details ?? null;

  let output;
  if (overrides.output !== undefined) {
    output = overrides.output;
  } else if (state.outputItems) {
    output = buildOutputArray(state.outputItems);
  } else if (Array.isArray(state.output)) {
    output = state.output;
  } else {
    output = [];
  }

  const instructions = overrides.instructions !== undefined ? overrides.instructions : (state.instructions ?? null);
  const parallel_tool_calls = overrides.parallel_tool_calls !== undefined
    ? overrides.parallel_tool_calls
    : (state.parallelToolCalls ?? state.parallel_tool_calls ?? true);
  const previous_response_id = overrides.previous_response_id !== undefined
    ? overrides.previous_response_id
    : (state.previousResponseId ?? state.previous_response_id ?? null);
  const reasoning = overrides.reasoning !== undefined
    ? overrides.reasoning
    : (state.reasoning ?? { effort: null, summary: null });
  const store = overrides.store !== undefined ? overrides.store : (state.store ?? false);
  const text = overrides.text !== undefined ? overrides.text : (state.text ?? { format: { type: "text" } });
  const tool_choice = overrides.tool_choice !== undefined
    ? overrides.tool_choice
    : (state.toolChoice ?? state.tool_choice ?? "auto");
  const tools = overrides.tools !== undefined ? overrides.tools : (state.tools ?? []);
  const truncation = overrides.truncation !== undefined
    ? overrides.truncation
    : (state.truncation ?? "disabled");
  const metadata = overrides.metadata !== undefined ? overrides.metadata : (state.metadata ?? {});

  let usage = null;
  if (overrides.usage !== undefined) {
    usage = overrides.usage ? normalizeResponsesUsage(overrides.usage) : null;
  } else if (state.usage) {
    usage = normalizeResponsesUsage(state.usage);
  }

  return {
    id,
    object: "response",
    created_at,
    status,
    error,
    incomplete_details,
    model,
    output,
    instructions,
    parallel_tool_calls,
    previous_response_id,
    reasoning,
    store,
    text,
    tool_choice,
    tools,
    truncation,
    metadata,
    usage,
    ...overrides
  };
}

/**
 * Converts OpenAI Chat Completion JSON response into canonical Responses API shape.
 */
export function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      status: "completed",
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      status: "completed",
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      status: "completed",
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const finishReason = choice.finish_reason;
  const status = (finishReason === "tool_calls" || finishReason === "stop" || !finishReason) ? "completed" : finishReason;

  return buildResponseSnapshot({
    responseId: normalizeResponseId(responseBody.id),
    created: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    usage: responseBody.usage,
    output,
  });
}
