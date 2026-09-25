// open-sse/rtk/headroom.js
// Headroom 0.38.0 Gateway Facade and in-place body compressor.
// Uses native gateway contract for OpenAI, OpenAI Responses, and Claude formats.
// Preserves Kiro text projection in-place.
// Decoupled from OpenAI translation bridge; fail-open on service faults.

import { callHeadroomGateway } from "./headroomGateway.js";
import { HEADROOM_DEFAULT_TIMEOUT_MS } from "../config/runtimeConfig.js";

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function messagePayload(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  const kiro = collectKiroHeadroomMessages(body);
  if (kiro) return kiro.messages;
  return null;
}

export function captureSizeSnapshot(body) {
  const messages = messagePayload(body);
  const toolHistory = messages?.filter((message) =>
    message?.role === "tool"
    || message?.role === "function"
    || message?.tool_calls?.length
    || message?.type === "function_call"
    || message?.type === "function_call_output"
    || message?.content?.some?.((part) => part?.type === "tool_use" || part?.type === "tool_result")
  ) || [];
  return {
    bodyBytes: jsonBytes(body),
    messageCount: Array.isArray(messages) ? messages.length : 0,
    messageBytes: messages ? jsonBytes(messages) : 0,
    toolSchemaBytes: jsonBytes(body?.tools || []),
    toolHistoryBytes: jsonBytes(toolHistory),
  };
}

function setDiagnostic(diagnostics, reason) {
  if (diagnostics && !diagnostics.reason) diagnostics.reason = reason;
}

export function collectKiroHeadroomMessages(body) {
  const state = body?.conversationState;
  if (!state || typeof state !== "object") return null;

  const messages = [];
  const targets = [];

  const addTextTarget = (role, text, target, extra = {}) => {
    if (typeof text !== "string") return;
    messages.push({ role, content: text, ...extra });
    targets.push(target);
  };

  const toToolCalls = (toolUses) => {
    if (!Array.isArray(toolUses) || toolUses.length === 0) return undefined;
    const calls = toolUses.map((toolUse) => ({
      id: toolUse?.toolUseId,
      type: "function",
      function: {
        name: toolUse?.name || "",
        arguments: JSON.stringify(toolUse?.input || {}),
      },
    })).filter((call) => call.id || call.function.name);
    return calls.length > 0 ? calls : undefined;
  };

  const visit = (item) => {
    const user = item?.userInputMessage;
    if (user) {
      addTextTarget("system", user.systemInstruction, { object: user, key: "systemInstruction" });
      addTextTarget("user", user.content, { object: user, key: "content" });

      const toolResults = user.userInputMessageContext?.toolResults;
      if (Array.isArray(toolResults)) {
        for (const toolResult of toolResults) {
          const content = toolResult?.content;
          if (!Array.isArray(content)) continue;
          for (const part of content) {
            addTextTarget(
              "tool",
              part?.text,
              { object: part, key: "text" },
              toolResult?.toolUseId ? { tool_call_id: toolResult.toolUseId } : {}
            );
          }
        }
      }
      return;
    }

    const assistant = item?.assistantResponseMessage;
    if (assistant) {
      const toolCalls = toToolCalls(assistant.toolUses);
      addTextTarget(
        "assistant",
        assistant.content,
        { object: assistant, key: "content" },
        toolCalls ? { tool_calls: toolCalls } : {}
      );
    }
  };

  if (Array.isArray(state.history)) {
    for (const item of state.history) visit(item);
  }
  if (state.currentMessage) visit(state.currentMessage);

  return messages.length > 0 ? { messages, targets } : null;
}


export function applyKiroHeadroomMessages(projection, compressedMessages, diagnostics) {
  if (!Array.isArray(compressedMessages) || compressedMessages.length !== projection.messages.length) {
    setDiagnostic(diagnostics, "proxy response did not match Kiro message count");
    return false;
  }

  const updates = [];
  for (let i = 0; i < projection.messages.length; i++) {
    const expected = projection.messages[i];
    const actual = compressedMessages[i];
    if (!actual || actual.role !== expected.role) {
      setDiagnostic(diagnostics, "proxy response did not preserve Kiro message order");
      return false;
    }

    const text = typeof actual.content === "string" ? actual.content : null;
    if (text === null) {
      setDiagnostic(diagnostics, "proxy response missing Kiro text content");
      return false;
    }
    updates.push({ target: projection.targets[i], text });
  }

  for (const update of updates) {
    update.target.object[update.target.key] = update.text;
  }
  return true;
}

