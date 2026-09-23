import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels, getProviderConnections } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { isAlitpModelDeprecated, isAlitpModelAvailableForEdition } from "open-sse/providers/alibabaTokenPlanCatalog.js";
import {
  getChatGptWebCatalog,
} from "open-sse/services/chatgptWebBridge.js";
import { resolveEffectiveCodexCatalog } from "open-sse/services/codexModels.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        // Legacy preview alias remains routable for existing configs but is
        // never surfaced by any catalog endpoint or dashboard picker.
        if (m.provider === "alitp-intl" && (
          isAlitpModelDeprecated(m.model) ||
          !isAlitpModelAvailableForEdition(m.model, "personal")
        )) return false;
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    const bridgeConnections = await getProviderConnections({ provider: "chatgpt-web", isActive: true });
    const bridgeModels = new Map();
    for (const connection of bridgeConnections) {
      try {
        const catalog = await getChatGptWebCatalog(connection);
        if (catalog.stale) continue;
        for (const model of catalog.models) {
          const caps = model.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
          if (caps.native_responses !== true && caps.generic_responses !== true) continue;
          const existing = bridgeModels.get(model.id);
          bridgeModels.set(model.id, existing ? {
            ...existing,
            capabilities: Object.fromEntries(Object.keys({ ...existing.capabilities, ...caps }).map((key) => [
              key,
              existing.capabilities?.[key] === true || caps[key] === true,
            ])),
          } : { ...model, capabilities: caps });
        }
      } catch { /* Offline bridges advertise no models. */ }
    }
    const bridgeDisabled = disabled.cgw || disabled["chatgpt-web"] || [];
    for (const model of bridgeModels.values()) {
      if (bridgeDisabled.includes(model.id)) continue;
      const fullModel = model.id.startsWith("chatgpt-web/")
        ? model.id
        : `chatgpt-web/${model.id}`;
      const routedModel = `cgw/${model.id}`;
      models.push({
        provider: "chatgpt-web",
        model: model.id,
        name: model.name || model.id,
        fullModel,
        routedModel,
        alias: modelAliases[fullModel] || model.id,
        caps: {
          vision: model.capabilities?.vision === true,
          search: false,
          // Unknown live capabilities stay unknown; never infer support from omission.
          reasoning: model.capabilities?.reasoning === true,
          contextWindow: model.context_window || null,
          maxOutput: model.max_output || null,
          tools: model.capabilities?.tools === true,
          managedThinking: true,
        },
      });
    }

    const codexConnections = await getProviderConnections({ provider: "codex", isActive: true });
    if (codexConnections.length > 0) {
      const effective = await resolveEffectiveCodexCatalog(codexConnections, {
        onCredentialsRefreshed: async (connection, refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });
      if (effective.resolved) {
        for (let index = models.length - 1; index >= 0; index -= 1) {
          if (models[index].provider === "cx") models.splice(index, 1);
        }
        const disabledCodex = new Set([
          ...(Array.isArray(disabled.cx) ? disabled.cx : []),
          ...(Array.isArray(disabled.codex) ? disabled.codex : []),
        ]);
        const catalog = (effective.models || []).filter((model) => !disabledCodex.has(model.id));
        for (const model of catalog) {
          const liveCaps = model.capabilities && typeof model.capabilities === "object" && !Array.isArray(model.capabilities)
            ? model.capabilities
            : {};
          const caps = { ...liveCaps };
          const contextWindow = model.contextLength ?? caps.contextWindow ?? null;
          const maxOutput = model.maxOutputTokens ?? caps.maxOutput ?? null;
          models.push({
            provider: "cx",
            model: model.id,
            name: model.name || model.id,
            description: model.description,
            fullModel: `cx/${model.id}`,
            routedModel: `cx/${model.id}`,
            alias: modelAliases[`cx/${model.id}`] || modelAliases[`codex/${model.id}`] || model.id,
            caps: {
              vision: caps.vision ?? false,
              search: caps.search ?? false,
              reasoning: caps.reasoning ?? false,
              contextWindow,
              maxOutput,
              ...(model.maxContextLength ? { maxContextLength: model.maxContextLength } : {}),
              ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}),
              ...(Array.isArray(model.outputModalities) ? { outputModalities: model.outputModalities } : {}),
              ...(model.minimalClientVersion ? { minimalClientVersion: model.minimalClientVersion } : {}),
              ...(model.priority !== undefined ? { priority: model.priority } : {}),
              ...(model.defaultReasoningLevel ? { defaultReasoningLevel: model.defaultReasoningLevel } : {}),
              ...(Array.isArray(model.supportedReasoningLevels)
                ? { supportedReasoningLevels: model.supportedReasoningLevels }
                : {}),
            },
          });
        }
      }
    }

    // Custom models ride along; their stored caps override the name heuristic
    const seenFull = new Set(models.map((m) => m.fullModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      return !seenFull.has(`${m.providerAlias}/${m.id}`);
    });
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const c = getCapabilitiesForModel(m.providerAlias, m.id);
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
          ...(m.caps || {}),
        },
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
