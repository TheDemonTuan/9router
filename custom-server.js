const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const origCreate = http.createServer.bind(http);
const INSTANCE_ID = crypto.randomUUID();
const drainResponses = globalThis.__ninerouterDrainResponses || {
  active: 0,
  known: true,
  entries: new Map(),
};
globalThis.__ninerouterDrainResponses = drainResponses;
globalThis.__ninerouterInstanceId = INSTANCE_ID;
process.env.NINEROUTER_INSTANCE_ID = INSTANCE_ID;

function isDrainProbe(pathname) {
  return pathname === "/api/health" || pathname.startsWith("/api/health?");
}

function trackDrainResponse(req, res) {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { return () => {}; }
  if (isDrainProbe(pathname)) return () => {};

  const id = crypto.randomUUID();
  const entry = { id, startedAt: Date.now() };
  drainResponses.entries.set(id, entry);
  drainResponses.active += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    res.off("finish", release);
    res.off("close", release);
    drainResponses.entries.delete(id);
    drainResponses.active = Math.max(0, drainResponses.active - 1);
  };
  res.once("finish", release);
  res.once("close", release);
  return release;
}

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;


// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const options = rest[0] ?? {};
  const wrapped = (req, res, requestSignal = req.signal) => {
    const isBunH2c = process.versions.bun && String(req.headers.upgrade || "").toLowerCase() === "h2c";
    if (isBunH2c) {
      delete req.headers.upgrade;
      delete req.headers["http2-settings"];
      if (req.headers.connection !== undefined) {
        const connectionTokens = String(req.headers.connection)
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token && token.toLowerCase() !== "upgrade" && token.toLowerCase() !== "http2-settings");
        if (connectionTokens.length) req.headers.connection = connectionTokens.join(", ");
        else delete req.headers.connection;
      }
    }
    const releaseDrainResponse = trackDrainResponse(req, res);
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";

    // Bun exposes disconnects on IncomingMessage.signal, while Next.js watches
    // ServerResponse.close. Bridge the two so route-level request.signal aborts.
    if (requestSignal && typeof requestSignal.addEventListener === "function") {
      const abortResponse = () => {
        if (process.versions.bun && req.complete && req.destroyed && !req.socket?.destroyed) return;
        if (!res.destroyed && !res.writableFinished) res.destroy();
      };
      const cleanup = () => {
        requestSignal.removeEventListener("abort", abortResponse);
        res.off("close", cleanup);
        res.off("finish", cleanup);
      };
      if (requestSignal.aborted) abortResponse();
      else {
        requestSignal.addEventListener("abort", abortResponse, { once: true });
        res.once("close", cleanup);
        res.once("finish", cleanup);
      }
    }

    try {
      const result = handler(req, res);
      if (result && typeof result.then === "function") {
        result.catch(() => releaseDrainResponse());
      }
      return result;
    } catch (error) {
      releaseDrainResponse();
      throw error;
    }
  };
  if (process.versions.bun) {
    const callerShouldUpgradeCallback = options.shouldUpgradeCallback;
    if (callerShouldUpgradeCallback !== undefined && typeof callerShouldUpgradeCallback !== "function") {
      return origCreate(...rest, wrapped);
    }
    const nativeOptions = {
      ...options,
      shouldUpgradeCallback(req) {
        if (String(req.headers.upgrade || "").toLowerCase() === "h2c") return false;
        if (callerShouldUpgradeCallback) return callerShouldUpgradeCallback.call(this, req);
        return this.listenerCount("upgrade") > 0;
      },
    };
    return origCreate(nativeOptions, wrapped);
  }

  const server = origCreate(...rest, wrapped);
  const origEmit = server.emit;
  // Node-only h2c replay for runtimes without Bun's native shouldUpgradeCallback handling.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const requestLine = Buffer.from(`${req.method} ${req.url} HTTP/`);
    const serve = () => {
      const buffered = Buffer.concat(chunks, received);
      const hasRawHeaders = head.length === 0 && buffered.subarray(0, requestLine.length).equals(requestLine);
      const headerEnd = hasRawHeaders ? buffered.indexOf("\r\n\r\n") : -1;
      if (hasRawHeaders && headerEnd < 0) return false;
      const bodyStart = headerEnd >= 0 ? headerEnd + 4 : 0;
      if (buffered.length < bodyStart + contentLength) return false;
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const bodyEnd = bodyStart + contentLength;
      const overflow = buffered.subarray(bodyEnd);
      const replay = new http.IncomingMessage(socket);
      const replayHeaders = { ...req.headers, connection: "close" };
      delete replayHeaders.upgrade;
      delete replayHeaders["http2-settings"];
      Object.assign(replay, { method: req.method, url: req.url, headers: replayHeaders, complete: true });
      if (contentLength) replay.push(buffered.subarray(bodyStart, bodyEnd));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = overflow.length > 0;
      res.assignSocket(socket);
      res.once("finish", () => {
        if (!overflow.length) {
          socket.end();
          return;
        }
        // Node's upgrade parser consumes bytes beyond the first body. Put them back through
        // the public connection event instead of silently dropping pipelined data.
        res.detachSocket(socket);
        socket.unshift(overflow);
        setImmediate(() => server.emit("connection", socket));
      });
      Promise.resolve().then(() => wrapped(replay, res, null)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
      return true;
    };
    const readBody = (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (serve()) socket.off("data", readBody);
    };
    if (!serve()) {
      socket.on("data", readBody);
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
