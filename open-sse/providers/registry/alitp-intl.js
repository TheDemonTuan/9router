import { CLAUDE_API_HEADERS } from "../shared.js";
import { ALITP_MODELS, ALITP_DISCOVERY, resolveAlitpCatalogEntry } from "../alibabaTokenPlanCatalog.js";

// Token Plan — credit subscription keys on token-plan.<region>.maas.aliyuncs.com.
// Multi-transport endpoints: OpenAI Chat, Responses, and Anthropic Messages.
// Config only: model membership/limits/thinking contracts live in
// alibabaTokenPlanCatalog.js (single source of truth), discovery in
// open-sse/services/alibabaTokenPlanModels.js.
export default {
  id: "alitp-intl",
  priority: 11,
  alias: "alitp-intl",
  exposeThinkingVariants: true,
  modelDiscovery: ALITP_DISCOVERY,
  display: {
    name: "Alibaba Token Plan",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ATP",
    website: "https://www.alibabacloud.com/campaign/ai-landing-page-token",
    notice: {
      apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    headers: {},
    quirks: { preserveCacheControl: true },
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "openai-responses",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  // Fallback catalog (routable set). Live discovery can extend it at runtime;
  // deprecated aliases stay routable but are filtered out of discovery results.
  models: ALITP_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.upstreamId ? { upstreamModelId: m.upstreamId } : {}),
    ...(m.deprecated ? { deprecated: true } : {}),
    ...(resolveAlitpCatalogEntry(m.id)?.formats ? { supportedFormats: resolveAlitpCatalogEntry(m.id).formats } : {}),
  })),
};
