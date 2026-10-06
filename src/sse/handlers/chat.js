import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { createDeadlineError } from "open-sse/utils/preResponseBudget.js";
import { createRouteContext } from "open-sse/utils/modelRoute.js";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { credentialUnavailableResponse, errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { assertChatGptWebAuthorityHeaderSize, chatGptWebAuthorityErrorResponse, chatGptWebAuthorityRequiredResponse, loadChatGptWebClientKeys, redactChatGptWebInternalHeaders, verifyChatGptWebAuthority } from "@/lib/chatgptWebAuthority.js";
import { browserRequestUsesTools, validateBrowserChatRequest, validateBrowserResponsesRequest } from "../../../services/chatgpt-web-runtime/browser-request.js";
import { AUTHORITY_HEADER } from "../../../services/chatgpt-web-runtime/protocol.js";

import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  resolveCodexModels,
  codexCatalogSupportsRequest,
  isCodexFallbackModel,
} from "open-sse/services/codexModels.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  getChatGptWebCatalog,
} from "open-sse/services/chatgptWebRuntimeClient.js";
import { getChatGptWebLegacyConversation } from "open-sse/utils/sessionManager.js";

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return typeof entry?.[1] === "string" && entry[1].trim() ? entry[1].trim() : null;
}

function getChatGptWebExplicitConnectionId(clientRawRequest) {
  return readHeader(clientRawRequest?.headers, "x-connection-id")
    || readHeader(clientRawRequest?.headers, "x-9router-connection-id");
}


