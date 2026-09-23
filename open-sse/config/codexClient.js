const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const DEFAULT_CODEX_CLIENT_VERSION = "0.155.0";

export function isValidCodexClientVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value.trim());
}

export function resolveCodexClientVersion(value = process.env.CODEX_CLIENT_VERSION) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return DEFAULT_CODEX_CLIENT_VERSION;
  if (isValidCodexClientVersion(candidate)) return candidate;
  console.warn(`[Codex] Ignoring invalid CODEX_CLIENT_VERSION: ${candidate}`);
  return DEFAULT_CODEX_CLIENT_VERSION;
}

export const CODEX_CLIENT_VERSION = resolveCodexClientVersion();
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`;
