// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

import { lookup } from "node:dns/promises";
import { Agent, fetch as publicFetch } from "undici/index.js";
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES, BLOCKED_HOSTS } from "../../config/mediaConfig.js";


// True if an IPv4/IPv6 address is private/reserved (SSRF target).
function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv6 loopback / unique-local / link-local
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> extract tail
  const v4 = ip.includes(".") ? ip.split(":").pop() : ip;
  const parts = v4.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return ip.includes(":") ? false : true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on any failure or rejection.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes }
 * @returns {Promise<{url: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  try {
    const response = await fetchPublicMedia(imageUrl, options);
    if (!response.ok) return null;
    const mimeType = detectImageMime(response.body);
    if (!mimeType) return null;
    return { url: encodeDataUri(mimeType, response.body.toString("base64")), mimeType };
  } catch {
    return null;
  }
}

// Shared image/artifact boundary. Never uses ambient proxies or credentials;
// undici's own fetch honors the pinned dispatcher even when Bun owns global fetch.
export async function fetchPublicMedia(mediaUrl, {
  signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES,
  method = "GET", body, contentType, maxRedirects = 0,
} = {}) {
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let currentUrl = mediaUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    fetchSignal.throwIfAborted();
    const url = new URL(currentUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Media URL must use HTTP(S) without credentials");
    }
    const pinnedIps = await resolvePinnedIps(url.hostname);
    if (!pinnedIps) throw new Error("Media URL resolves to a blocked or unavailable address");
    fetchSignal.throwIfAborted();
    const dispatcher = new Agent({
      connect: { lookup: (_hostname, options, callback) => {
        const { address, family } = pinnedIps[0];
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      } },
    });
    let reader;
    try {
      const response = await publicFetch(url.toString(), {
        method, body, signal: fetchSignal, redirect: "manual", dispatcher,
        ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      });
      const status = response.status ?? (response.ok ? 200 : 502);
      const headers = new Headers(response.headers);
      if (status >= 300 && status < 400 && redirect < maxRedirects && method === "GET") {
        await response.body?.cancel();
        const location = headers.get("location");
        if (!location) throw new Error("Media redirect has no destination");
        currentUrl = new URL(location, url).toString();
        continue;
      }
      if (!response.ok || method === "HEAD" || !response.body) {
        await response.body?.cancel?.();
        return { ok: response.ok, status, headers, body: Buffer.alloc(0) };
      }
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        fetchSignal.throwIfAborted();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("Media exceeds size limit");
        chunks.push(Buffer.from(value));
      }
      return { ok: response.ok, status, headers, body: Buffer.concat(chunks, total) };
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock?.();
      await dispatcher.close();
    }
  }
  throw new Error("Media exceeded the redirect limit");
}
