const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { WebSocket, WebSocketServer } = require("../../node_modules/ws");
const originalCreateServer = http.createServer;
require("../../custom-server.js");
const loginId = "aabbccdd-1234-4567-89ab-0123456789ab";
const viewer = "/api/providers/chatgpt-web/runtime/login/viewer";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-viewer-proxy-"));
  const saved = { url: process.env.CHATGPT_WEB_RUNTIME_URL, token: process.env.CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE };
  const token = "fixture-admin-bearer-not-a-production-secret";
  const tokenFile = join(root, "admin-token"); writeFileSync(tokenFile, token);
  const runtime = originalCreateServer((req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const backendSockets = new Set(); const browserSockets = new Set();
  let runtimeHeaders; let selfHeaders; let lease = { loginId, profileId: "personal", expiresAt: new Date(Date.now() + 600000).toISOString(), state: "waiting", password: "fixtureVncPassword" };
  runtime.on("upgrade", (req, socket, head) => {
    runtimeHeaders = req.headers;
    if (req.url !== `/admin/login/viewer?loginId=${loginId}` || req.headers.authorization !== `Bearer ${token}`) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      backendSockets.add(ws); ws.once("close", () => backendSockets.delete(ws));
      // Stateful RFB3.8 handshake fixture, not a forwarding echo server.
      let phase = 0;
      ws.on("message", (data, binary) => {
        assert.equal(binary, true);
        if (phase === 0) { assert.equal(data.toString(), "RFB 003.008\n"); ws.send(Buffer.from([1, 1])); }
        else if (phase === 1) { assert.deepEqual(data, Buffer.from([1])); ws.send(Buffer.alloc(4)); }
        else if (phase === 2) {
          assert.deepEqual(data, Buffer.from([1]));
          const init = Buffer.alloc(24); init.writeUInt16BE(1, 0); init.writeUInt16BE(1, 2); init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8;
          ws.send(init);
        } else throw new Error("Unexpected RFB handshake phase");
        phase++;
      });
      ws.send(Buffer.from("RFB 003.008\n"));
    });
  });
  await new Promise(resolve => runtime.listen(0, "127.0.0.1", resolve));
  process.env.CHATGPT_WEB_RUNTIME_URL = `http://127.0.0.1:${runtime.address().port}`;
  process.env.CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE = tokenFile;
  const gateway = http.createServer((req, res) => {
    selfHeaders = req.headers;
    if (req.url !== `/api/providers/chatgpt-web/runtime/login/session?loginId=${loginId}` || req.headers.host === "api.example.test" || req.headers.cookie !== "dashboard=fixture-signed-session") { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(lease));
  });
  let unrelatedUpgrades = 0;
  gateway.on("upgrade", (req, socket) => { unrelatedUpgrades++; socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${gateway.address().port}`;
  const connect = (headers = {}, query = `?loginId=${loginId}`, path = viewer) => {
    const ws = new WebSocket(`ws://${host}${path}${query}`, { headers: { origin: `http://${host}`, cookie: "dashboard=fixture-signed-session", ...headers } });
    browserSockets.add(ws); ws.once("close", () => browserSockets.delete(ws)); ws.on("error", () => {});
    return ws;
  };
  return { connect, token, get runtimeHeaders() { return runtimeHeaders; }, get selfHeaders() { return selfHeaders; }, get unrelatedUpgrades() { return unrelatedUpgrades; }, setLease(value) { lease = { ...lease, ...value }; }, endLease() { for (const ws of backendSockets) ws.close(); }, async close() {
    for (const ws of browserSockets) ws.terminate(); for (const ws of backendSockets) ws.terminate();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => runtime.close(resolve))]); wss.close();
    for (const [name, value] of [["CHATGPT_WEB_RUNTIME_URL", saved.url], ["CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE", saved.token]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  } };
}
async function denied(ws) {
  return new Promise(resolve => ws.once("unexpected-response", (request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }));
}

