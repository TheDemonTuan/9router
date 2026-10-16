import { RTK_CONFIG, RTK_FILTERS } from "../../open-sse/config/rtkConfig.js";
import upstream from "./upstream.json";

const { maxHttpBytes, maxTextBytes, subprocessMs, requestMs, sidecarConcurrency } = RTK_CONFIG;
const json = (status, body, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers },
});
const error = (status, code, headers) => json(status, { error: code }, headers);
const valid = text => typeof text === "string" && text.isWellFormed() && !text.includes("\0");
const privacy = { ...process.env, RTK_TELEMETRY_DISABLED: "1", RTK_RECALL: "0", RTK_TEE: "0", NO_COLOR: "1", HOME: "/tmp" };

async function run(binaryPath, args, content, signal, stdoutLimit = maxTextBytes) {
  if (signal?.aborted) throw signal.reason;
  const child = Bun.spawn([binaryPath, ...args], {
    env: privacy,
    stdin: new TextEncoder().encode(content),
    stdout: "pipe",
    stderr: "pipe",
  });
  let failure;
  const fail = reason => {
    if (failure === undefined) failure = reason;
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  const abort = () => fail(signal.reason ?? new Error("aborted"));
  const timer = setTimeout(() => fail(Object.assign(new Error("timeout"), { code: "RTK_TIMEOUT" })), subprocessMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const stdout = [];
  async function drain(stream, limit, name, chunks) {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) fail(new Error(`${name}_overflow`));
        else if (chunks && failure === undefined) chunks.push(value);
      }
    } catch (error) {
      fail(error);
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const [exit] = await Promise.all([
      child.exited.catch(error => { fail(error); return -1; }),
      drain(child.stdout, stdoutLimit, "stdout", stdout),
      drain(child.stderr, 65_536, "stderr"),
    ]);
    if (failure !== undefined) throw failure;
    if (exit !== 0) throw new Error("filter_failed");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

export async function startRtkServer({ hostname = "0.0.0.0", port = 8080, binaryPath = "/usr/local/bin/rtk" } = {}) {
  const version = (await run(binaryPath, ["--version"], "", undefined, 4096)).trim();
  if (!version.includes(upstream.version)) throw new Error("RTK version mismatch");
  const identity = "file:1:hello\n";
  if (await run(binaryPath, ["pipe", "--filter", "grep"], identity) !== identity) throw new Error("RTK pipe startup check failed");
  let active = 0;
  let stopping = false;
  const controllers = new Set();
  const server = Bun.serve({ hostname, port, maxRequestBodySize: maxHttpBytes,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname === "/version") {
        if (request.method !== "GET") return error(405, "method_not_allowed", { Allow: "GET" });
        if (url.pathname === "/health") return json(200, { ok: true, protocolVersion: RTK_CONFIG.protocolVersion });
        return json(200, { protocolVersion: RTK_CONFIG.protocolVersion, rtkVersion: upstream.version, wrapperRevision: upstream.revision, filters: RTK_FILTERS });
      }
      if (url.pathname !== "/filter") return error(404, "not_found");
      if (request.method !== "POST") return error(405, "method_not_allowed", { Allow: "POST" });
      if (stopping || active >= sidecarConcurrency) return error(503, "busy");
      active++;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(Object.assign(new Error("timeout"), { code: "RTK_TIMEOUT" })), requestMs);
      const disconnect = () => controller.abort(request.signal.reason ?? new Error("disconnected"));
      request.signal.addEventListener("abort", disconnect, { once: true });
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return error(415, "unsupported_media_type");
        if (Number(request.headers.get("content-length")) > maxHttpBytes) return error(413, "payload_too_large");
        const reader = request.body?.getReader();
        if (!reader) return error(400, "invalid_request");
        const chunks = [];
        let bytes = 0;
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        try {
          while (true) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxHttpBytes) return error(413, "payload_too_large");
            chunks.push(value);
          }
        } finally {
          controller.signal.removeEventListener("abort", rejectAbort);
          await reader.cancel().catch(() => {});
        }
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => key !== "content" && key !== "filter") || !valid(data.content) || !(data.filter == null || RTK_FILTERS.includes(data.filter))) return error(400, "invalid_request");
        if (Buffer.byteLength(data.content) > maxTextBytes) return error(413, "payload_too_large");
        if (!data.content) return json(200, { protocolVersion: RTK_CONFIG.protocolVersion, content: "" });
        const args = ["pipe", ...(data.filter == null ? [] : ["--filter", data.filter])];
        const content = await run(binaryPath, args, data.content, controller.signal);
        if (!valid(content)) return error(502, "filter_failed");
        const result = { protocolVersion: RTK_CONFIG.protocolVersion, content };
        if (Buffer.byteLength(JSON.stringify(result)) > maxHttpBytes) return error(413, "payload_too_large");
        return json(200, result);
      } catch (cause) {
        if (controller.signal.aborted || cause?.code === "RTK_TIMEOUT") return error(504, "filter_timeout");
        if (cause instanceof SyntaxError || cause instanceof TypeError) return error(400, "invalid_request");
        return error(502, "filter_failed");
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", disconnect);
        controllers.delete(controller);
        active--;
      }
    },
  });
  const shutdown = () => { stopping = true; for (const controller of controllers) controller.abort(new Error("shutdown")); server.stop(true); };
  if (import.meta.main) process.once("SIGTERM", shutdown);
  return server;
}

if (import.meta.main) await startRtkServer();
