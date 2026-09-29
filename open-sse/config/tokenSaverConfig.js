export const SESSION_DEDUP_MODES = Object.freeze(["off", "shadow", "on"]);

export const TOKEN_SAVER_CONFIG = Object.freeze({
  minResultBytes: 1024,
  maxResultBytes: 4_194_304,
  maxScanBytes: 16_777_216,
  maxEntries: 2048,
  maxProtocolNodes: 65_536,
  protectPreviousTurns: 2,
  latencySamples: 1024,
  softTargetMs: 2,
  shadowToolRetainBytes: 4096,
});

export function isValidSessionDedupMode(value) {
  return SESSION_DEDUP_MODES.includes(value);
}

export function normalizeSessionDedupMode(value, fallback = "shadow") {
  return isValidSessionDedupMode(value) ? value : fallback;
}
