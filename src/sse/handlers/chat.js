import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
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
import { createTimingContext } from "../utils/timingContext.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";

import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  resolveCodexModels,
  codexCatalogSupportsRequest,
  isCodexFallbackModel,
} from "open-sse/services/codexModels.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveSmartChoice, getSmartComboSessionId } from "../services/systemoneRouter.js";

function withConnectionHeader(response, connectionId) {
  if (!response || !connectionId) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-connection-id", String(connectionId));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, options = {}) {
  const preResponse = options?.preResponse || clientRawRequest?.preResponse || request?.preResponse || null;
  const timingContext = options?.timingContext || options?.timing || request?.timingContext || createTimingContext();
  if (request && !request.timingContext) request.timingContext = timingContext;
  let body;
  try {
    body = await request.json();
    timingContext.mark("bodyParsed");
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (options.operation === "compact") body = { ...body, _compact: true };


  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
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

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;
  timingContext.mark("authChecked");

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

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
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { preResponse,
          clientModel: modelStr,
          effectiveModel: m,
          routeReason: "combo",
          timingContext,
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
    const sessionId = getSmartComboSessionId(request, clientRawRequest?.headers, body);
    const comboCfg = comboStrategies[modelStr] || {};
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { preResponse,
        clientModel: modelStr,
        effectiveModel: m,
        routeReason: "combo",
        timingContext,
        ...meta }),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      preResponse,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
            preResponse,
            keyAccess,
          })
        : null,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { preResponse,
        clientModel: modelStr,
        effectiveModel: m,
        routeReason: m !== modelStr ? "capacity-adapter" : "direct",
        timingContext,
        ...meta }),
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      preResponse,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { preResponse,
    clientModel: modelStr, effectiveModel: modelStr, requestedModel: requestedModelStr,
    routeReason: "direct", timingContext });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, { preResponse = null, clientModel = null, effectiveModel = null, routeReason = "direct", routeContext = null, requestedModel = null, timingContext = null } = {}) {
  timingContext = timingContext || request?.timingContext || createTimingContext();
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
      const requiredCapabilities = detectRequiredCapabilities(body);
      // The outer combo grants its members, not gateway-injected adapter targets.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

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
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, { preResponse,
            clientModel: modelStr,
            effectiveModel: m,
            routeReason: "combo",
            timingContext,
            ...meta });
          },
          log,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          preResponse,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSessionId = getSmartComboSessionId(request, clientRawRequest?.headers, body);
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
        (b, m, meta = {}) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, { preResponse,
        clientModel: modelStr,
        effectiveModel: m,
        routeReason: "combo",
        timingContext,
        ...meta }),
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        preResponse,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
              preResponse,
              keyAccess,
            })
          : null,
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
  let lastError = null;
  let lastStatus = null;
  const codexCapabilityReasons = new Set();
  let lastHeaders = null;

  while (true) {
    if (preResponse && (preResponse.remainingMs() <= 0 || preResponse.signal?.aborted)) {
      throw (preResponse.signal?.reason || createDeadlineError());
    }
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      requestedModel,
      requiredCapabilities,
    });
    timingContext.mark("accountSelected");

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
        return errorResponse(status, `No Codex account supports ${model}${suffix}`, lastHeaders);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    timingContext.mark("tokenRefreshed");

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
      timingContext,
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
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
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

    if (result.success || result.terminalNoFallback) return withConnectionHeader(result.response, credentials.connectionId);

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

    return result.response;
  }
}
