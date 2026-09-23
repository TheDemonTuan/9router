import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { getProviderConnections } from "@/lib/localDb";
import { resolveCodexModels } from "open-sse/services/codexModels.js";
import { getAdvertisedThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo, variantSuffix = null }) {
  const modelId = variantSuffix ? `${model.id}(${variantSuffix})` : model.id;
  const out = {
    id: `${alias}/${modelId}`,
    name: variantSuffix ? `${model.name || model.id} (${variantSuffix})` : (model.name || model.id),
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (variantSuffix) {
    out.base_model = `${alias}/${model.id}`;
    out.reasoning_effort = variantSuffix;
    out.virtual = true;
  }
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  const contextLength = model.contextLength || model.contextWindow;
  if (contextLength) out.contextWindow = contextLength;
  const maxOutput = model.maxOutputTokens || model.maxOutput;
  if (maxOutput) out.maxOutput = maxOutput;
  if (model.defaultReasoningLevel) out.defaultReasoningLevel = model.defaultReasoningLevel;
  if (model.supportedReasoningLevels) out.supportedReasoningLevels = model.supportedReasoningLevels;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId
// requestedKind: optional, disambiguates duplicate ids across kinds (e.g. gemini-2.5-pro llm vs stt)
function lookup(fullId, requestedKind, codexCatalog = null) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const rawModelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  const parenMatch = rawModelId.match(/^(.*)\(([^()]+)\)\s*$/);
  const baseModelId = parenMatch ? parenMatch[1].trim() : rawModelId;
  const variantSuffix = parenMatch ? parenMatch[2].trim().toLowerCase() : null;

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = (providerId === "codex" && codexCatalog)
    ? codexCatalog
    : (PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || []);

  const m = requestedKind
    ? list.find((x) => x.id === baseModelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === baseModelId);
  if (m) {
    if (m.visibility === "hide" || m.supported_in_api === false || m.supportedInApi === false) {
      return null;
    }
    const kind = getModelKind(m, "llm");
    if (variantSuffix) {
      if (!providerInfo?.exposeThinkingVariants) return null;
      const levels = getAdvertisedThinkingLevels(providerId, m.id, m);
      if (!levels || !levels.includes(variantSuffix)) return null;
      return buildInfo({ alias, providerId, model: m, kind, providerInfo, variantSuffix });
    }
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (rawModelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (rawModelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }
  return null;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  let codexCatalog = null;
  const slash = id.indexOf("/");
  const alias = slash > 0 ? id.slice(0, slash) : id;
  const providerId = ALIAS_TO_ID[alias] || alias;
  if (providerId === "codex") {
    try {
      const connections = await getProviderConnections({ provider: "codex", isActive: true });
      if (connections.length > 0) {
        const resolved = await resolveCodexModels(connections[0]);
        if (resolved?.models?.length) codexCatalog = resolved.models;
      }
    } catch {
      // fall back to static
    }
  }

  const info = lookup(id, kind, codexCatalog);
  if (!info) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
