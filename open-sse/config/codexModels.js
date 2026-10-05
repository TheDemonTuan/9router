export const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const CODEX_EXTENDED_CONTEXT_LENGTH = 872000;

export const CODEX_DISCOVERY_STATUS = Object.freeze({
  OFFICIAL_UNVERIFIED: "official-unverified",
});

export const CODEX_COMPATIBILITY_REASON = Object.freeze({
  NOT_OBSERVED_IN_ACCOUNT_CATALOG: "not_observed_in_account_catalog",
});

export const CODEX_DISCOVERY_SOURCE = Object.freeze({
  LIVE: "live",
  OFFICIAL: "official",
  STATIC: "static",
});
