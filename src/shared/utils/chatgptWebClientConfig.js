import { isCanonicalCgwModel, REASONING_LEVELS } from "../../../services/chatgpt-web-runtime/protocol.js";

const PROVIDER_ID = "9router-cgw";
const CLIENT_ID = "my-codex-client";
const KEY_ID = "my-codex-ed25519";
const CLIENT_DIRECTORY = "/absolute/path/to/9router-cgw-client";

// These snippets are data, not HTML. Escaping also keeps them safe if embedded in a script later.
function serialize(value) {
  return JSON.stringify(value, null, 2).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function gatewayOrigin(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) {
    throw new TypeError("Use a root HTTPS API origin (HTTP is only supported on loopback)");
  }
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Invalid API origin"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
    throw new TypeError("Use a root HTTPS API origin (HTTP is only supported on loopback)");
  }
  return url.origin;
}

function catalogSelection(row, requestedEffort) {
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string"
    || !row.id.startsWith("chatgpt-web/") || !isCanonicalCgwModel(`cgw/${row.id}`) || row.legacy === true) {
    throw new TypeError("Select an exact verified ChatGPT Web catalog model");
  }
  const levels = row.supported_reasoning_levels;
  if (!Array.isArray(levels) || !levels.length || levels.some(level => !REASONING_LEVELS.includes(level) || level === "ultra")
    || new Set(levels).size !== levels.length || !levels.includes(row.default_reasoning_level)) {
    throw new TypeError("Verified catalog reasoning levels are required");
  }
  const effort = requestedEffort === undefined ? row.default_reasoning_level : requestedEffort;
  if (!levels.includes(effort)) throw new TypeError("Select a reasoning effort verified for this model");
  if (!Number.isSafeInteger(row.context_window) || row.context_window <= 0
    || row.max_output !== undefined && (!Number.isSafeInteger(row.max_output) || row.max_output <= 0)
    || row.auto_compact_token_limit !== undefined && (!Number.isSafeInteger(row.auto_compact_token_limit)
      || row.auto_compact_token_limit <= 0 || row.auto_compact_token_limit > row.context_window)) {
    throw new TypeError("Verified catalog context limits are required");
  }
  return { modelId: `cgw/${row.id}`, effort };
}

/**
 * Pure, opt-in client templates for one catalog row. This does not verify a client,
 * provision keys, enable Full, execute tools, or write any client configuration.
 * apiOrigin is the dashboard's gateway origin, not the runtime or its /v1 URL.
 */
