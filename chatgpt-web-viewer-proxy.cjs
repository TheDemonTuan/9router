const http = require("node:http");
const { readFile } = require("node:fs/promises");

const VIEWER_PATH = "/api/providers/chatgpt-web/runtime/login/viewer";
const SESSION_PATH = "/api/providers/chatgpt-web/runtime/login/session";
const LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MESSAGE = 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const loopback = host => ["localhost", "127.0.0.1", "[::1]"].includes(host);

function reject(socket, status) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
function validateUpgrade(req) {
  const url = new URL(req.url, "http://internal.invalid");
  const ids = url.searchParams.getAll("loginId");
  const origin = new URL(req.headers.origin);
  if (req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket"
    || url.origin !== "http://internal.invalid" || url.pathname !== VIEWER_PATH || url.hash
    || ids.length !== 1 || !LOGIN_ID.test(ids[0]) || [...url.searchParams.keys()].some(key => key !== "loginId")
    || origin.origin !== req.headers.origin || origin.host !== req.headers.host
    || origin.username || origin.password || (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback(origin.hostname) && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)))
    || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) throw new Error("Invalid viewer origin or lease");
  return ids[0];
}
function authorize(req, loginId, socket) {
  return new Promise((resolve, rejectAuth) => {
    // Nothing supplied by the caller chooses the HTTP destination or bypasses the
    // Next strict dashboard guard. Only dashboard cookies/CF signed assertions survive.
    const headers = { host: req.headers.host };
    for (const name of ["cookie", "cf-access-jwt-assertion"]) if (req.headers[name]) headers[name] = req.headers[name];
    const address = req.socket.localAddress;
    const hostname = address === "::1" ? "::1" : "127.0.0.1";
    const request = http.get({ hostname, port: req.socket.localPort, path: `${SESSION_PATH}?loginId=${loginId}`, headers, agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); rejectAuth({ status: response.statusCode === 403 ? 403 : 401 }); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 8192) { response.destroy(); rejectAuth({ status: 502 }); } else chunks.push(chunk);
      });
      response.on("error", () => rejectAuth({ status: 502 }));
      response.on("end", () => {
        try {
          const session = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          const expiry = Date.parse(session.expiresAt);
          if (session.loginId !== loginId || session.state !== "waiting" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(session.profileId)
            || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 15 * 60_000
            || typeof session.password !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(session.password)) throw new Error("Inactive lease");
          resolve(expiry);
        } catch { rejectAuth({ status: 401 }); }
      });
    });
    request.setTimeout(10_000, () => request.destroy());
    request.on("error", () => rejectAuth({ status: 502 }));
    const abort = () => request.destroy();
    socket.once("close", abort);
    request.once("close", () => socket.off("close", abort));
  });
}
async function runtimeTarget(loginId) {
  const url = new URL(process.env.CHATGPT_WEB_RUNTIME_URL?.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid runtime target");
  const file = process.env.CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE?.trim();
  if (!file) throw new Error("Admin token missing");
  const token = (await readFile(file, "utf8")).trim();
  if (token.length < 32 || token.length > 4096 || /[\r\n\0]/.test(token)) throw new Error("Invalid admin token");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/admin/login/viewer";
  url.searchParams.set("loginId", loginId);
  return { url, token };
}
function bridge(left, right, stop) {
  for (const [source, target] of [[left, right], [right, left]]) {
    // Bun's accepted server WebSocket has no pause/resume API. Bound outstanding
    // writes explicitly on both runtimes instead of relying on that Node-only API.
    let pendingBytes = 0;
    source.on("message", (data, binary) => {
      if (!binary || data.length > MAX_MESSAGE || target.readyState !== 1 || target.bufferedAmount + data.length > MAX_BUFFER || pendingBytes + data.length > MAX_BUFFER) { stop(); return; }
      pendingBytes += data.length;
      target.send(data, { binary: true, compress: false }, error => { pendingBytes -= data.length; if (error) stop(); });
    });
    source.on("error", stop);
    source.on("close", stop);
  }
}
function createViewerUpgradeHandler() {
  let wss;
  return (req, socket, head) => {
    if (typeof req.url !== "string" || req.url.split("?")[0] !== VIEWER_PATH || String(req.headers.upgrade).toLowerCase() !== "websocket") return false;
    let loginId;
    try { loginId = validateUpgrade(req); } catch { reject(socket, 403); return true; }
    socket.pause();
    void (async () => {
      let upstream; let browser; let expiryTimer; let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(expiryTimer);
        upstream?.terminate(); browser?.terminate();
        if (!browser && !socket.destroyed) socket.destroy();
      };
      const abort = () => stop();
      socket.once("close", abort);
      try {
        const expiry = await authorize(req, loginId, socket);
        const { url, token } = await runtimeTarget(loginId);
        if (socket.destroyed || expiry <= Date.now()) return stop();
        const { WebSocket, WebSocketServer } = require("ws");
        wss ||= new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
        upstream = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: 10_000, followRedirects: false });
        upstream.on("error", stop);
        upstream.on("close", stop);
        await new Promise((resolve, rejectConnect) => {
          upstream.once("open", () => { upstream.pause(); resolve(); });
          upstream.once("error", rejectConnect);
          upstream.once("close", () => rejectConnect(new Error("Viewer ended")));
        });
        upstream.pause();
        if (stopped || socket.destroyed || expiry <= Date.now()) return stop();
        expiryTimer = setTimeout(stop, expiry - Date.now()); expiryTimer.unref();
        wss.handleUpgrade(req, socket, head, ws => {
          browser = ws;
          bridge(browser, upstream, stop);
          socket.resume(); upstream.resume();
        });
      } catch (error) {
        // Never log upstream errors: they can contain operator URLs or headers.
        if (!stopped && !browser) reject(socket, error?.status === 401 ? 401 : error?.status === 403 ? 403 : 502);
        upstream?.terminate();
        clearTimeout(expiryTimer);
      }
    })();
    return true;
  };
}
module.exports = { createViewerUpgradeHandler };
