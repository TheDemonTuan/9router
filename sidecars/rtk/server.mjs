import { spawn } from "node:child_process";
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
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { shell: false, env: privacy, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    let size = 0;
    let stderrSize = 0;
    let settled = false;
    let failure;
    const abort = () => { failure = signal.reason ?? new Error("aborted"); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { failure = Object.assign(new Error("timeout"), { code: "RTK_TIMEOUT" }); child.kill("SIGKILL"); }, subprocessMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > stdoutLimit) { failure = new Error("stdout_overflow"); child.kill("SIGKILL"); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", chunk => {
      stderrSize += chunk.length;
      if (stderrSize > 65_536) { failure = new Error("stderr_overflow"); child.kill("SIGKILL"); }
    });
    child.on("error", err => { failure = err; });
    child.stdin.on("error", err => { if (!failure) failure = err; });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) return reject(failure ?? new Error("filter_failed"));
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout))); }
      catch (err) { reject(err); }
    });
    child.stdin.end(content);
  });
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
