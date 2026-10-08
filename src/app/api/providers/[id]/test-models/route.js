import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";
import { getChatGptWebCatalog } from "open-sse/services/chatgptWebRuntimeClient.js";
import { chatGptWebDiagnostic } from "@/lib/chatgptWebConnectionState.js";

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId; ChatGPT Web tests are exclusively pinned to this account.
 * Actual requests go through the internal endpoint that matches each model kind.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);
    if (providerId === "chatgpt-web") {
      if (connection.isActive === false) return NextResponse.json({ error: { code: "connection_unavailable", message: "Selected connection is disabled" } }, { status: 400 });
      try {
        const catalog = await getChatGptWebCatalog(connection, { force: true, signal: request.signal });
        if (catalog.stale || !catalog.models?.length) throw Object.assign(new Error(), { code: "model_version_unavailable" });
        models = catalog.models.map(row => ({ id: row.id, name: row.display_name || row.id, generic: row.capabilities?.generic_responses === true }));
      } catch (error) {
        const safe = chatGptWebDiagnostic(error?.code || "runtime_unavailable");
        return NextResponse.json({ error: safe }, { status: [400, 401, 404, 409, 503].includes(error?.status) ? error.status : 503 });
      }
    }

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Dynamic compatible and bridge providers expose their model catalog through the internal route.
    if (isCompatible && models.length === 0) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fallback to empty */ }
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }

    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    // This prevents race condition where multiple requests concurrently refresh the same token.
    const [first, ...rest] = models;
    const options = { ...(providerId === "chatgpt-web" ? { connectionId: id } : {}), signal: request.signal };
    const probe = model => providerId === "chatgpt-web" && !model.generic
      ? Promise.resolve({ ok: false, status: 400, latencyMs: 0, error: "No verified generic text route is available; verify the saved session and runtime prerequisites before sending a model test" })
      : pingModelByKind(`${alias}/${model.id}`, model.kind || model.type || "llm", baseUrl, options);
    const firstResult = await probe(first);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      const restResults = await Promise.all(
        rest.map(async (model) => {
          const result = await probe(model);
          return { modelId: model.id, name: model.name || model.id, ...result };
        })
      );
      results.push(...restResults);
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
