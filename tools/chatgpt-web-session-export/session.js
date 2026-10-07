import { MAX_SESSION_COOKIES, MAX_SESSION_TRANSFER_BYTES, parseChatGptWebSessionTransfer, SessionTransferError } from "../../services/chatgpt-web-runtime/session-transfer.js";

const sameSites = { strict: "Strict", lax: "Lax", no_restriction: "None" };
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const controlCharacters = /[\x00-\x1f\x7f]/;
const encoder = new TextEncoder();

export function transferableCookie(cookie, nowSeconds) {
  if (cookie.domain !== "chatgpt.com" && cookie.domain !== ".chatgpt.com") return null;
  // Partitioned cookies belong to a top-level-site partition, not this format.
  if (cookie.partitionKey !== undefined) return null;
  if (typeof cookie.name !== "string" || !cookieName.test(cookie.name)) return null;
  if (typeof cookie.value !== "string" || controlCharacters.test(cookie.value)) return null;
  if (encoder.encode(cookie.name + cookie.value).byteLength > 4096) return null;
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/") || controlCharacters.test(cookie.path)) return null;
  if (typeof cookie.hostOnly !== "boolean" || typeof cookie.session !== "boolean"
    || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean") return null;
  const expires = cookie.session ? -1 : cookie.expirationDate;
  if (!cookie.session && (!Number.isFinite(expires) || expires <= nowSeconds)) return null;
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return null;
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || !cookie.hostOnly || cookie.path !== "/")) return null;
  if (cookie.sameSite !== "unspecified" && !Object.hasOwn(sameSites, cookie.sameSite)) return null;
  const sameSite = sameSites[cookie.sameSite];
  if (sameSite === "None" && !cookie.secure) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? "chatgpt.com" : ".chatgpt.com",
    path: cookie.path,
    expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(sameSite ? { sameSite } : {}),
  };
}

export async function collectChatGptSession() {
  const nowSeconds = Date.now() / 1000;
  const stored = await chrome.cookies.getAll({ domain: "chatgpt.com" });
  const cookies = stored.map(cookie => transferableCookie(cookie, nowSeconds)).filter(cookie => cookie !== null);
  if (!cookies.length) throw new SessionTransferError("session_transfer_expired", 400);
  if (cookies.length > MAX_SESSION_COOKIES) throw new SessionTransferError("invalid_session_transfer", 400);
  const session = { format: "9router-chatgpt-session", version: 1, cookies };
  session.cookies = parseChatGptWebSessionTransfer(session, nowSeconds);
  if (encoder.encode(JSON.stringify(session)).byteLength > MAX_SESSION_TRANSFER_BYTES) throw new SessionTransferError("session_transfer_too_large", 413);
  return session;
}