/**
 * Compress request body via Headroom Gateway v2.
 * Fail-open: returns null on any service/format error, leaving body untouched.
 */
export async function compressWithHeadroom(
  body,
  {
    enabled = true,
    url,
    proxyToken = "",
    model,
    format,
    compressUserMessages = false,
    timeoutMs = HEADROOM_DEFAULT_TIMEOUT_MS,
    preResponse = null,
    clientSignal = null,
    diagnostics = null,
    requestHeaders = null,
  } = {}
) {
  if (!enabled) {
    setDiagnostic(diagnostics, "disabled");
    return null;
  }
  if (!url) {
    setDiagnostic(diagnostics, "missing proxy URL");
    return null;
  }
  if (!body) {
    setDiagnostic(diagnostics, "missing request body");
    return null;
  }

  const diag = diagnostics || {};
  if (!diag.before) {
    diag.before = captureSizeSnapshot(body);
  }

  try {
    // 1. Kiro special format: projection mapping
    if (format === "kiro") {
      const projection = collectKiroHeadroomMessages(body);
      if (!projection) {
        setDiagnostic(diag, "Kiro request did not project to messages[]");
        return null;
      }
      const data = await callHeadroomGateway({
        url,
        proxyToken,
        model,
        format: "openai",
        body: { messages: projection.messages },
        compressUserMessages,
        timeoutMs,
        preResponse,
        clientSignal,
        diagnostics: diag,
        requestHeaders,
      });
      if (!data) return null;
      const compressedMsgs = data.compressedBody?.messages || data.compressedBody;
      if (!applyKiroHeadroomMessages(projection, compressedMsgs, diag)) return null;
      diag.after = captureSizeSnapshot(body);
      return data;
    }

    // 2. Native formats (Claude, OpenAI Responses, OpenAI Chat)
    // Directly compressed without lossy roundtrips
    const data = await callHeadroomGateway({
      url,
      proxyToken,
      model,
      format,
      body,
      compressUserMessages,
      timeoutMs,
      preResponse,
      clientSignal,
      diagnostics: diag,
      requestHeaders,
    });

    if (!data) return null;
    const compressed = data.compressedBody;
    if (format === "claude") {
      body.messages = compressed.messages;
      if (Object.hasOwn(compressed, "system")) body.system = compressed.system;
    } else if (format === "openai-responses" || (!format && Object.hasOwn(body, "input"))) {
      body.input = compressed.input;
    } else {
      body.messages = compressed.messages;
    }

    diag.after = captureSizeSnapshot(body);
    return data;
  } catch (error) {
    // Propagate client abort / preResponse deadline errors
    if (error?.code === "CLIENT_ABORT" || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED") {
      throw error;
    }
    setDiagnostic(diag, "gateway_unexpected_error");
    return null;
  }
}

export function formatHeadroomLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const delta = stats.tokens_saved || 0;
  const pct = before > 0 ? ((delta / before) * 100).toFixed(1) : "0";
  return `reported token delta=${delta} before=${before}${after ? ` after=${after}` : ""} (${pct}%)`.trim();
}

export function formatHeadroomSizeLog(diagnostics) {
  const before = diagnostics?.before;
  const after = diagnostics?.after;
  if (!before || !after) return "";
  const byteDelta = before.bodyBytes - after.bodyBytes;
  const effective = before.bodyBytes > 0
    ? ((byteDelta / before.bodyBytes) * 100).toFixed(1)
    : "0.0";
  return `body=${before.bodyBytes}B→${after.bodyBytes}B (Δ=${byteDelta}B, ${effective}%) messages=${before.messageBytes}B→${after.messageBytes}B tools=${before.toolSchemaBytes || 0}B toolHistory=${before.toolHistoryBytes || 0}B`;
}
