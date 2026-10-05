export const ANTIGRAVITY_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_MODEL_FETCH_TIMEOUT_MS = 10 * 1000;
export const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 64000;

export const ANTIGRAVITY_INTERNAL_MODEL_IDS = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

export const NON_CHAT_MODALITY_RE = /(?:^|[-_])(image|imagen|audio|tts|embedding|embed|video|veo)(?:[-_]|$)/i;
