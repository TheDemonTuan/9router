import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
  getProxyPoolById,
} from "@/models";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, LOCAL_BRIDGE_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData, sanitizeProviderSpecificData, validateChatGptWebConnectionInput } from "@/lib/providerNormalization";
import { validateChatGptWebProfileId } from "open-sse/services/chatgptWebRuntimeClient.js";
import { authorizeChatGptWebRuntimeAdmin } from "@/dashboardGuard";
import { ensureChatGptWebRuntimeProfile } from "@/lib/chatgptWebProfileProvisioning";
import { getChatGptWebProfileStates, applyChatGptWebProfileState, chatGptWebUnavailableProfileState } from "@/lib/chatgptWebConnectionState";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null || proxyPoolId === "" || proxyPoolId === "__none__") {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) {
    return { proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) {
    return { error: "Proxy pool not found" };
  }

  return { proxyPoolId: normalizedId };
}

// GET /api/providers - List all connections
export async function GET(request) {
  try {
    const connections = await getProviderConnections();
    let profileStates;
    let runtimeUnavailable = false;
    if (connections.some(connection => connection.provider === "chatgpt-web")) {
      try { profileStates = await getChatGptWebProfileStates({ signal: request?.signal }); }
      catch { runtimeUnavailable = true; }
    }

    // Build nodeNameMap for compatible providers (id → name)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch { }

    // Hide sensitive fields, enrich name for compatible providers
    const safeConnections = connections.map(c => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? (c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      const safe = {
        ...c,
        name,
        providerSpecificData: c.provider === "chatgpt-web" ? { profileId: c.providerSpecificData?.profileId } : sanitizeProviderSpecificData(c.providerSpecificData),
      };
      if (c.provider === "chatgpt-web") {
        Object.assign(safe, applyChatGptWebProfileState(safe, runtimeUnavailable
          ? chatGptWebUnavailableProfileState()
          : profileStates.get(c.providerSpecificData?.profileId)));
      }
      delete safe.apiKey;
      delete safe.accessToken;
      delete safe.refreshToken;
      delete safe.idToken;
      return safe;
    });

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    if (provider === "chatgpt-web") {
      if (!await authorizeChatGptWebRuntimeAdmin(request)) {
        return NextResponse.json({ error: "Dashboard authentication required" }, { status: 401 });
      }
      try { validateChatGptWebConnectionInput(body); }
      catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    }
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolId(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }
    const proxyPoolId = proxyPoolResult.proxyPoolId;

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    const isLocalBridgeProvider = !!LOCAL_BRIDGE_PROVIDERS[provider];
    // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
    // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isWebCookieProvider ||
      isLocalBridgeProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!apiKey && provider !== "ollama-local" && !isLocalBridgeProvider) {
      return NextResponse.json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required` }, { status: 400 });
    }
    const connectionName = name || displayName || AI_PROVIDERS[provider]?.name;
    if (!connectionName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let providerSpecificData = normalizeProviderSpecificData(provider, body, body.providerSpecificData);
    if (isLocalBridgeProvider) {
      try {
        const selector = providerSpecificData?.profileId;
        providerSpecificData = { profileId: validateChatGptWebProfileId(selector === undefined ? `cgw-${randomUUID()}` : selector) };
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    // Compatible LLM nodes support multiple API-key connections (key pool); runtime
    // rotates/fails over via getProviderCredentials. Embedding nodes stay single-connection.
    if (isOpenAICompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isAnthropicCompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isCustomEmbeddingProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    }

    const mergedProviderSpecificData = provider === "chatgpt-web" ? providerSpecificData : {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };

    if (proxyPoolId !== null) {
      mergedProviderSpecificData.proxyPoolId = proxyPoolId;
    }
    if (provider === "chatgpt-web") {
      // Bridge connections are not name-deduplicated by the repository. Refuse
      // an accidental duplicate before allocating a persistent browser profile.
      const existing = (await getProviderConnections({ provider })).find(item => item.name === connectionName);
      if (existing) {
        return NextResponse.json({ error: `A ChatGPT Web connection named "${connectionName}" already exists. Edit the existing connection instead.`, code: "PROVIDER_NAME_CONFLICT", existingId: existing.id, existingName: existing.name }, { status: 409 });
      }
      try {
        await ensureChatGptWebRuntimeProfile(providerSpecificData.profileId, request.signal);
      } catch {
        return NextResponse.json({ error: "Runtime unavailable or profile creation failed. No connection was saved; the request was not retried." }, { status: 502 });
      }
    }

    const newConnection = await createProviderConnection({
      provider,
      authType: isLocalBridgeProvider ? "bridge" : isWebCookieProvider ? "cookie" : "apikey",
      name: connectionName,
      apiKey: apiKey || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData: mergedProviderSpecificData,
      isActive: true,
      testStatus: provider === "chatgpt-web" ? "login_required" : testStatus || "unknown",
      // POST with an id is an explicit edit of that connection; without one, a
      // name collision is refused rather than silently overwriting a key. #4311
      allowOverwrite: body.id ? true : (body.allowOverwrite === true || body.overwrite === true),
    });

    // Hide sensitive fields
    const result = { ...newConnection };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;
    result.providerSpecificData = provider === "chatgpt-web" ? { profileId: result.providerSpecificData?.profileId } : sanitizeProviderSpecificData(result.providerSpecificData);

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch (error) {
    if (error?.code === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: error.message, code: error.code, existingId: error.existingId, existingName: error.existingName },
        { status: 409 }
      );
    }
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
