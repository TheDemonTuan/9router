import { Agent, request } from "undici";
import { RTK_CONFIG } from "../config/rtkConfig.js";
import { getRtkState } from "./state.js";

const cfg = RTK_CONFIG;
const valid = text => typeof text === "string" && text.isWellFormed() && !text.includes("\0");
const state = () => getRtkState().client;

function endpoint() {
  const client = state();
  if (client.initialized) return client.endpoint;
  client.initialized = true;
  const raw = process.env.RTK_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!( ["http:", "https:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/")) throw Error("invalid_url");
    client.endpoint = parsed.origin;
    client.endpointState = "configured";
  } catch {
    client.endpointState = "invalid";
    console.warn("[RTK] invalid_url");
  }
  return client.endpoint;
}

function fail(client, reason) {
  client.openUntil = Date.now() + cfg.cooldownMs;
  client.generation++;
  client.probe = false;
  client.lastFailure = { at: new Date().toISOString(), reason };
  console.warn(`[RTK] sidecar unavailable: ${reason}`);
}

export function getRtkClientStatus() {
  endpoint();
  const client = state();
  return {
    endpointState: client.endpointState, active: client.active,
    circuit: client.probe || client.openUntil && Date.now() >= client.openUntil ? "half_open" : client.openUntil ? "open" : "closed",
    openUntil: client.openUntil ? new Date(client.openUntil).toISOString() : null,
    lastSuccessAt: client.lastSuccessAt, lastFailure: client.lastFailure && { ...client.lastFailure },
    check: client.check && { ...client.check },
  };
}

