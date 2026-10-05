import { validateProfileId } from "./protocol.js";

export const MAX_SESSION_TRANSFER_BYTES = 262144;
export const MAX_SESSION_COOKIES = 180;
export class SessionTransferError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "SessionTransferError";
    this.code = code;
    this.status = status;
  }
}

export function parseChatGptWebSessionTransfer(value, nowSeconds = Date.now() / 1000) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.hasOwn(value, "format") || !Object.hasOwn(value, "version") || !Object.hasOwn(value, "cookies")
    || value.format !== "9router-chatgpt-session" || value.version !== 1 || !Array.isArray(value.cookies)
    || value.cookies.length < 1 || value.cookies.length > MAX_SESSION_COOKIES) throw new SessionTransferError("invalid_session_transfer", 400);
  const cookies = [];
  const seen = new Set();
  const encoder = new TextEncoder();
  for (const cookie of value.cookies) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)
      || Object.keys(cookie).some(key => !["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"].includes(key))
      || ["name", "value", "domain", "path", "expires", "httpOnly", "secure"].some(key => !Object.hasOwn(cookie, key))
      || typeof cookie.name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)
      || typeof cookie.value !== "string" || /[\x00-\x1f\x7f]/.test(cookie.value)
      || encoder.encode(cookie.name + cookie.value).byteLength > 4096
      || !["chatgpt.com", ".chatgpt.com"].includes(cookie.domain)
      || typeof cookie.path !== "string" || !cookie.path.startsWith("/") || /[\x00-\x1f\x7f]/.test(cookie.path)
      || typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || !(cookie.expires === -1 || cookie.expires > 0)
      || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean"
      || Object.hasOwn(cookie, "sameSite") && !["Strict", "Lax", "None"].includes(cookie.sameSite)
      || cookie.sameSite === "None" && !cookie.secure
      || cookie.name.startsWith("__Secure-") && !cookie.secure
      || cookie.name.startsWith("__Host-") && (!cookie.secure || cookie.domain !== "chatgpt.com" || cookie.path !== "/")) throw new SessionTransferError("invalid_session_transfer", 400);
    const identity = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
    if (seen.has(identity)) throw new SessionTransferError("invalid_session_transfer", 400);
    seen.add(identity);
    if (cookie.expires !== -1 && cookie.expires <= nowSeconds) continue;
    cookies.push({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: cookie.expires,
      httpOnly: cookie.httpOnly, secure: cookie.secure, ...(Object.hasOwn(cookie, "sameSite") ? { sameSite: cookie.sameSite } : {}) });
  }
  if (!cookies.length) throw new SessionTransferError("session_transfer_expired", 400);
  return cookies;
}

export async function readChatGptWebSessionImport(request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = request.headers.get("content-encoding");
  if (mediaType !== "application/json" || encoding !== null && encoding.trim().toLowerCase() !== "identity") throw new SessionTransferError("invalid_session_transfer", 415);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SESSION_TRANSFER_BYTES) {
    await request.body?.cancel().catch(() => {});
    throw new SessionTransferError("session_transfer_too_large", 413);
  }
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new SessionTransferError("invalid_session_transfer", 400);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SESSION_TRANSFER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SessionTransferError("session_transfer_too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SessionTransferError) throw error;
    throw new SessionTransferError("invalid_session_transfer", 400);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new SessionTransferError("invalid_session_transfer", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 3
    || !Object.hasOwn(body, "profileId") || !Object.hasOwn(body, "revision") || !Object.hasOwn(body, "session")
    || !Number.isSafeInteger(body.revision) || body.revision < 1) throw new SessionTransferError("invalid_session_transfer", 400);
  try { validateProfileId(body.profileId); }
  catch { throw new SessionTransferError("invalid_session_transfer", 400); }
  return { profileId: body.profileId, revision: body.revision,
    session: { format: "9router-chatgpt-session", version: 1, cookies: parseChatGptWebSessionTransfer(body.session) } };
}
