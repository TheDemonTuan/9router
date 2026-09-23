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
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { credentialUnavailableResponse, errorResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { detectClientTool } from "open-sse/utils/clientDetector.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";

import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  resolveCodexModels,
  codexCatalogSupportsRequest,
  isCodexFallbackModel,
} from "open-sse/services/codexModels.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  getChatGptWebCatalog,
} from "open-sse/services/chatgptWebBridge.js";
import {
  loadChatGptWebPinnedConnection,
  pinChatGptWebConnection,
  withChatGptWebConversationLock,
  resolveChatGptWebConversationKey,
} from "open-sse/utils/sessionManager.js";

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

function getChatGptWebConversationKey(clientRawRequest, body) {
  return resolveChatGptWebConversationKey({ headers: clientRawRequest?.headers, body });
}

function withConnectionHeader(response, connectionId) {
  if (!response || !connectionId) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-connection-id", String(connectionId));
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
function bridgeCapabilityForRequest(clientRawRequest, body) {
  return body?._compact === true || detectClientTool(clientRawRequest?.headers || {}, body) === "codex"
    ? "native_responses"
    : "generic_responses";
}

async function loadChatGptWebComboCapabilities(models, bridgeCapability = "generic_responses") {
  const bridgeModels = (Array.isArray(models) ? models : []).filter((value) => (
    typeof value === "string" && (value.startsWith("cgw/") || value.startsWith("chatgpt-web/"))
  ));
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
      for (const candidate of bridgeModels) {
        const rowId = candidate.startsWith("cgw/") ? candidate.slice(4) : candidate;
        const row = catalog.models?.find((entry) => entry.id === rowId);
        if (row?.capabilities?.[bridgeCapability] !== true) continue;
        if (!row?.capabilities || typeof row.capabilities !== "object") continue;
        const merged = capabilities.get(candidate) || {};
        for (const [key, value] of Object.entries(row.capabilities)) {
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
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
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
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);
  const bridgeCapability = bridgeCapabilityForRequest(clientRawRequest, body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
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
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      liveCapabilities,
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
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
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
      const requiredCapabilities = detectRequiredCapabilities(body);
      const bridgeCapability = bridgeCapabilityForRequest(clientRawRequest, body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      const liveCapabilities = await loadChatGptWebComboCapabilities(augmentedModels, bridgeCapability);

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        liveCapabilities,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  const requiredCapabilities = detectRequiredCapabilities(body);
  const bridgeCapability = bridgeCapabilityForRequest(clientRawRequest, body);
  const conversationKey = provider === "chatgpt-web"
    ? getChatGptWebConversationKey(clientRawRequest, body)
    : null;
  const explicitConnectionId = provider === "chatgpt-web"
    ? getChatGptWebExplicitConnectionId(clientRawRequest)
    : null;
  let pinnedConnectionId = explicitConnectionId;
  let lastError = null;
  let lastStatus = null;
  const codexCapabilityReasons = new Set();

  while (true) {
    const selectCredentials = async () => {
      if (provider === "chatgpt-web") {
        pinnedConnectionId = explicitConnectionId || await loadChatGptWebPinnedConnection(conversationKey);
      }
      const selected = await getProviderCredentials(provider, excludeConnectionIds, model, {
        requiredCapabilities,
        ...(pinnedConnectionId ? { pinConnectionId: pinnedConnectionId } : {}),
        ...(provider === "chatgpt-web" ? { bridgeCapability } : {}),
      });
      if (provider === "chatgpt-web" && conversationKey && selected?.connectionId) {
        await pinChatGptWebConnection(conversationKey, selected.connectionId);
      }
      return selected;
    };
    const credentials = provider === "chatgpt-web" && conversationKey
      ? await withChatGptWebConversationLock(conversationKey, selectCredentials)
      : await selectCredentials();

    if (credentials?.pinnedConnectionUnavailable) return bridgeContinuationError(pinnedConnectionId);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return credentialUnavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
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
        return errorResponse(status, `No Codex account supports ${model}${suffix}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

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
        const catalog = await resolveCodexModels(refreshedCredentials, {
          signal: request?.signal,
          log,
          onCredentialsRefreshed: async (newCreds) => {
            await updateProviderCredentials(credentials.connectionId, {
              ...newCreds,
              existingProviderSpecificData: credentials.providerSpecificData,
            });
          },
        });
        const eligibility = codexCatalogSupportsRequest(catalog?.models, model, body);
        const catalogVerified = catalog?.access === "observed" || catalog?.access === "stale";
        const exactEffort = eligibility.requestedEffort && eligibility.requestedEffort !== "auto";
        if (!catalogVerified && (
          exactEffort
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
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
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
      && (result.status === HTTP_STATUS.RATE_LIMITED
        || result.errorClass === "quota_exhausted"
        || result.errorClass === "rate_limited");
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
        refreshedCredentials.accessToken, credentials.providerSpecificData
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
      continue;
    }

    return provider === "chatgpt-web"
      ? withConnectionHeader(result.response, credentials.connectionId)
      : result.response;
  }
}