export async function filterToolOutput({ filter = null, content, signal, internalSignal } = {}) {
  if (signal?.aborted) throw signal.reason;
  const client = state();
  const usage = getRtkState().usage;
  const target = endpoint();
  if (!target) { usage.skipped[client.endpointState === "invalid" ? "invalid_url" : "unconfigured"]++; return null; }
  if (!valid(content)) { usage.skipped.invalid_text++; return null; }
  const bytesIn = Buffer.byteLength(content);
  if (bytesIn < cfg.minTextBytes || bytesIn > cfg.maxTextBytes) { usage.skipped.size_limit++; return null; }
  const now = Date.now();
  if (client.openUntil && now < client.openUntil) { usage.skipped.circuit_open++; return null; }
  if (client.probe) { usage.skipped.probe_in_flight++; return null; }
  if (client.active >= cfg.gatewayConcurrency) { usage.skipped.saturated++; return null; }
  const isProbe = Boolean(client.openUntil);
  if (isProbe) client.probe = true;
  const myGeneration = client.generation;
  const payload = JSON.stringify({ content, filter });
  if (Buffer.byteLength(payload) > cfg.maxHttpBytes) { if (isProbe) client.probe = false; usage.skipped.payload_limit++; return null; }
  client.dispatcher ??= new Agent({ connections: cfg.gatewayConcurrency, pipelining: 1, connect: { timeout: cfg.connectMs } });
  client.active++;
  usage.http.attempts++;
  const start = performance.now();
  let response;
  try {
    response = await request(new URL("/filter", target), { method: "POST", dispatcher: client.dispatcher, maxRedirections: 0, headers: { "content-type": "application/json" }, body: payload, signal, headersTimeout: cfg.requestMs, bodyTimeout: cfg.requestMs });
    if (response.statusCode === 503 || response.statusCode === 400 || response.statusCode === 413) {
      usage.http[response.statusCode === 503 ? "busy" : "rejected"]++;
      if (response.statusCode !== 503 && now - client.warningAt > cfg.cooldownMs) { client.warningAt = now; console.warn(`[RTK] sidecar rejected request: ${response.statusCode}`); }
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
    if (signal?.aborted) throw signal.reason;
    if (!data || data.protocolVersion !== cfg.protocolVersion || !valid(data.content)) throw Object.assign(Error("bad_protocol"), { code: "BAD_RESPONSE" });
    if (isProbe && myGeneration === client.generation) { client.openUntil = 0; client.probe = false; }
    client.lastSuccessAt = new Date().toISOString();
    usage.http.succeeded++;
    const bytesOut = Buffer.byteLength(data.content);
    if (!bytesOut || bytesOut >= bytesIn) { usage.http.unchanged++; return null; }
    return data.content;
  } catch (err) {
    if (signal?.aborted && !internalSignal?.aborted) { usage.http.cancelled++; throw signal.reason; }
    const reason = internalSignal?.aborted || /(?:_TIMEOUT$|^ETIMEDOUT$)/.test(err?.code ?? "") ? "timeout" : err?.code === "BAD_RESPONSE" || err instanceof SyntaxError ? "bad_response" : "transport_error";
    usage.http.failed++;
    if (reason === "timeout") usage.http.timedOut++;
    fail(client, reason);
    return null;
  } finally {
    if (response?.body && !response.body.readableEnded && !response.body.destroyed) {
      response.body.on("error", () => {});
      response.body.destroy();
    }
    client.active--;
    usage.http.totalDurationMs += performance.now() - start;
    if (isProbe && myGeneration === client.generation) client.probe = false;
  }
}

export async function checkRtkConnection() {
  const target = endpoint();
  const client = state();
  if (!target) {
    client.check = { status: "failed", checkedAt: new Date().toISOString(), rtkVersion: null, wrapperRevision: null, reason: client.endpointState === "invalid" ? "invalid_url" : "unconfigured" };
    return { ...client.check };
  }
  if (client.checkPromise) return client.checkPromise;
  if (client.check && Date.now() - Date.parse(client.check.checkedAt) < cfg.checkCooldownMs) return { ...client.check };
  client.checkPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestMs);
    const agent = new Agent({ connections: 1, pipelining: 1, connect: { timeout: cfg.connectMs } });
    let response;
    let version;
    let reason = null;
    try {
      async function call(path, body) {
        response = await request(new URL(path, target), {
          method: body ? "POST" : "GET", body: body && JSON.stringify(body),
          headers: body ? { "content-type": "application/json" } : {},
          dispatcher: agent, signal: controller.signal, maxRedirections: 0,
          headersTimeout: cfg.requestMs, bodyTimeout: cfg.requestMs,
        });
        if (response.statusCode === 503) throw Object.assign(Error("busy"), { checkReason: "busy" });
        if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) throw Object.assign(Error("bad_response"), { checkReason: "bad_response" });
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > cfg.checkMaxHttpBytes) throw Object.assign(Error("oversize"), { checkReason: "bad_response" });
          chunks.push(chunk);
        }
        response = null;
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      }
      const health = await call("/health");
      if (health?.protocolVersion !== cfg.protocolVersion || health.ok !== true) throw Object.assign(Error("health"), { checkReason: "bad_response" });
      version = await call("/version");
      if (version?.protocolVersion !== cfg.protocolVersion || typeof version.rtkVersion !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(version.rtkVersion) || !Number.isSafeInteger(version.wrapperRevision) || version.wrapperRevision <= 0 || !Array.isArray(version.filters) || !version.filters.includes("grep")) throw Object.assign(Error("version"), { checkReason: "bad_response" });
      const content = "file:1:hello\n";
      const filtered = await call("/filter", { filter: "grep", content });
      if (filtered?.protocolVersion !== cfg.protocolVersion || filtered.content !== content) throw Object.assign(Error("filter"), { checkReason: "bad_response" });
    } catch (error) {
      reason = controller.signal.aborted ? "timeout" : error?.checkReason || (error instanceof SyntaxError || error instanceof TypeError ? "bad_response" : "unreachable");
    } finally {
      if (response?.body && !response.body.readableEnded && !response.body.destroyed) { response.body.on("error", () => {}); response.body.destroy(); }
      clearTimeout(timer);
      await agent.close().catch(() => agent.destroy());
    }
    client.check = { status: reason ? "failed" : "passed", checkedAt: new Date().toISOString(), rtkVersion: reason ? null : version.rtkVersion, wrapperRevision: reason ? null : version.wrapperRevision, reason };
    return { ...client.check };
  })();
  try { return await client.checkPromise; }
  finally { client.checkPromise = null; }
}
