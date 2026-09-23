import { withCodexReviewModels } from "../models/helpers.js";
import { CODEX_CLIENT_VERSION } from "../../config/codexClient.js";

// Codex CLI version seen by OpenAI's backend. Keep the value in codexClient.js
// so model discovery and request identity cannot drift apart.
const CODEX_CLI_VERSION = CODEX_CLIENT_VERSION;

export default {
  id: "codex",
  priority: 30,
  alias: "cx",
  uiAlias: "cx",
  display: {
    name: "OpenAI Codex",
    icon: "code",
    color: "#3B82F6",
    website: "https://chatgpt.com/codex",
    notice: {
      signupUrl: "https://chatgpt.com/codex",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
    kindNotice: {
      image: "Requires a ChatGPT Plus (or higher) account. Free accounts are not supported for image generation.",
    },
  },
  category: "oauth",
  thinkingConfig: {
    options: [
      "auto",
      "none",
      "low",
      "medium",
      "high",
    ],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
    cliVersion: CODEX_CLI_VERSION,
    headers: {
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
    },
    usage: {
      url: "https://chatgpt.com/backend-api/wham/usage",
      resetCreditsUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      resetCreditsConsumeUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    },
  },
  models: [
    {
      id: "gpt-6-astra",
      name: "GPT-6-Astra",
      description: "Frontier intelligence for the most demanding work.",
      minimalClientVersion: "0.153.0",
      contextLength: 272000,
      maxContextLength: 872000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6-sol",
      name: "GPT-6-Sol",
      minimalClientVersion: "0.155.0",
      contextLength: 272000,
      maxContextLength: 872000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6-luna",
      name: "GPT-6-Luna",
      minimalClientVersion: "0.155.0",
      contextLength: 272000,
      maxContextLength: 872000,
      supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    // Codex CLI's auto-review virtual model. Unlike the "-review" variants above it is not derived
    // from a base model, so it is forwarded verbatim instead of having "-review" stripped (#1398).
    { id: "codex-auto-review", name: "Codex Auto Review", upstreamModelId: "codex-auto-review", quotaFamily: "review" },
    { id: "gpt-image-2.5", name: "GPT Image 2.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2", name: "GPT Image 2", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-1.5", name: "GPT Image 1.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-sol-image", name: "GPT 5.6 Sol Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-terra-image", name: "GPT 5.6 Terra Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.6-luna-image", name: "GPT 5.6 Luna Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.5-image", name: "GPT 5.5 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.4-image", name: "GPT 5.4 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-5.3-image", name: "GPT 5.3 Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
  ],
  serviceKinds: ["llm","image"],
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    refreshLeadMs: 432000000,
    refresh: {
      encoding: "form",
      scope: "openid profile email offline_access",
    },
    maxRefreshAgeMs: 691200000,
    trackRefreshAt: true,
  },
  features: {
    usage: true,
  },
};