test("viewer upgrade rejects origins, noncanonical queries, missing auth and API-host even with spoofed bypass headers", async () => {
  const f = await fixture();
  try {
    for (const origin of ["https://evil.test", "null", "http://remote.example.test"]) assert.equal(await denied(f.connect({ origin })), 403);
    for (const query of ["?loginId=bad", `?loginId=${loginId}&loginId=${loginId}`, `?loginId=${loginId}&target=localhost`]) assert.equal(await denied(f.connect({}, query)), 403);
    assert.equal(await denied(f.connect({ cookie: "", authorization: "Bearer api-key", "x-9r-cli-token": "machine", "x-cgw-admin-token": f.token })), 401);
    assert.equal(await denied(f.connect({ host: "api.example.test", origin: "https://api.example.test" })), 401);
    assert.equal(await denied(f.connect({}, "", "/_next/webpack-hmr")), 404);
    assert.equal(f.unrelatedUpgrades, 1);
  } finally { await f.close(); }
});

test("viewer rejects wrong/expired/terminal sessions before opening a runtime websocket", async () => {
  const f = await fixture();
  try {
    for (const value of [{ loginId: "00000000-0000-4000-8000-000000000000" }, { loginId, expiresAt: "2000-01-01T00:00:00.000Z" }, { expiresAt: new Date(Date.now() + 600000).toISOString(), state: "closed" }]) {
      f.setLease(value); assert.equal(await denied(f.connect()), 401);
    }
    assert.equal(f.runtimeHeaders, undefined);
  } finally { await f.close(); }
});

test("binary RFB handshake forwards through the owned runtime with no client headers or admin-token disclosure", async () => {
  const f = await fixture();
  try {
    const ws = f.connect({ authorization: "Bearer untrusted", "x-forwarded-host": "api.example.test", "x-cgw-profile-id": "other", "cf-access-jwt-assertion": "fixture-signed-assertion" });
    const frames = []; let done;
    const handshake = new Promise(resolve => { done = resolve; });
    ws.on("message", (data, binary) => {
      assert.equal(binary, true); frames.push(data);
      if (frames.length === 1) { assert.equal(data.toString(), "RFB 003.008\n"); ws.send(Buffer.from("RFB 003.008\n")); }
      else if (frames.length === 2) { assert.deepEqual(data, Buffer.from([1, 1])); ws.send(Buffer.from([1])); }
      else if (frames.length === 3) { assert.deepEqual(data, Buffer.alloc(4)); ws.send(Buffer.from([1])); }
      else { assert.equal(data.readUInt16BE(0), 1); done(); }
    });
    await handshake;
    assert.equal(f.runtimeHeaders.authorization, `Bearer ${f.token}`);
    assert.equal(f.runtimeHeaders.cookie, undefined);
    assert.equal(f.runtimeHeaders["cf-access-jwt-assertion"], undefined);
    assert.equal(f.runtimeHeaders["x-cgw-profile-id"], undefined);
    assert.equal(f.selfHeaders.authorization, undefined);
    assert.equal(f.selfHeaders["x-forwarded-host"], undefined);
    assert.equal(f.selfHeaders["cf-access-jwt-assertion"], "fixture-signed-assertion");
    const ended = once(ws, "close"); f.endLease(); await ended;
  } finally { await f.close(); }
});

test("viewer terminates on lease expiry and rejects text or oversized binary messages", async () => {
  const f = await fixture();
  try {
    for (const payload of ["text is not RFB", Buffer.alloc(1024 * 1024 + 1)]) {
      const ws = f.connect(); await once(ws, "open"); const ended = once(ws, "close"); ws.send(payload); await ended;
    }
    // This integration crosses real HTTP/WS sockets; exercise the actual expiry
    // deadline, rather than faking timers beneath network handshakes.
    f.setLease({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    const ws = f.connect(); await once(ws, "open"); await once(ws, "close");
  } finally { await f.close(); }
});