export function buildChatGptWebClientConfig(catalogRow, apiOrigin, reasoningEffort) {
  const origin = gatewayOrigin(apiOrigin);
  const { modelId, effort } = catalogSelection(catalogRow, reasoningEffort);
  const apiBaseUrl = `${origin}/v1`;
  // OpenCode requires both limit fields. Zero selects its client-side output
  // accounting default when the catalog has no verified output limit; the hook
  // still removes maxOutputTokens, so this never invents a provider wire limit.
  const limit = { context: catalogRow.context_window, output: catalogRow.max_output ?? 0 };
  const openCodeConfig = serialize({
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${modelId}`,
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "9Router ChatGPT Web",
        options: { baseURL: apiBaseUrl, apiKey: "{env:NINE_ROUTER_API_KEY}" },
        models: {
          [modelId]: {
            name: typeof catalogRow.display_name === "string" ? catalogRow.display_name : catalogRow.id,
            limit,
          },
        },
      },
    },
  });
  // Only the validated effort enum enters this program, through JSON serialization.
  // chat.params options are unnested: OpenCode applies the provider namespace itself.
  const openCodePlugin = [
    "// Save as .opencode/plugins/9router-cgw.js in the opted-in project.",
    "// ChatGPT Web does not support client sampling or output-token tuning.",
    "// This hook changes no other provider and never changes tool permissions.",
    `const selectedEffort = ${serialize(effort)};`,
    "export const NineRouterChatGptWeb = async () => ({",
    '  "chat.params": async (input, output) => {',
    `    if (input.model.providerID !== ${serialize(PROVIDER_ID)}) return;`,
    "    output.maxOutputTokens = undefined;",
    "    output.temperature = undefined;",
    "    output.topP = undefined;",
    "    output.topK = undefined;",
    "    // The compatible SDK derives wire reasoning_effort from reasoningEffort after raw options.",
    "    output.options = { ...output.options, reasoningEffort: selectedEffort, reasoning_effort: selectedEffort };",
    "  },",
    "});",
    "",
  ].join("\n");
  const companionConfig = serialize({
    gatewayUrl: origin,
    apiKeyFile: `${CLIENT_DIRECTORY}/9router-api-key.txt`,
    privateKeyFile: `${CLIENT_DIRECTORY}/client-private.pem`,
    keyId: KEY_ID,
    clientId: CLIENT_ID,
    codexHome: "/absolute/path/to/codex-home",
    listenPort: 17840,
  });
  const clientKeysConfig = serialize({
    version: 1,
    clients: [{
      clientId: CLIENT_ID,
      keyId: KEY_ID,
      publicKeyPem: "REPLACE_WITH_PUBLIC_PEM_FROM_CLIENT_PUBLIC_FILE",
      enabled: true,
    }],
  });
  const nativeConfig = [
    "# Copy into your chosen Codex config.toml; do not overwrite existing config/auth files.",
    "# Requires an operator-provisioned public key and the running signed companion.",
    "# Client tool execution: not verified here. Native collaboration: compatibility-v1.",
    'model_provider = "openai"',
    'openai_base_url = "http://127.0.0.1:17840/v1"',
    `model = ${serialize(modelId)}`,
    `model_reasoning_effort = ${serialize(effort)}`,
    `model_context_window = ${catalogRow.context_window}`,
    ...(catalogRow.auto_compact_token_limit !== undefined
      ? [`model_auto_compact_token_limit = ${catalogRow.auto_compact_token_limit}`] : []),
    '[features]',
    'multi_agent = true',
    'multi_agent_v2 = false',
    '[agents]',
    'max_depth = 2',
    '',
  ].join("\n");
  const modelDisplayName = typeof catalogRow.display_name === "string" ? catalogRow.display_name : catalogRow.id;
  const ompConfig = [
    "# Add under providers: in ~/.omp/agent/models.yml (or your models.yaml)",
    "providers:",
    `  ${PROVIDER_ID}:`,
    `    baseUrl: ${serialize(apiBaseUrl)}`,
    '    api: "openai-completions"',
    '    apiKey: "NINE_ROUTER_API_KEY"',
    '    headers:',
    '      x-9router-token-saver: "off"',
    '    models:',
    `      - id: ${serialize(modelId)}`,
    `        name: ${serialize(modelDisplayName)}`,
    '        input:',
    '          - "text"',
    `        contextWindow: ${catalogRow.context_window}`,
    ...(Number.isSafeInteger(catalogRow.max_output) && catalogRow.max_output > 0
      ? [`        maxTokens: ${catalogRow.max_output}`]
      : []),
    '        omitMaxOutputTokens: true',
    '        reasoning: true',
    '        thinking:',
    '          mode: "effort"',
    `          efforts: [${catalogRow.supported_reasoning_levels.map(serialize).join(", ")}]`,
    `          defaultLevel: ${serialize(effort)}`,
    '          requiresEffort: true',
    '        compat:',
    '          supportsStore: true',
    '          supportsSamplingParams: false',
    '          supportsReasoningEffort: true',
    '          thinkingFormat: "openai"',
    '',
  ].join("\n");
  const ompCommand = `omp --model '${PROVIDER_ID}/${modelId}' --thinking '${effort}'`;
  const ompInstructions = [
    "Set NINE_ROUTER_API_KEY in your environment; no API key is included in configuration or command arguments.",
    "Merge under the existing providers root in ~/.omp/agent/models.yml, or edit models.yaml if that is your active file. If 9router-cgw exists, merge the model by id. Preserve all other providers and models; do not overwrite your configuration.",
    "Start omp with the generated command. Sampling/output-token omission is native to this configuration; no extension is required. Tools and approvals remain controlled by omp."
  ].join("\n");
  return {
    apiBaseUrl,
    modelId,
    openCodeConfig,
    openCodePlugin,
    nativeConfig,
    companionConfig,
    keygenCommand: `bun run companion:keygen ${CLIENT_DIRECTORY}/client-private.pem ${CLIENT_DIRECTORY}/client-public.pem`,
    companionCommand: `CGW_COMPANION_CONFIG_FILE=${CLIENT_DIRECTORY}/companion.json bun run companion`,
    interruptCommand: `CGW_COMPANION_CONFIG_FILE=${CLIENT_DIRECTORY}/companion.json bun run companion:interrupt --thread-id '<thread-id>' --turn-id '<turn-id>'`,
    clientKeysConfig,
    ompConfig,
    ompCommand,
    ompInstructions,
    nativeInstructions: [
      "Run these commands from services/chatgpt-web-runtime on the Codex client machine, not on the gateway.",
      "1. Replace all absolute path placeholders, then generate the Ed25519 key pair. Keep the private PEM and 9Router API-key file client-local with owner-only permissions; never upload them.",
      "2. Through a separate authenticated operator channel, provision only the generated public PEM in CHATGPT_WEB_CLIENT_KEYS_FILE. Use matching clientId/keyId in the companion and operator file; merge the client entry without replacing other clients. Generic OpenAI-compatible agents do not need this native step.",
      "3. Save the companion JSON locally, start the companion, then explicitly copy the Codex TOML snippet. Do not rewrite config.toml or auth.json automatically. The companion reads the actual local codexHome rollouts; the dashboard cannot verify local tool execution.",
    ].join("\n"),
    openCodeInstructions: [
      "Merge this provider into the project's opencode.json and explicitly save the plugin at .opencode/plugins/9router-cgw.js. Supply the 9Router API key through NINE_ROUTER_API_KEY; no actual key is included here.",
      "The plugin opts only 9router-cgw out of unsupported sampling/output controls; it does not bypass gateway validation or change client tool approvals. Keep normal client permissions.",
      "Generic rounds send full history with a fresh temporary browser turn. Tools are standard function-call proposals for the client to approve and execute; the runtime does not run shell/filesystem tools. Native retention/compaction, images, and automatic browser features are not promised for generic clients.",
      "Full readiness and the installed router_submit_tool_calls action are required for coding tools. Refresh/review/publish connector actions if Codex Native2 was installed before that action was added. Zero-Send connector verification is not proof of a live client tool loop.",
    ].join("\n"),
  };
}
