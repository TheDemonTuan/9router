import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS, CODEX_STREAM_PROGRESS_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes, isOpenAIResponsesTerminalEvent, isOpenAIResponsesProgressEvent, parseOpenAIResponsesSSERecord } from "../../utils/responsesStreamHelpers.js";
import { ResponsesAccumulator } from "../../transformer/responsesAccumulator.js";
import { buildStreamErrorBytes } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { extractUsage, mergeUsage } from "../../utils/usageTracking.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";

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
  const extra = upstreamResponseHeaders(upstreamHeaders);
  for (const [name, value] of Object.entries(extra)) {
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
export function buildTransformStream({ provider, sourceFormat, targetFormat, responsesClientDialect = "standard-openai", responsesProviderDialect = "standard-openai", userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials, responseSchemaValidation, releasePending, toolArgumentValidation = null, signal = null }) {
  const isResponsesStream = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const isNativeResponsesStream = isResponsesStream && responsesClientDialect === responsesProviderDialect;
  const progressState = { version: 0, terminal: false };
  let createdSeen = false;
  const observeProgress = (parsed) => {
    if (parsed.type === "response.created") {
      if (createdSeen) return;
      createdSeen = true;
    }
    if (isOpenAIResponsesProgressEvent(parsed.type, parsed.data)) progressState.version++;
    if (isOpenAIResponsesTerminalEvent(parsed.type, parsed.data)) progressState.terminal = true;
  };

  // Cross-dialect Responses streams retain all non-terminal records verbatim;
  // only an empty completed terminal is enriched from prior protocol events.
  if (isResponsesStream && !isNativeResponsesStream) {
    const accumulator = new ResponsesAccumulator({ model });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let finalized = false;
    let ttftAt = null;
    let content = "";
    let responseId = null;
    const abortTerminal = (message) => {
      if (finalized) return new Uint8Array();
      finalized = true;
      progressState.terminal = true;
      onStreamComplete?.({ content, thinking: "" }, accumulator.snapshot().usage, ttftAt, { status: "failed", successful: false });
      return buildAbortedResponsesTerminalBytes({ model, message, responseId });
    };
    const finish = () => {
      if (finalized) return;
      finalized = true;
      const snapshot = accumulator.snapshot();
      const diagnostics = accumulator.diagnostics();
      if (!diagnostics.textChars && !diagnostics.toolCalls) console.info(`[RESP_EMPTY] client=${responsesClientDialect} provider=${provider} textChars=0 doneItems=${diagnostics.doneItems} toolCalls=0 reasoningItems=${diagnostics.reasoningItems}`);
      onStreamComplete?.({ content, thinking: "" }, snapshot.usage, ttftAt, { status: snapshot.status, successful: snapshot.status === "completed" });
    };
    const writeRecord = (record, controller) => {
      const parsed = accumulator.observeRecord(record);
      if (!parsed?.data) {
        controller.enqueue(encoder.encode(`${record}\n\n`));
        return;
      }
      if (parsed.data.response?.id) responseId = parsed.data.response.id;
      observeProgress(parsed);
      const isTextDelta = (parsed?.type === "response.output_text.delta" || parsed?.data?.type === "response.output_text.delta")
        && typeof parsed?.data?.delta === "string";
      if (isTextDelta) {
        if (!ttftAt) ttftAt = Date.now();
        content += parsed.data.delta;
      }
      const enriched = accumulator.enrichTerminal(parsed.data);
      if (enriched === parsed.data) {
        controller.enqueue(encoder.encode(`${record}\n\n`));
      } else {
        const eventPrefix = parsed.eventName ? `event: ${parsed.eventName}\n` : "";
        controller.enqueue(encoder.encode(`${eventPrefix}data: ${JSON.stringify(enriched)}\n\n`));
      }
      if (isOpenAIResponsesTerminalEvent(parsed.type, enriched)) {
        finish();
        controller.terminate();
      }
    };
    const transform = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const records = buffer.split(/\r?\n\r?\n|\r\r/);
        buffer = records.pop() || "";
        for (const record of records) {
          writeRecord(record, controller);
          if (finalized) break;
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) writeRecord(buffer, controller);
        if (!finalized) controller.enqueue(abortTerminal());
      },
    });
    transform.abortTerminal = abortTerminal;
    transform.progressState = progressState;
    return transform;
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
    let responseId = null;
    const abortTerminal = (message) => {
      if (finalized) return new Uint8Array();
      terminal = true;
      progressState.terminal = true;
      finish("failed", false);
      return buildAbortedResponsesTerminalBytes({ model, message, responseId });
    };
    const decoder = new TextDecoder();
    const observe = (record) => {
      const parsed = parseOpenAIResponsesSSERecord(record);
      if (!parsed?.data) return;
      if (parsed.data.response?.id) responseId = parsed.data.response.id;
      observeProgress(parsed);
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
        const status = parsed.data.response?.status || (["response.completed", "response.done"].includes(parsed.type) ? "completed" : "failed");
        finish(status, status === "completed");
      }
    };
    const finish = (status, successful) => {
      if (finalized) return;
      finalized = true;
      onStreamComplete?.({ content, thinking: "" }, usage, ttftAt, { status, successful });
    };
    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        const records = buffer.split(/\r?\n\r?\n|\r\r/);
        buffer = records.pop() || "";
        for (const record of records) {
          observe(record);
          if (terminal) { controller.terminate(); break; }
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) observe(buffer);
        if (!terminal) controller.enqueue(abortTerminal());
      }
    });
    transform.abortTerminal = abortTerminal;
    transform.progressState = progressState;
    return transform;
  }

  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format.
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, responseSchemaValidation, releasePending, toolArgumentValidation, signal);
  }

  if (needsTranslation(targetFormat, sourceFormat) || toolArgumentValidation) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, responseSchemaValidation, releasePending, toolArgumentValidation, signal);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, releasePending);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, responsesClientDialect = "standard-openai", responsesProviderDialect = "standard-openai", userAgent, body, stream, translatedBody, finalBody, responseSchemaValidation, toolArgumentValidation = null, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials, releasePending, upstreamHeadersAt = null, preResponse = null, routeContext = null, timingContext = null }) {
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES && responsesClientDialect === responsesProviderDialect;
  const directClaudeResponses = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.CLAUDE;
  const terminalDriven = (sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES) || directClaudeResponses;
  let lifecycleFinalized = false;
  const hdrAt = Number.isFinite(upstreamHeadersAt) ? upstreamHeadersAt : null;
  let ubyteAt = null;
  let dbyteAt = null;
  const onUpstreamFirstByte = () => { if (!ubyteAt) { ubyteAt = Date.now(); timingContext?.mark("firstByte", ubyteAt); } };
  const onDownstreamFirstByte = () => { if (!dbyteAt) { dbyteAt = Date.now(); timingContext?.mark("firstDownstreamByte", dbyteAt); } };

  const completeLifecycle = (content, usage, ttftAt, outcome) => {
    if (lifecycleFinalized) return;
    lifecycleFinalized = true;
    onStreamComplete?.(content, usage, ttftAt, outcome, { hdrAt, ubyteAt, dbyteAt });
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
    const bodyText = await providerResponse.text().catch((error) => {
      if (preResponse?.signal.aborted || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.code === "CLIENT_ABORT") throw preResponse?.signal.aborted ? preResponse.signal.reason : error;
      return "";
    });
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

  if (!terminalDriven && !toolArgumentValidation && onRequestSuccess) {
    Promise.resolve(onRequestSuccess()).catch(err => {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    });
  }
  const wrappedOnStreamComplete = (content, usage, ttftAt, outcome) => {
    onStreamComplete?.(content, usage, ttftAt, outcome, { hdrAt, ubyteAt, dbyteAt });
    if (toolArgumentValidation && outcome?.successful !== false) Promise.resolve(onRequestSuccess?.()).catch(() => {});
  };
  const transformStream = buildTransformStream({
    provider, sourceFormat, targetFormat, responsesClientDialect, responsesProviderDialect, userAgent, reqLogger, toolNameMap, customToolNames,
    model, connectionId, body,
    onStreamComplete: terminalDriven ? completeLifecycle : wrappedOnStreamComplete,
    apiKey, credentials, responseSchemaValidation, releasePending, toolArgumentValidation, signal: streamController?.signal,
  });

  // A translated Responses client needs the same protocol terminal as native
  // Responses, with the active response ID and no duplicate success/failure.
  const onAbortTerminal = transformStream.abortTerminal
    ? (message) => transformStream.abortTerminal(message)
    : sourceFormat === FORMATS.OPENAI_RESPONSES
      ? (message) => {
        if (lifecycleFinalized) return new Uint8Array();
        completeLifecycle({ content: "", thinking: "" }, null, null, { status: "failed", successful: false });
        return buildAbortedResponsesTerminalBytes({ model, message });
      }
      : (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(
    providerResponse,
    transformStream,
    streamController,
    onAbortTerminal,
    stallTimeoutMs,
    { onUpstreamFirstByte, onDownstreamFirstByte,
      progressState: provider === "codex" ? transformStream.progressState : null,
      progressTimeoutMs: provider === "codex" ? CODEX_STREAM_PROGRESS_TIMEOUT_MS : 0 },
  );

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, routeContext,
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
      headers: isResponsesPassthrough
        ? buildNativeResponsesHeaders(providerResponse.headers)
        : { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) },
    })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, releasePending, routeContext = null, timingContext = null }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt, outcome = { status: "completed", successful: true }, metrics = {}) => {
    const now = Date.now();
    if (timingContext) {
      if (Number.isFinite(metrics?.hdrAt)) timingContext.mark("headers", metrics.hdrAt);
      if (Number.isFinite(metrics?.ubyteAt)) timingContext.mark("firstByte", metrics.ubyteAt);
      if (Number.isFinite(metrics?.dbyteAt)) timingContext.mark("firstDownstreamByte", metrics.dbyteAt);
      if (Number.isFinite(outcome?.firstReasoningAt)) timingContext.mark("firstReasoning", outcome.firstReasoningAt);
      if (Number.isFinite(ttftAt)) timingContext.mark("firstText", ttftAt);
      if (Number.isFinite(outcome?.firstToolAt)) timingContext.mark("firstTool", outcome.firstToolAt);
      timingContext.mark("terminal", Number.isFinite(outcome?.terminalAt) ? outcome.terminalAt : now);
    }
    const latency = {
      requestId: timingContext?.requestId ?? null,
      ttft: ttftAt ? ttftAt - requestStartTime : null,
      ftext: ttftAt ? ttftAt - requestStartTime : null,
      firstReasoning: outcome?.firstReasoningAt ? outcome.firstReasoningAt - requestStartTime : null,
      firstTool: outcome?.firstToolAt ? outcome.firstToolAt - requestStartTime : null,
      hdr: metrics?.hdrAt ? metrics.hdrAt - requestStartTime : null,
      ubyte: metrics?.ubyteAt ? metrics.ubyteAt - requestStartTime : null,
      preCore: timingContext?.durations?.preCoreMs ?? null,
      auth: timingContext?.durations?.authMs ?? null,
      account: timingContext?.durations?.accountMs ?? null,
      refresh: timingContext?.durations?.refreshMs ?? null,
      bodyParse: timingContext?.durations?.bodyMs ?? null,
      payloadPrep: timingContext?.durations?.payloadPrepMs ?? null,
      dispatch: timingContext?.durations?.dispatchMs ?? null,
      dbyte: metrics?.dbyteAt ? metrics.dbyteAt - requestStartTime : null,
      cancelled: timingContext?.durations?.cancelledMs ?? null,
      total: (Number.isFinite(outcome?.terminalAt) ? outcome.terminalAt : now) - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    const successful = outcome?.successful !== false;
    (releasePending || (() => trackPendingRequest(model, provider, connectionId, false)))(!successful);
    if (!successful) {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: outcome?.status || "failed" }).catch(() => {});
    }
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, routeContext,
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
