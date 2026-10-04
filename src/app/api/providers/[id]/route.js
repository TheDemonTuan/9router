import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { invalidateChatGptWebCatalog, validateChatGptWebProfileId } from "open-sse/services/chatgptWebRuntimeClient.js";
import { authorizeChatGptWebRuntimeAdmin } from "@/dashboardGuard";
import { ensureChatGptWebRuntimeProfile } from "@/lib/chatgptWebProfileProvisioning";
import { normalizeProviderSpecificData, sanitizeProviderSpecificData, validateChatGptWebConnectionInput } from "@/lib/providerNormalization";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Hide sensitive fields
    const result = { ...connection };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;
    result.providerSpecificData = connection.provider === "chatgpt-web" ? { profileId: connection.providerSpecificData?.profileId } : sanitizeProviderSpecificData(result.providerSpecificData);

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    let normalizedProviderSpecificData = providerSpecificData;
    let profileChanged = false;
    if (existing.provider === "chatgpt-web") {
      try {
        validateChatGptWebConnectionInput(body);
        const selector = providerSpecificData === undefined && body.profileId === undefined ? existing.providerSpecificData : normalizeProviderSpecificData(existing.provider, body, providerSpecificData);
        normalizedProviderSpecificData = { profileId: validateChatGptWebProfileId(selector?.profileId) };
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      profileChanged = normalizedProviderSpecificData.profileId !== existing.providerSpecificData?.profileId;
      if (profileChanged) {
        if (!await authorizeChatGptWebRuntimeAdmin(request)) {
          return NextResponse.json({ error: "Dashboard authentication required" }, { status: 401 });
        }
        try {
          await ensureChatGptWebRuntimeProfile(normalizedProviderSpecificData.profileId, request.signal);
        } catch {
          return NextResponse.json({ error: "Runtime unavailable or profile creation failed. The connection was not changed; the request was not retried." }, { status: 502 });
        }
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (existing.provider === "chatgpt-web") {
      if (profileChanged) updateData.testStatus = "login_required";
    } else if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        normalizedProviderSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField
      )
    ) {
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...(normalizedProviderSpecificData || {}),
      };

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }
    if (existing.provider === "chatgpt-web") updateData.providerSpecificData = normalizedProviderSpecificData;

    const updated = await updateProviderConnection(id, updateData);
    if (existing.provider === "chatgpt-web") {
      invalidateChatGptWebCatalog(existing.providerSpecificData?.profileId);
      if (updated.providerSpecificData?.profileId !== existing.providerSpecificData?.profileId) invalidateChatGptWebCatalog(updated.providerSpecificData?.profileId);
    }

    // Hide sensitive fields
    const result = { ...updated };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;
    result.providerSpecificData = sanitizeProviderSpecificData(result.providerSpecificData);

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getProviderConnectionById(id);
    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (existing?.provider === "chatgpt-web") invalidateChatGptWebCatalog(existing.providerSpecificData?.profileId);

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}
