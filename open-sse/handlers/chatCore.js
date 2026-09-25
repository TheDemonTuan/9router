import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { createDeadlineError, createClientAbortError } from "../utils/preResponseBudget.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { validateCodexResponsesRequest } from "../executors/codex.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, getResponsesDialect, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { takeRenamedToolNames } from "../utils/opencodeFingerprint.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog } from "../rtk/headroom.js";
import { selectHeadroomStage, HEADROOM_STAGES } from "../rtk/headroomStage.js";
import { createHeadroomTurnContext } from "../rtk/headroomRelay.js";
import { recordHeadroomBypass } from "../rtk/headroomRuntime.js";
import { buildCompressEndpoint, isSafeOrigin } from "../rtk/headroomGateway.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { sanitizeAlitpBaseOrigin, applyAlitpBaseOrigin } from "../providers/alibabaTokenPlanCatalog.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId, resolveHeadroomSessionId } from "../utils/sessionManager.js";
import { createRouteContext, formatRoute } from "../utils/modelRoute.js";
import { bindResponseBody } from "../utils/responseLifecycle.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomProxyToken, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, onPxpipeEvent, sourceFormatOverride, providerThinking, clientSignal, preResponse = null, routeContext: inputRouteContext = null, routeReason = "direct", effectiveModel = null }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // Per-model guard: only use the transport when the model declares support for that
  // sourceFormat — opencode-go models differ in endpoint support (kimi/glm only do
  // /chat/completions), so without this guard a claude-format request would wrongly
  // route kimi to /messages.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  // Per-model guard: when a model declares supportedFormats, only use the
  // sourceFormat-matched transport if that format is declared (opencode-go models
  // differ — kimi/glm only do /chat/completions). Undeclared models keep the
  // upstream default (use the transport), preserving behavior for glm/deepseek/...
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat)) ? runtimeTransport : null;
  // A source-format-matched endpoint keeps the request lossless. Prefer it
  // over a model-level targetFormat, which is only the fallback for clients
  // whose wire format has no supported transport (for example MiniMax-M3:
  // OpenAI clients should stay on /chat/completions; other clients can fall
  // back to its declared Claude target).
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  // Alibaba Token Plan Team Edition: connections may carry a console Base URL
  // override. Swap the transport origin (all protocols) only for validated
  // https *.maas.aliyuncs.com values; anything else is ignored so a bad config
  // can never redirect credentials off the official endpoint.
  if (provider === "alitp-intl" && credentials) {
    const teamBase = credentials.providerSpecificData?.tokenPlanBaseUrl;
    if (sanitizeAlitpBaseOrigin(teamBase)) {
      const t = useTransport || PROVIDERS[provider]?.transports?.find((x) => x.format === targetFormat);
      if (t) credentials.runtimeTransport = { ...t, baseUrl: applyAlitpBaseOrigin(t.baseUrl, teamBase) };
    }
  }
  const stripList = getModelStrip(alias, model);
  const registryModel = model;
  const configuredUpstreamModel = getModelUpstreamId(alias, model);
  const wireModel = stripThinkingSuffix(configuredUpstreamModel);
  const upstreamModel = configuredUpstreamModel;

  const requestedProviderAlias = modelInfo?.providerAlias
    || (clientRawRequest?.body?.model?.includes("/") ? clientRawRequest.body.model.slice(0, clientRawRequest.body.model.indexOf("/")) : null)
    || alias;
  const clientModel = clientRawRequest?.body?.model
    || (requestedProviderAlias ? `${requestedProviderAlias}/${model}` : `${alias}/${model}`);

  const routeContext = inputRouteContext || createRouteContext({
    clientModel,
    requestedProviderAlias,
    provider,
    requestedModel: registryModel,
    effectiveModel: effectiveModel || (requestedProviderAlias ? `${requestedProviderAlias}/${model}` : `${alias}/${model}`),
    wireModel,
    reason: routeReason,
  });
  if (!routeContext.wireModel) routeContext.wireModel = wireModel;

  if (requestedProviderAlias && requestedProviderAlias !== provider) {
    log?.debug?.("ROUTE", `alias ${requestedProviderAlias} → provider ${provider}`);
  }
  log?.debug?.("MODEL", `${model} · wire=${wireModel}`);
  const detectedClientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const isChatGptWebCompact = provider === "chatgpt-web" && body?._compact === true;
  const nativePassthrough = isNativePassthrough(detectedClientTool, provider) || isChatGptWebCompact;

  // Provider-level overrides are translation conveniences, never part of native passthrough.
  // Mutating a Codex request here would break opaque reasoning/tool state.
  if (!nativePassthrough && providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort && !body.reasoning?.effort && !body.output_config?.effort) {
      // Precedence: explicit client effort on ANY wire shape wins over the
      // provider-configured default (chat reasoning_effort, Responses
      // reasoning.effort, Claude output_config.effort).
      body = { ...body, reasoning_effort: mode };
    }
  }

  // Per-request opt-out: client can bypass all token savers via header.
  const clientTokenSaverOptOut =
    clientRawRequest?.headers?.["x-9router-token-saver"]?.toLowerCase() === "off"
    || clientRawRequest?.headers?.["x-9r-token-saver"]?.toLowerCase() === "off"
    || clientRawRequest?.headers?.[TOKEN_SAVER_HEADER]?.toLowerCase() === "off";

  // Structured output is a protocol contract; prompt/content mutations are unsafe.
  const strictStructuredOutput =
    body.text?.format?.type === "json_schema"
    || body.response_format?.type === "json_schema"
    || body.response_format?.type === "json_object";

  // Deep clone body for source transformations to prevent mutating caller's original object
  let sourceBody;
  try {
    sourceBody = structuredClone(body);
  } catch {
    sourceBody = JSON.parse(JSON.stringify(body));
  }

  const tokenSaverEnabled = !clientTokenSaverOptOut && !strictStructuredOutput && !nativePassthrough;
  // Headroom 0.38 natively handles structured Responses/messages, decoupled from nativePassthrough and strictStructuredOutput
  const headroomEligible = !clientTokenSaverOptOut;

  // Headroom pure stage planning
  const headroomStagePlan = selectHeadroomStage({
    sourceFormat,
    targetFormat,
    provider,
    isCompact: isChatGptWebCompact,
  });

  const headroomDiagnostics = {};
  let headroomStats = null;
  let forwardedProviderHeaders = null;

  const handleHeadroomAbort = (error) => {
    if (error?.code !== "CLIENT_ABORT" && (error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || preResponse?.signal?.aborted)) {
      const deadlineError = error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" ? error : preResponse?.signal?.reason || createDeadlineError();
      if (!deadlineError.code) deadlineError.code = "PRE_RESPONSE_DEADLINE_EXCEEDED";
      if (!deadlineError.status) deadlineError.status = 504;
      if (preResponse) throw deadlineError;
      return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, deadlineError.message || "Gateway timeout: pre-response budget exceeded", null, {
        errorClass: "transient_provider_failure",
        retryable: true,
      });
    }
    if (error?.code === "CLIENT_ABORT" || (error?.code !== "PRE_RESPONSE_DEADLINE_EXCEEDED" && (clientSignal?.aborted || error?.name === "AbortError"))) {
      const abortError = error?.code === "CLIENT_ABORT" ? error : createClientAbortError();
      if (!abortError.code) abortError.code = "CLIENT_ABORT";
      if (!abortError.status) abortError.status = 499;
      if (preResponse) throw abortError;
      return createErrorResult(499, "Client closed request", null, {
        errorClass: "client_abort",
        retryable: false,
      });
    }
    return null;
  };

  // SOURCE_NATIVE stage: runs on the clean source body before translation
  if (headroomEligible && headroomEnabled && headroomStagePlan.stage === HEADROOM_STAGES.SOURCE_NATIVE) {
    try {
      headroomStats = await compressWithHeadroom(sourceBody, {
        enabled: true,
        url: headroomUrl,
        proxyToken: headroomProxyToken,
        model: upstreamModel,
        format: headroomStagePlan.format,
        compressUserMessages: headroomCompressUserMessages,
        timeoutMs: headroomTimeoutMs,
        preResponse,
        clientSignal: clientSignal || null,
        requestHeaders: clientRawRequest?.headers,
        diagnostics: headroomDiagnostics,
      });
      if (headroomStats?.providerHeaders) {
        forwardedProviderHeaders = headroomStats.providerHeaders;
      }
    } catch (error) {
      const abortResult = handleHeadroomAbort(error);
      if (abortResult) return abortResult;
      headroomStats = null;
    }
  }

  // Cursor's translator rewrites tool_result into user text, so RTK must run on
  // the source body before translation. Every other pair translates the tool
  // shapes 1:1 — keep the post-translate pass there so those providers are
  // untouched (and a retry never re-compresses an already-compressed body).
  const preTranslateRtk = provider === "cursor"
    ? compressMessages(sourceBody, tokenSaverEnabled && rtkEnabled)
    : null;
  const preTranslateRtkLine = formatRtkLog(preTranslateRtk);
  if (preTranslateRtkLine) console.log(preTranslateRtkLine);

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true && !isChatGptWebCompact;
  let stream = isChatGptWebCompact ? false : (providerRequiresStreaming ? true : (body.stream !== false));

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model, {
    redactPayloads: provider === "chatgpt-web",
  });
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectedClientTool;
  const passthrough = nativePassthrough;
  const responsesClientDialect = getResponsesDialect(clientTool);
  const responsesProviderDialect = getResponsesDialect(null, provider);

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const baseCaps = getCapabilitiesForModel(provider, model);
    const caps = provider === "codex" && credentials?.codexModelMetadata?.capabilities
      ? { ...baseCaps, ...credentials.codexModelMetadata.capabilities }
      : baseCaps;
    if (stripUnsupportedModalities(sourceBody, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(sourceBody, sourceFormat, targetFormat, { signal: undefined });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let responseSchemaValidation;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...sourceBody, model: wireModel };
    if (provider === "codex") {
      const suffixThinking = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider, undefined, credentials?.codexModelMetadata);
      if (suffixThinking.reasoning_effort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixThinking.reasoning_effort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    try {
      translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, sourceBody, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    } catch (error) {
      const message = error?.message
        ? (error.code === "unsupported_feature" || error.code === "invalid_thinking_level"
            ? error.message
            : `Failed to translate request for ${sourceFormat} → ${targetFormat}: ${error.message}`)
        : `Failed to translate request for ${sourceFormat} → ${targetFormat}`;
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, message);
    }
    if (!translatedBody) {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    responseSchemaValidation = translatedBody._responseSchemaValidation || translatedBody.request?._responseSchemaValidation;
    delete translatedBody._responseSchemaValidation;
    if (translatedBody.request?._responseSchemaValidation) delete translatedBody.request._responseSchemaValidation;
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = wireModel;
    stripContinuityFields(translatedBody);
  }

  if (provider === "codex" && targetFormat === FORMATS.OPENAI_RESPONSES) {
    try {
      validateCodexResponsesRequest(body);
    } catch (error) {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message);
    }
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const displayModel = formatRoute(routeContext);
    const msgN = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || body.messages?.length || body.input?.length || 0;
    const toolN = translatedBody.tools?.length || body.tools?.length || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${displayModel}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  // Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
  // requireClaudeToolType get the explicit type. Applying it unconditionally breaks
  // Claude-format endpoints that only accept the legacy typeless tool shape — DeepSeek's
  // Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }


  // RTK: compress tool_result content. Skipped when already done pre-translate.
  const rtkStats = preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // Headroom: optional external gateway compression; fail open if proxy is absent.
  // Runs TARGET_NATIVE (after translate) or PROJECTED (Kiro), only if not already run in SOURCE_NATIVE.
  if (!headroomStats && headroomEligible && headroomEnabled && (headroomStagePlan.stage === HEADROOM_STAGES.TARGET_NATIVE || headroomStagePlan.stage === HEADROOM_STAGES.PROJECTED)) {
    try {
      const headroomSessionId = resolveHeadroomSessionId({
        headers: clientRawRequest?.headers,
        body: translatedBody,
        apiKey,
        provider,
        model: upstreamModel,
        format: headroomStagePlan.format,
        compressUserMessages: headroomCompressUserMessages,
      });
      headroomStats = await compressWithHeadroom(translatedBody, {
        enabled: true,
        url: headroomUrl,
        proxyToken: headroomProxyToken,
        model: upstreamModel,
        format: headroomStagePlan.format,
        compressUserMessages: headroomCompressUserMessages,
        sessionId: headroomSessionId,
        timeoutMs: headroomTimeoutMs,
        preResponse,
        clientSignal: clientSignal || null,
        requestHeaders: clientRawRequest?.headers,
        diagnostics: headroomDiagnostics,
      });
      if (headroomStats?.providerHeaders) {
        forwardedProviderHeaders = headroomStats.providerHeaders;
      }
    } catch (error) {
      const abortResult = handleHeadroomAbort(error);
      if (abortResult) return abortResult;
      headroomStats = null;
    }
  }
  if (headroomEnabled && headroomEligible && headroomStagePlan.stage === HEADROOM_STAGES.BYPASS && headroomUrl) {
    const endpoint = buildCompressEndpoint(headroomUrl);
    if (isSafeOrigin(endpoint)) recordHeadroomBypass(endpoint, "stage_bypass");
  }
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  const reason = headroomDiagnostics.reason || headroomStagePlan.reason || "compression unavailable";
  if (headroomDiagnostics.transition === "opened") {
    log?.warn?.("HEADROOM", `circuit_open reason=${reason} budget=${headroomDiagnostics.budgetMs ?? 0}ms elapsed=${Math.round(headroomDiagnostics.latencyMs ?? 0)}ms cooldown=30000ms`);
  } else if (headroomDiagnostics.transition === "recovered") {
    log?.info?.("HEADROOM", "circuit_closed half_open_probe=success");
  }
  if (headroomLine) {
    log?.info?.("HEADROOM", `stage=${headroomStagePlan.stage} fmt=${headroomStagePlan.format || "-"} | ${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`);
  } else if (headroomEnabled && !clientTokenSaverOptOut) {
    if (reason === "gateway_timeout" || reason === "compression_timeout" || headroomDiagnostics.skip_reason === "compression_timeout") {
      const b = headroomDiagnostics.before;
      const q = headroomDiagnostics.queue;
      const sizeParts = b ? `body=${b.bodyBytes}B msgs=${b.messageCount ?? "?"} tools=${b.toolSchemaBytes ?? 0}B toolHistory=${b.toolHistoryBytes ?? 0}B` : "";
      const queueParts = q ? `inFlight=${q.inFlight} circuit=${q.circuitState}` : "";
      log?.warn?.("HEADROOM", `timeout reason=${reason}${headroomDiagnostics.skip_reason ? ` skipReason=${headroomDiagnostics.skip_reason}` : ""} budget=${headroomDiagnostics.budgetMs ?? 0}ms elapsed=${Math.round(headroomDiagnostics.latencyMs ?? 0)}ms${sizeParts ? ` ${sizeParts}` : ""}${queueParts ? ` ${queueParts}` : ""}`);
    } else {
      log?.debug?.("HEADROOM", `skipped reason=${reason}`);
    }
  }

  // Response usage relay context (Phase 3): active only when obligations.relay_usage === true
  const headroomTurnContext = createHeadroomTurnContext({
    url: headroomUrl,
    proxyToken: headroomProxyToken,
    turnId: headroomStats?.turnId,
    obligations: headroomStats?.obligations,
    startTime: requestStartTime,
    log,
  });

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  if (rtkStats?.hits?.length) xf.push(`RTK:${rtkStats.hits.length}`);
  if (headroomStats?.tokens_saved) xf.push(`HEADROOM:${headroomStats.tokens_saved}`);

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(`CAVEMAN:${cavemanLevel}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(`PONYTAIL:${ponytailLevel}`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled && tokenSaverEnabled && !strictStructuredOutput) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars, timeoutMs: pxpipeTimeoutMs, transform: pxpipeTransform,
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const executor = getExecutor(provider);
  const isStream = Boolean(stream);
  let pendingReleased = false;
  if (finalFormat !== FORMATS.CLAUDE && !(provider === "github" && executor.isClaudeModel(model))) {
    forwardedProviderHeaders = null;
  }
  const releasePending = (error = false) => {
    if (pendingReleased) return;
    pendingReleased = true;
    trackPendingRequest(model, provider, connectionId, false, error, { requestId: reqTag, stream: isStream });
  };
  trackPendingRequest(model, provider, connectionId, true, false, { requestId: reqTag, stream: isStream });
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      releasePending();
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => releasePending(true),
    onComplete: () => releasePending(),
    log, provider, model, reqTag, clientSignal
  });

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody, upstreamHeadersAt = null;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  try {
    const result = await (preResponse ? preResponse.run(() => executor.execute({
      model, body: translatedBody, stream, credentials, providerSessionId: sessionSeed,
      clientTool, signal: streamController.signal, log, proxyOptions, preResponse,
      customHeaders: forwardedProviderHeaders,
    })) : executor.execute({
      model, body: translatedBody, stream, credentials, providerSessionId: sessionSeed,
      clientTool, signal: streamController.signal, log, proxyOptions, preResponse,
      customHeaders: forwardedProviderHeaders,
    }));
    providerResponse = bindResponseBody(result.response, { signal: preResponse ? AbortSignal.any([streamController.signal, preResponse.signal]) : streamController.signal });
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    upstreamHeadersAt = result.upstreamHeadersAt ?? null;
    const renamedToolNames = takeRenamedToolNames(translatedBody);
    if (renamedToolNames?.size) {
      toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames]);
    }
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    const isClientAbort = error.code === "CLIENT_ABORT" || (error.name === "AbortError" && (clientSignal?.aborted || error.message?.includes?.("Client closed")));
    const isConnectTimeout = error.code === "UPSTREAM_CONNECT_TIMEOUT" || error.status === HTTP_STATUS.GATEWAY_TIMEOUT;
    const failureStatus = isClientAbort ? 499 : (isConnectTimeout ? HTTP_STATUS.GATEWAY_TIMEOUT : HTTP_STATUS.BAD_GATEWAY);

    try {
      headroomTurnContext?.complete?.({
        statusCode: failureStatus,
        status: failureStatus,
        error,
        latencyMs: Date.now() - requestStartTime,
      });
    } catch { /* best effort */ }

    if (preResponse?.signal.aborted || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.code === "CLIENT_ABORT") {
      streamController.abort(error);
      streamController.handleError(error);
      throw preResponse?.signal.aborted ? preResponse.signal.reason : error;
    }

    releasePending(true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${failureStatus}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, routeContext,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: failureStatus, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    if (isClientAbort) {
      streamController.handleError(error);
      return createErrorResult(499, "Client closed request", null, { errorClass: "client_abort", retryable: false });
    }
    if (isConnectTimeout) {
      streamController.handleError(error);
      if (log?.errorLine) {
        log.errorLine(reqTag, "✗", `TIMEOUT 504 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${error.message}`);
      }
      return createErrorResult(HTTP_STATUS.GATEWAY_TIMEOUT, error.message, null, {
        errorClass: "transient_provider_failure",
        retryable: true
      });
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`);
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, null, {
      errorClass: "transient_provider_failure",
      retryable: true
    });
  }

  try {
  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(async () => {
        const result = await executor.refreshCredentials(credentials, log);
        if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await (preResponse ? preResponse.run(() => executor.execute({
            model, body: translatedBody, stream, credentials, providerSessionId: sessionSeed,
            clientTool, signal: streamController.signal, log, proxyOptions, preResponse,
            customHeaders: forwardedProviderHeaders,
          })) : executor.execute({
            model, body: translatedBody, stream, credentials, providerSessionId: sessionSeed,
            clientTool, signal: streamController.signal, log, proxyOptions, preResponse,
            customHeaders: forwardedProviderHeaders,
          }));
          retryResult.response = bindResponseBody(retryResult.response, { signal: preResponse ? AbortSignal.any([streamController.signal, preResponse.signal]) : streamController.signal });
          if (retryResult.response.ok) {
            providerResponse.body?.cancel().catch(() => {});
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerHeaders = retryResult.headers;
            finalBody = retryResult.transformedBody;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
            upstreamHeadersAt = retryResult.upstreamHeadersAt ?? null;
          } else retryResult.response.body?.cancel().catch(() => {});
        } catch (error) {
          if (preResponse?.signal.aborted || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.code === "CLIENT_ABORT") throw preResponse?.signal.aborted ? preResponse.signal.reason : error;
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      if (preResponse?.signal.aborted || e?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || e?.code === "CLIENT_ABORT") throw preResponse?.signal.aborted ? preResponse.signal.reason : e;
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    releasePending(true);
    try {
      headroomTurnContext?.complete?.({
        statusCode: providerResponse.status,
        status: providerResponse.status,
        error: new Error(`Provider returned HTTP ${providerResponse.status}`),
        latencyMs: Date.now() - requestStartTime,
      });
    } catch { /* best-effort */ }
    const terminalNoFallback = providerResponse.headers.get("x-9router-no-fallback") === "true";
    const originalProviderError = terminalNoFallback ? providerResponse.clone() : null;
    const { statusCode, message, resetsAtMs, resolvedModel, errorClass, retryable } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, routeContext,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    if (log?.errorLine) {
      const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : "";
      log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
    }
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    const errorResult = createErrorResult(statusCode, errMsg, resetsAtMs, {
      errorClass,
      retryable,
      ...(resolvedModel ? { resolvedModel } : {}),
    });
    if (terminalNoFallback) {
      errorResult.terminalNoFallback = true;
      errorResult.response = originalProviderError;
    }
    return errorResult;
  }

  const sharedCtx = {
    provider, model, body, stream, translatedBody, finalBody,
    responseSchemaValidation, requestStartTime, connectionId, apiKey,
    clientRawRequest, onRequestSuccess, pxpipe: pxpipeSummary, reqTag,
    log, responsesClientDialect, responsesProviderDialect, releasePending,
    preResponse, upstreamHeadersAt, routeContext,
    headroomTurnContext,
  };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => releasePending();

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, toolNameMap, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, credentials });
  } catch (error) {
    if (preResponse?.signal.aborted || error?.code === "PRE_RESPONSE_DEADLINE_EXCEEDED" || error?.code === "CLIENT_ABORT") {
      streamController.abort(error);
      streamController.handleError(error);
    }
    throw preResponse?.signal.aborted ? preResponse.signal.reason : error;
  }
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