function withConnectionHeader(response, connectionId) {
  if (!response || !connectionId) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-connection-id", String(connectionId));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withChatGptWebNoFallback(response) {
  const headers = new Headers(response.headers);
  headers.set("x-9router-no-fallback", "true");
  headers.set("x-should-retry", "false");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function bridgeContinuationError(connectionId) {
  return new Response(JSON.stringify({
    error: {
      type: "bridge_error",
      code: "bridge_connection_unavailable",
      message: `Pinned ChatGPT Web bridge connection is unavailable: ${connectionId}`,
    },
  }), {
    status: 409,
    headers: {
      "content-type": "application/json",
      "x-9router-no-fallback": "true",
      "x-should-retry": "false",
      "x-9router-error-code": "bridge_connection_unavailable",
      "x-9router-connection-id": String(connectionId),
    },
  });
}

/**
 * Resolve account-scoped cgw capabilities before combo ordering. Unknown or stale rows stay
 * unsupported; a capability is usable when at least one verified active bridge can provide it.
 */
function bridgeCapabilityForRequest(authority) {
  return authority ? "native_responses" : "generic_responses";
}

function browserRequestErrorResponse(error) {
  return withChatGptWebNoFallback(Response.json({ error: { type: "runtime_error", code: error.code || "unsupported_browser_request",
    message: error.message, retryable: false, submission_state: "not_sent" } }, { status: error.status || 400 }));
}

function validateBrowserPublicRequest(body, endpoint) {
  if (body?._compact === true || Object.keys(body || {}).some(key => key.startsWith("_chatgpt")
    || ["client_metadata", "authority", "cwd", "roots", "environment", "pathFlavor", "clientId", "nativeThreadId", "nativeTurnId"].includes(key))
    || body?.input?.some?.(item => item?.type === "compaction_trigger")) return chatGptWebAuthorityRequiredResponse();
  try {
    if (["/v1/chat/completions", "/api/v1/chat/completions"].includes(endpoint)) validateBrowserChatRequest(body);
    else if (["/v1/responses", "/api/v1/responses"].includes(endpoint)) validateBrowserResponsesRequest(body);
    else return chatGptWebAuthorityRequiredResponse();
  } catch (error) { return browserRequestErrorResponse(error); }
  return null;
}

async function loadChatGptWebComboCapabilities(models, bridgeCapability = "generic_responses") {
  const resolved = await Promise.all((Array.isArray(models) ? models : []).filter(value => typeof value === "string")
    .map(async candidate => ({ candidate, info: await getModelInfo(candidate) })));
  const bridgeModels = resolved.filter(({ info }) => info.provider === "chatgpt-web");
  if (bridgeModels.length === 0) return null;

  const capabilities = new Map();
  let connections;
  try {
    connections = await getProviderConnections({ provider: "chatgpt-web", isActive: true });
  } catch {
    return capabilities;
  }

  await Promise.all(connections.map(async (connection) => {
    try {
      const catalog = await getChatGptWebCatalog(connection);
      if (catalog.stale) return;
      for (const { candidate, info } of bridgeModels) {
        const rowId = info.model;
        const row = catalog.models?.find((entry) => entry.id === rowId);
        if (row?.capabilities?.[bridgeCapability] !== true) continue;
        if (!row?.capabilities || typeof row.capabilities !== "object") continue;
        const merged = capabilities.get(candidate) || {};
        for (const [key, value] of Object.entries(row.capabilities)) {
          if (bridgeCapability === "generic_responses" && !["text", "generic_responses", "generic_tools"].includes(key)) continue;
          if (value === true) merged[key] = true;
          else if (!(key in merged) && value === false) merged[key] = false;
        }
        capabilities.set(candidate, merged);
      }
    } catch {
      // Offline/unknown bridges contribute no capability evidence.
    }
  }));
  return capabilities;
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, options = {}) {
  const preResponse = options?.preResponse || clientRawRequest?.preResponse || request?.preResponse || null;
  let body;
  let rawBody;
  let chatGptWebAuthority = null;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch (error) {
    if (error?.status === 431) return chatGptWebAuthorityErrorResponse(error);
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const cgwRequest = typeof body?.model === "string" && (body.model.startsWith("cgw/")
    || body.model.startsWith("chatgpt-web/") || (await getModelInfo(body.model)).provider === "chatgpt-web");
  if (cgwRequest || request.headers.has(AUTHORITY_HEADER)) {
    const key = extractApiKey(request);
    if (!key || !await isValidApiKey(key)) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Valid API key required for ChatGPT Web");
    if (request.headers.has(AUTHORITY_HEADER)) {
      try {
        assertChatGptWebAuthorityHeaderSize(request.headers);
        chatGptWebAuthority = verifyChatGptWebAuthority({ rawBody, method: request.method,
          path: new URL(request.url).pathname, headers: request.headers, clientKeys: await loadChatGptWebClientKeys() });
      } catch (error) { return chatGptWebAuthorityErrorResponse(error); }
    } else {
      if (options.operation === "compact") return chatGptWebAuthorityRequiredResponse();
      const invalid = validateBrowserPublicRequest(body, new URL(request.url).pathname);
      if (invalid) return invalid;
    }
  }
  if (options.operation === "compact") body = { ...body, _compact: true };

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: redactChatGptWebInternalHeaders(request.headers)
    };
  }
  clientRawRequest = { ...clientRawRequest, headers: redactChatGptWebInternalHeaders(clientRawRequest.headers) };
  // Preserve the requested context marker for account eligibility; strip only for resolution/wire.
  const requestedModelStr = body.model;
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = cgwRequest || chatGptWebAuthority ? null : handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);
  const bridgeCapability = bridgeCapabilityForRequest(chatGptWebAuthority);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    if (chatGptWebAuthority) return chatGptWebAuthorityRequiredResponse();
    if ((await Promise.all(comboModels.map(model => getModelInfo(model)))).some(info => info.provider === "chatgpt-web")) {
      if (!apiKey || !await isValidApiKey(apiKey)) return withChatGptWebNoFallback(errorResponse(401, "Valid API key required for ChatGPT Web"));
      const invalid = validateBrowserPublicRequest(body, new URL(request.url).pathname);
      if (invalid) return invalid;
      if (browserRequestUsesTools(clientRawRequest?.body || body)) {
        requiredCapabilities.delete("search");
        requiredCapabilities.delete("tools");
        requiredCapabilities.add("generic_tools");
      }
      if ((settings.comboStrategies?.[modelStr]?.fallbackStrategy || settings.comboStrategy) === "fusion") return browserRequestErrorResponse({ code: "unsupported_browser_request", status: 400, message: "ChatGPT Web does not support fusion requests" });
    }
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
    const liveCapabilities = await loadChatGptWebComboCapabilities(augmentedModels, bridgeCapability);

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel, meta = {}) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { chatGptWebAuthority, preResponse,
          clientModel: modelStr,
          effectiveModel: m,
          routeReason: "combo",
          ...meta });
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
        preResponse,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { chatGptWebAuthority, preResponse,
        clientModel: modelStr,
        effectiveModel: m,
        routeReason: "combo",
        ...meta }),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      liveCapabilities,
      preResponse,
    });
  }

  if (cgwRequest || chatGptWebAuthority) {
    // Both Web lanes require the exact provider; capacity adapters must not substitute.
    return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, {
      preResponse, chatGptWebAuthority, clientModel: modelStr, effectiveModel: modelStr, routeReason: "direct",
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { chatGptWebAuthority, preResponse,
        clientModel: modelStr,
        effectiveModel: m,
        routeReason: m !== modelStr ? "capacity-adapter" : "direct",
        ...meta }),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      preResponse,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { chatGptWebAuthority, preResponse,
    clientModel: modelStr, effectiveModel: modelStr, requestedModel: requestedModelStr,
    routeReason: "direct" });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, { preResponse = null, clientModel = null, effectiveModel = null, routeReason = "direct", routeContext = null, chatGptWebAuthority = null, requestedModel = null } = {}) {
  requestedModel = (requestedModel || modelStr).split("/").slice(-1)[0];
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      if (chatGptWebAuthority) return chatGptWebAuthorityRequiredResponse();
      if ((await Promise.all(comboModels.map(model => getModelInfo(model)))).some(info => info.provider === "chatgpt-web")) {
        if (!apiKey || !await isValidApiKey(apiKey)) return withChatGptWebNoFallback(errorResponse(401, "Valid API key required for ChatGPT Web"));
        const invalid = validateBrowserPublicRequest(clientRawRequest?.body || body, new URL(request.url).pathname);
        if (invalid) return invalid;
        if (comboStrategy === "fusion") return browserRequestErrorResponse({ code: "unsupported_browser_request", status: 400, message: "ChatGPT Web does not support fusion requests" });
      }
      const requiredCapabilities = detectRequiredCapabilities(body);
      const bridgeCapability = bridgeCapabilityForRequest(chatGptWebAuthority);
      if (!chatGptWebAuthority && browserRequestUsesTools(clientRawRequest?.body || body)
        && (await Promise.all(comboModels.map(model => getModelInfo(model)))).some(info => info.provider === "chatgpt-web")) {
        requiredCapabilities.delete("search");
        requiredCapabilities.delete("tools");
        requiredCapabilities.add("generic_tools");
      }
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      const liveCapabilities = await loadChatGptWebComboCapabilities(augmentedModels, bridgeCapability);

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel, meta = {}) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { chatGptWebAuthority, preResponse,
            clientModel: modelStr,
            effectiveModel: m,
            routeReason: "combo",
            ...meta });
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          preResponse,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { chatGptWebAuthority, preResponse,
          clientModel: modelStr,
          effectiveModel: m,
          routeReason: "combo",
          ...meta }),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        liveCapabilities,
        preResponse,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  if (provider === "chatgpt-web") {
    if (!apiKey || !await isValidApiKey(apiKey)) return withChatGptWebNoFallback(errorResponse(401, "Valid API key required for ChatGPT Web"));
    if (!chatGptWebAuthority) {
      const invalid = validateBrowserPublicRequest(clientRawRequest?.body || body, new URL(request.url).pathname);
      if (invalid) return invalid;
    } else if (modelStr !== chatGptWebAuthority.originalModel && modelStr !== clientRawRequest?.body?.model) {
      return chatGptWebAuthorityRequiredResponse();
    }
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  const requiredCapabilities = detectRequiredCapabilities(body);
  let nativeMetadata = body?.client_metadata?.["x-codex-turn-metadata"];
  if (typeof nativeMetadata === "string") { try { nativeMetadata = JSON.parse(nativeMetadata); } catch { nativeMetadata = null; } }
  const cgwCompaction = body?._compact === true || nativeMetadata?.request_kind === "compaction"
    || (Array.isArray(body?.input) && body.input.some(item => item?.type === "compaction_trigger"));
  const browserTools = provider === "chatgpt-web" && !chatGptWebAuthority && browserRequestUsesTools(clientRawRequest?.body || body);
  if (browserTools) {
    requiredCapabilities.delete("search");
    requiredCapabilities.delete("tools");
    requiredCapabilities.add("generic_tools");
  } else if (provider === "chatgpt-web" && !cgwCompaction && Array.isArray(body?.tools) && body.tools.length) requiredCapabilities.add("tools");
  const bridgeCapability = bridgeCapabilityForRequest(chatGptWebAuthority);
  if (provider === "chatgpt-web" && await getChatGptWebLegacyConversation({ headers: clientRawRequest?.headers, body })) {
    return new Response(JSON.stringify({ error: { type: "runtime_error", code: "legacy_conversation_unavailable", message: "Start a new canonical task after profile login; legacy socket conversations cannot resume", retryable: false } }),
      { status: 409, headers: { "content-type": "application/json", "x-9router-no-fallback": "true" } });
  }
  const explicitConnectionId = provider === "chatgpt-web"
    ? getChatGptWebExplicitConnectionId(clientRawRequest)
    : null;
  let pinnedConnectionId = explicitConnectionId;
  let lastError = null;
  let lastStatus = null;
  const codexCapabilityReasons = new Set();
  let lastHeaders = null;

  while (true) {
    if (preResponse && (preResponse.remainingMs() <= 0 || preResponse.signal?.aborted)) {
      throw (preResponse.signal?.reason || createDeadlineError());
    }
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
        requestedModel,
        requiredCapabilities,
        ...(explicitConnectionId ? { pinConnectionId: explicitConnectionId } : {}),
        ...(provider === "chatgpt-web" ? { bridgeCapability, chatGptWebAuthority, chatGptWebReasoning: body.reasoning?.effort ?? body.reasoning_effort,
          signal: preResponse?.signal || request?.signal } : {}),
      });
    } catch (error) {
      if (provider !== "chatgpt-web") throw error;
      return withChatGptWebNoFallback(Response.json({ error: { type: "runtime_error", code: "runtime_unavailable", message: "Durable ChatGPT Web profile binding is unavailable", retryable: false, submission_state: "not_sent" } }, { status: 503 }));
    }
    if (credentials?.chatGptWebBindingError) return withChatGptWebNoFallback(credentials.chatGptWebBindingError);

    if (credentials?.pinnedConnectionUnavailable) return bridgeContinuationError(pinnedConnectionId);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return credentialUnavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        const unavailable = provider === "chatgpt-web" && !chatGptWebAuthority
          ? Response.json({ error: { type: "runtime_error", code: browserTools ? "browser_tools_unavailable" : "generic_model_unavailable", message: browserTools ? "No eligible Browser-only model supports client function tools" : "No verified Browser-only model is available. Verify the profile, select Browser-only, or upgrade the runtime.", retryable: false, submission_state: "not_sent" } }, { status: browserTools ? 400 : 503 })
          : errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
        return provider === "chatgpt-web" ? withChatGptWebNoFallback(unavailable) : unavailable;
      }
      log.warn("CHAT", "No more accounts available", { provider });
      if (provider === "codex" && codexCapabilityReasons.size > 0) {
        const status = codexCapabilityReasons.has("unverified catalog")
          || codexCapabilityReasons.has("unknown_effort")
          ? HTTP_STATUS.SERVICE_UNAVAILABLE
          : codexCapabilityReasons.has("effort")
            ? HTTP_STATUS.BAD_REQUEST
            : HTTP_STATUS.NOT_FOUND;
        const suffix = codexCapabilityReasons.has("effort") ? " (unsupported reasoning effort)" : "";
        return errorResponse(status, `No Codex account supports ${model}${suffix}`, lastHeaders);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    if (provider === "chatgpt-web") refreshedCredentials.chatGptWebAuthority = chatGptWebAuthority;
    if (provider === "chatgpt-web") refreshedCredentials.chatGptWebOriginalModel = clientRawRequest?.body?.model;

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    if (provider === "codex") {
      try {
        const proxyOptions = await resolveConnectionProxyConfig(refreshedCredentials.providerSpecificData || {});
        const catalog = await resolveCodexModels(refreshedCredentials, {
          signal: request?.signal,
          log,
          proxyOptions,
          onCredentialsRefreshed: async (newCreds) => {
            await updateProviderCredentials(credentials.connectionId, {
              ...newCreds,
              existingProviderSpecificData: credentials.providerSpecificData,
            });
          },
        });
        const eligibility = codexCatalogSupportsRequest(catalog?.models, requestedModel || model, body);
        const catalogVerified = catalog?.access === "observed" || catalog?.access === "stale";
        const exactEffort = eligibility.requestedEffort && eligibility.requestedEffort !== "auto";
        if (!catalogVerified && (
          exactEffort
          || eligibility.contextMarker === "1m"
          || eligibility.reason === "unknown_effort"
          || (eligibility.reason === "model" && !isCodexFallbackModel(model))
        )) {
          codexCapabilityReasons.add("unverified catalog");
          // Discovery fallback is not entitlement evidence. Keep the account
          // routable for a known base request, but never authorize an exact
          // effort or infer that an unknown model is absent.
          excludeConnectionIds.add(credentials.connectionId);
          log.debug("CODEX_MODELS", `skip account ${credentials.connectionId} for ${model}: unverified catalog`);
          continue;
        }
        if (!eligibility.supported) {
          codexCapabilityReasons.add(eligibility.reason || "unsupported");
          // Catalog mismatch is not an upstream failure: skip this account without
          // creating a cooldown or poisoning its model lock state.
          excludeConnectionIds.add(credentials.connectionId);
          log.debug("CODEX_MODELS", `skip account ${credentials.connectionId} for ${model}: ${eligibility.reason}`);
          continue;
        }
        refreshedCredentials.codexModelMetadata = eligibility.metadata;
      } catch (error) {
        log.warn("CODEX_MODELS", `metadata lookup failed: ${error?.message || error}`);
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const resolvedEffectiveModel = effectiveModel || (modelInfo.providerAlias ? `${modelInfo.providerAlias}/${model}` : `${provider}/${model}`);
    const resolvedClientModel = clientModel || clientRawRequest?.body?.model || modelStr;
    const effectiveRouteReason = clientModel && clientModel !== modelStr && clientModel !== resolvedEffectiveModel
      ? routeReason
      : (modelStr.includes("/") ? "direct" : "model-alias");

    let attemptBody;
    try {
      attemptBody = structuredClone(body);
    } catch {
      attemptBody = JSON.parse(JSON.stringify(body));
    }
    attemptBody.model = `${provider}/${model}`;

    const result = await handleChatCore({
      body: attemptBody,
      modelInfo: { provider, providerAlias: modelInfo.providerAlias, model },
      credentials: refreshedCredentials,
      preResponse,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      routeReason: effectiveRouteReason,
      effectiveModel: resolvedEffectiveModel,
      routeContext: routeContext || createRouteContext({
        clientModel: resolvedClientModel,
        requestedProviderAlias: modelInfo.providerAlias,
        provider,
        requestedModel: model,
        effectiveModel: resolvedEffectiveModel,
        reason: effectiveRouteReason,
      }),
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      sessionDedupMode: chatSettings.sessionDedupMode || "off",
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      clientSignal: request?.signal || null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return withConnectionHeader(result.response, credentials.connectionId);

    const isBridgeCooldown = provider === "chatgpt-web"
      && (result.errorClass === "quota_exhausted" || result.errorClass === "rate_limited");
    if (isBridgeCooldown) {
      try {
        await markAccountUnavailable(
          credentials.connectionId,
          result.status,
          result.error,
          provider,
          model,
          result.resetsAtMs,
          result.errorClass,
        );
      } catch (error) {
        log.warn("AUTH", `Failed to record ChatGPT Web cooldown: ${error.message}`);
      }
    }
    if (result.terminalNoFallback) return withConnectionHeader(result.response, credentials.connectionId);

    // Antigravity quota/breaker evidence is persisted before account exclusion.
    let resetsAtMs = result.resetsAtMs;
    let errorClass = result.errorClass;
    const hasFutureHardQuota = errorClass === "quota_exhausted"
      && Number.isFinite(resetsAtMs)
      && resetsAtMs > Date.now();
    if (provider === "antigravity" && (result.status === 409 || result.status === 429) && !hasFutureHardQuota) {
      const evidence = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData,
        { sync: false }
      );
      if (evidence) {
        resetsAtMs = evidence.resetsAtMs;
        if (errorClass !== "quota_exhausted" || evidence.errorClass === "quota_exhausted") {
          errorClass = evidence.errorClass;
        }
      }
    }

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      resetsAtMs,
      errorClass,
    );

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return provider === "chatgpt-web"
      ? withConnectionHeader(result.response, credentials.connectionId)
      : result.response;
  }
}
