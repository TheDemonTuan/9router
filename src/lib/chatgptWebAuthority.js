import { readFile } from "node:fs/promises";
import { AuthorityError, parseClientKeys, verifyAuthority } from "../../services/chatgpt-web-runtime/src/authority.ts";
import { AUTHORITY_HEADER, MAX_AUTHORITY_BYTES, canonicalPublicPath } from "../../services/chatgpt-web-runtime/protocol.js";

export async function loadChatGptWebClientKeys() {
  const path = process.env.CHATGPT_WEB_CLIENT_KEYS_FILE?.trim();
  if (!path) throw new AuthorityError("codex_client_keys_unconfigured", "ChatGPT Web client provisioning is unavailable", 503);
  // Read each request: disabling a provisioned key revokes NEW requests without a stale key cache.
  try { return parseClientKeys(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new AuthorityError("codex_client_keys_unavailable", "ChatGPT Web client provisioning is unavailable", 503); }
}
export function verifyChatGptWebAuthority({ rawBody, method, path, headers, clientKeys, now }) {
  const incoming = headers instanceof Headers ? headers : new Headers(headers);
  const assertion = incoming.get(AUTHORITY_HEADER);
  let canonical;
  try { canonical = canonicalPublicPath(path); }
  catch { throw new AuthorityError("codex_authority_path_unsupported", "Signed ChatGPT Web requests require the Responses endpoint", 400); }
  return verifyAuthority({ assertion, rawBody, method, path: canonical, clientKeys,
    ...(now === undefined ? {} : { now }) });
}
export function redactChatGptWebInternalHeaders(headers) {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers || {});
  const safe = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (lower === AUTHORITY_HEADER || lower.startsWith("x-cgw-") || lower === "x-9router-cgw-authority") continue;
    safe[name] = value;
  }
  return safe;
}
export function chatGptWebAuthorityErrorResponse(error) {
  const status = error instanceof AuthorityError ? error.status : 400;
  const code = error instanceof AuthorityError ? error.code : "codex_authority_invalid";
  return Response.json({ error: { type: "runtime_error", code,
    message: error instanceof AuthorityError ? error.message : "ChatGPT Web authority verification failed", retryable: false, submission_state: "not_sent" } },
  { status, headers: { "x-9router-no-fallback": "true", "x-should-retry": "false", "x-9router-error-code": code } });
}
export function assertChatGptWebAuthorityHeaderSize(headers) {
  const value = headers.get(AUTHORITY_HEADER);
  if (value && Buffer.byteLength(value) > MAX_AUTHORITY_BYTES) throw new AuthorityError("codex_authority_too_large", "Authority header exceeds 8192 bytes", 431);
}
export function chatGptWebAuthorityRequiredResponse() {
  return chatGptWebAuthorityErrorResponse(new AuthorityError("codex_authority_required", "Use the authenticated local Codex companion"));
}
