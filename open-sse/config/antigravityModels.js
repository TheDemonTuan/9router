export const ANTIGRAVITY_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_MODEL_FETCH_TIMEOUT_MS = 10 * 1000;
export const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 64000;
export const ANTIGRAVITY_DISCOVERY_FALLBACK_VERSION = "2.19.1";
export const ANTIGRAVITY_VERSION_MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
export const ANTIGRAVITY_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
export const ANTIGRAVITY_VERSION_RETRY_MS = 10 * 60 * 1000;
export const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5 * 1000;
export const ANTIGRAVITY_DISCOVERY_USER_AGENT_SUFFIX = " (aidev_client; os_type=darwin; arch=arm64; cl=963137146)";

export const ANTIGRAVITY_INTERNAL_MODEL_IDS = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

export const NON_CHAT_MODALITY_RE = /(?:^|[-_])(image|imagen|audio|tts|embedding|embed|video|veo)(?:[-_]|$)/i;
