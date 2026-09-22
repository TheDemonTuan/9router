const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const origCreate = http.createServer.bind(http);

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
  const wrapped = (req, res, requestSignal = req.signal) => {
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

    return handler(req, res);
  };

  const server = origCreate(...rest, wrapped);
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
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
    if (process.versions.bun && head.length === 0) {
      const replayHeaders = { ...req.headers, connection: "close" };
      delete replayHeaders.upgrade;
      delete replayHeaders["http2-settings"];
      req.headers = replayHeaders;
      const res = new http.ServerResponse(req);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      let overflow = Buffer.alloc(0);
      let responseFinished = false;
      let pipelinedDispatched = false;
      const dispatchPipelined = (buffer, previousResponse) => {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return null;
        const lines = buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
        const [method, url] = (lines.shift() || "").split(" ");
        if (!method || !url) return false;
        const headers = {};
        for (const line of lines) {
          const separator = line.indexOf(":");
          if (separator <= 0) return false;
          const name = line.slice(0, separator).toLowerCase();
          const value = line.slice(separator + 1).trim();
          headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
        }
        const length = Number(headers["content-length"] || 0);
        if (!Number.isSafeInteger(length) || length < 0) return false;
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (buffer.length < bodyEnd) return null;
        const remaining = buffer.subarray(bodyEnd);
        delete headers.upgrade;
        delete headers["http2-settings"];
        headers.connection = "close";
        previousResponse?.detachSocket(socket);
        const replay = new http.IncomingMessage(socket);
        Object.assign(replay, { method, url, headers, complete: true });
        if (length) replay.push(buffer.subarray(bodyStart, bodyEnd));
        replay.push(null);
        const nextResponse = new http.ServerResponse(replay);
        nextResponse.shouldKeepAlive = remaining.length > 0;
        nextResponse.assignSocket(socket);
        nextResponse.once("finish", () => {
          if (!remaining.length) {
            socket.end();
            return;
          }
          if (!dispatchPipelined(remaining, nextResponse)) socket.destroy();
        });
        Promise.resolve().then(() => wrapped(replay, nextResponse, null)).catch((error) => {
          console.error("Failed to replay pipelined h2c request", error);
          socket.destroy();
        });
        return true;
      };
      const flushOverflow = () => {
        if (!responseFinished || pipelinedDispatched || !overflow.length) return false;
        const status = dispatchPipelined(overflow, res);
        if (status === null) return false;
        pipelinedDispatched = true;
        overflow = Buffer.alloc(0);
        socket.off("data", onSocketData);
        if (!status) socket.destroy();
        return true;
      };
      const onSocketData = (chunk) => {
        overflow = Buffer.concat([overflow, chunk]);
        flushOverflow();
      };
      socket.on("data", onSocketData);
      socket.resume();
      res.once("finish", () => {
        responseFinished = true;
        setTimeout(() => {
          if (pipelinedDispatched || flushOverflow()) return;
          socket.off("data", onSocketData);
          socket.end();
        }, 10);
      });
      Promise.resolve().then(() => wrapped(req, res, null)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
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
        // Upgrade parsing consumes bytes beyond the first body. Put them back
        // through the public connection event instead of silently dropping
        // pipelined data. This public event path works on Node and Bun; Bun
        // does not expose Node's private parser entry point.
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
