import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes, isOpenAIResponsesTerminalEvent, parseOpenAIResponsesSSERecord, formatIncompleteOpenAIResponsesStreamFailure } from "../../utils/responsesStreamHelpers.js";
import { ResponsesAccumulator } from "../../transformer/responsesAccumulator.js";
import { buildStreamErrorBytes } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { extractUsage, mergeUsage } from "../../utils/usageTracking.js";

const NATIVE_RESPONSES_HEADER_NAMES = [
  "openai-model", "x-request-id", "x-reasoning-included", "x-codex-turn-state",
  "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
];

export function buildNativeResponsesHeaders(upstreamHeaders) {
  const headers = new Headers(SSE_HEADERS);
  for (const name of NATIVE_RESPONSES_HEADER_NAMES) {
    const value = upstreamHeaders?.get?.(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
export function buildTransformStream({ provider, sourceFormat, targetFormat, responsesClientDialect = "standard-openai", responsesProviderDialect = "standard-openai", userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials, responseSchemaValidation }) {
  const isResponsesStream = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const isNativeResponsesStream = isResponsesStream && responsesClientDialect === responsesProviderDialect;

  // Cross-dialect Responses streams retain all non-terminal records verbatim;
  // only an empty completed terminal is enriched from prior protocol events.
  if (isResponsesStream && !isNativeResponsesStream) {
    const accumulator = new ResponsesAccumulator({ model });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let finalized = false;
    const finish = () => {
      if (finalized) return;
      finalized = true;
      const snapshot = accumulator.snapshot();
      const diagnostics = accumulator.diagnostics();
      console.info(`[RESP] client=${responsesClientDialect} provider=${provider} source=${sourceFormat} providerDialect=${responsesProviderDialect} mode=normalize events=${diagnostics.events} doneItems=${diagnostics.doneItems} textChars=${diagnostics.textChars} toolCalls=${diagnostics.toolCalls} terminalOutputBefore=${diagnostics.terminalOutputBefore} terminalOutputAfter=${diagnostics.terminalOutputAfter} status=${snapshot.status}`);
      if (!diagnostics.textChars && !diagnostics.toolCalls) console.info(`[RESP_EMPTY] client=${responsesClientDialect} provider=${provider} textChars=0 doneItems=${diagnostics.doneItems} toolCalls=0 reasoningItems=${diagnostics.reasoningItems}`);
      onStreamComplete?.({ content: "", thinking: "" }, snapshot.usage, null, { status: snapshot.status, successful: snapshot.status === "completed" });
    };
    const writeRecord = (record, controller) => {
      const parsed = accumulator.observeRecord(record);
      if (!parsed?.data) {
        controller.enqueue(encoder.encode(`${record}\n\n`));
        return;
      }
      const enriched = accumulator.enrichTerminal(parsed.data);
      if (enriched === parsed.data) {
        controller.enqueue(encoder.encode(`${record}\n\n`));
      } else {
        const eventPrefix = parsed.eventName ? `event: ${parsed.eventName}\n` : "";
        controller.enqueue(encoder.encode(`${eventPrefix}data: ${JSON.stringify(enriched)}\n\n`));
      }
      if (isOpenAIResponsesTerminalEvent(parsed.type, enriched)) finish();
    };
    return new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const records = buffer.split(/\r?\n\r?\n|\r\r/);
        buffer = records.pop() || "";
        for (const record of records) writeRecord(record, controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) writeRecord(buffer, controller);
        if (!accumulator.state.terminal) controller.enqueue(encoder.encode(formatIncompleteOpenAIResponsesStreamFailure({ model })));
        finish();
      },
    });
  }

  // Native Responses streams are protocol data, not Chat SSE. Preserve every
  // upstream byte, including data-only and future event types.
  if (isNativeResponsesStream) {
    let buffer = "";
    let terminal = false;
    let finalized = false;
    let usage = null;
    let content = "";
    let ttftAt = null;
    const decoder = new TextDecoder();
    const observe = (record) => {
      const parsed = parseOpenAIResponsesSSERecord(record);
      if (!parsed?.data) return;
      const isTextDelta = (parsed.type === "response.output_text.delta" || parsed.data.type === "response.output_text.delta")
        && typeof parsed.data.delta === "string";
      if (isTextDelta) {
        if (!ttftAt) ttftAt = Date.now();
        content += parsed.data.delta;
      }
      const extracted = extractUsage(parsed.data);
      if (extracted) usage = mergeUsage(usage, extracted);
      if (isOpenAIResponsesTerminalEvent(parsed.type, parsed.data)) {
        terminal = true;
        const status = parsed.data.response?.status || (parsed.type === "response.completed" ? "completed" : "failed");
        finish(status, status === "completed");
      }
    };
    const finish = (status, successful) => {
      if (finalized) return;
      finalized = true;
      onStreamComplete?.({ content, thinking: "" }, usage, ttftAt, { status, successful });
    };
    return new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const records = buffer.split(/\r?\n\r?\n|\r\r/);
        buffer = records.pop() || "";
        for (const record of records) observe(record);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) observe(buffer);
        if (!terminal) {
          controller.enqueue(new TextEncoder().encode(formatIncompleteOpenAIResponsesStreamFailure({ model })));
          finish("failed", false);
        }
      }
    });
  }

  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format.
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, responseSchemaValidation);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, responseSchemaValidation);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, responsesClientDialect = "standard-openai", responsesProviderDialect = "standard-openai", userAgent, body, stream, translatedBody, finalBody, responseSchemaValidation, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials }) {
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES && responsesClientDialect === responsesProviderDialect;
  let lifecycleFinalized = false;
  const completeLifecycle = (content, usage, ttftAt, outcome) => {
    if (lifecycleFinalized) return;
    lifecycleFinalized = true;
    onStreamComplete?.(content, usage, ttftAt, outcome);
    if (outcome?.successful === false) return;
    Promise.resolve(onRequestSuccess?.()).catch(err => {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    });
  };

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  if (!isResponsesPassthrough && onRequestSuccess) {
    Promise.resolve(onRequestSuccess()).catch(err => {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    });
  }
  const transformStream = buildTransformStream({
    provider, sourceFormat, targetFormat, responsesClientDialect, responsesProviderDialect, userAgent, reqLogger, toolNameMap, customToolNames,
    model, connectionId, body,
    onStreamComplete: isResponsesPassthrough ? completeLifecycle : onStreamComplete,
    apiKey, credentials, responseSchemaValidation,
  });

  // Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
  // client sees a real error instead of a silently truncated stream.
  // Responses passthrough keeps its own response.failed shape; every other client
  // format gets the OpenAI error frame + [DONE], or `event: error` for Claude.
  const onAbortTerminal = isResponsesPassthrough
    ? (message) => {
      completeLifecycle({ content: "", thinking: "" }, null, null, { status: "failed", successful: false });
      return buildAbortedResponsesTerminalBytes({ model, message });
    }
    : (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, {
      headers: isResponsesPassthrough ? buildNativeResponsesHeaders(providerResponse.headers) : SSE_HEADERS,
    })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt, outcome = { status: "completed", successful: true }) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    const successful = outcome?.successful !== false;
    trackPendingRequest(model, provider, connectionId, false);
    if (!successful) {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: outcome?.status || "failed" }).catch(() => {});
    }
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: successful ? "success" : "error"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; terminal outcome below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) {
      const summary = formatDoneLine({ usage, latency });
      log.line(reqTag, successful ? "📊" : "✗", successful ? summary : summary.replace("DONE", String(outcome?.status || "ERROR").toUpperCase()));
    }
  };

  return { onStreamComplete, streamDetailId };
}
