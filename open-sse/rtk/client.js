import { Agent, request } from "undici";
import { RTK_CONFIG } from "../config/rtkConfig.js";

const cfg = RTK_CONFIG;
let endpoint;
let initialized = false;
let dispatcher;
let active = 0;
let openUntil = 0;
let generation = 0;
let probe = false;
let warningAt = 0;
const fail = reason => {
  openUntil = Date.now() + cfg.cooldownMs;
  generation++;
  probe = false;
  console.warn(`[RTK] sidecar unavailable: ${reason}`);
};
const valid = text => typeof text === "string" && text.isWellFormed() && !text.includes("\0");
function url() {
  if (initialized) return endpoint;
  initialized = true;
  const raw = process.env.RTK_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!(["http:", "https:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/")) throw Error("invalid_url");
    endpoint = new URL("/filter", parsed).href;
    dispatcher = new Agent({ connections: cfg.gatewayConcurrency, pipelining: 1, connect: { timeout: cfg.connectMs } });
  } catch { console.warn("[RTK] invalid_url"); }
  return endpoint;
}

export async function filterToolOutput({ filter = null, content, signal } = {}) {
  if (signal?.aborted) throw signal.reason;
  const target = url();
  if (!target || !valid(content)) return null;
  const bytesIn = Buffer.byteLength(content);
  if (bytesIn < cfg.minTextBytes || bytesIn > cfg.maxTextBytes) return null;
  const now = Date.now();
  if (openUntil && now < openUntil || probe || active >= cfg.gatewayConcurrency) return null;
  const isProbe = Boolean(openUntil);
  if (isProbe) probe = true;
  const myGeneration = generation;
  const payload = JSON.stringify({ content, filter });
  if (Buffer.byteLength(payload) > cfg.maxHttpBytes) { if (isProbe) probe = false; return null; }
  active++;
  let response;
  try {
    response = await request(target, { method: "POST", dispatcher, maxRedirections: 0, headers: { "content-type": "application/json" }, body: payload, signal, headersTimeout: cfg.requestMs, bodyTimeout: cfg.requestMs });
    if (response.statusCode === 503 || response.statusCode === 400 || response.statusCode === 413) {
      await response.body.dump();
      if (response.statusCode !== 503 && now - warningAt > cfg.cooldownMs) { warningAt = now; console.warn(`[RTK] sidecar rejected request: ${response.statusCode}`); }
      return null;
    }
    if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) throw Object.assign(Error("bad_response"), { code: "BAD_RESPONSE" });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > cfg.maxHttpBytes) throw Object.assign(Error("payload_too_large"), { code: "BAD_RESPONSE" });
      chunks.push(chunk);
    }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || data.protocolVersion !== cfg.protocolVersion || !valid(data.content)) throw Object.assign(Error("bad_protocol"), { code: "BAD_RESPONSE" });
    if (isProbe && myGeneration === generation) { openUntil = 0; probe = false; }
    const bytesOut = Buffer.byteLength(data.content);
    return bytesOut > 0 && bytesOut < bytesIn ? data.content : null;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    fail(err.code === "BAD_RESPONSE" ? "bad_response" : "transport_error");
    return null;
  } finally {
    if (response?.body && !response.body.readableEnded && !response.body.destroyed) {
      response.body.on("error", () => {});
      response.body.destroy();
    }
    active--;
    if (isProbe && myGeneration === generation) probe = false;
  }
}
