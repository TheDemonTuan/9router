const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

const HTTP2_SETTINGS = "AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA";
const MODEL = "cx/gpt-5.6-luna";
const NEXT_ADAPTER_PATH = "next/dist/server/web/spec-extension/adapters/next-request.js";
const NODE_REQUEST_PATH = "next/dist/server/base-http/node.js";

function installCustomServer() {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");
  return () => {
    http.createServer = originalCreateServer;
    delete require.cache[require.resolve("../../custom-server.js")];
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function nextJson(req, res) {
  const { NextRequestAdapter, signalFromNodeResponse } = require(NEXT_ADAPTER_PATH);
  const { NodeNextRequest } = require(NODE_REQUEST_PATH);
  const nextRequest = NextRequestAdapter.fromNodeNextRequest(
    new NodeNextRequest(req),
    signalFromNodeResponse(res),
  );
  return nextRequest.json().then((parsed) => ({ nextRequest, parsed }));
}

function responseBody(buffer) {
  const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"));
  assert.notEqual(headerEnd, -1, "response headers missing");
  const headers = buffer.subarray(0, headerEnd).toString("latin1");
  assert.match(headers, /^HTTP\/1\.1 200 /);
  const lengthMatch = /\r\ncontent-length: (\d+)\r\n/i.exec(headers);
  assert.ok(lengthMatch, "response Content-Length missing");
  const length = Number(lengthMatch[1]);
  const body = buffer.subarray(headerEnd + 4);
  assert.equal(body.length, length, "response body truncated or has extra bytes");
  assert.equal(buffer.length, headerEnd + 4 + length);
  return body;
}

function sendRaw(port, payload, sockets = new Set()) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    sockets.add(socket);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      sockets.delete(socket);
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(5_000, () => {
      socket.destroy();
      finish(new Error("h2c response timed out"));
    });
    socket.on("connect", () => {
      if (typeof payload === "function") payload(socket);
      else socket.write(payload);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (error) => finish(error));
  });
}

function h2cHeaders(port, body, extra = []) {
  return Buffer.from([
    "POST /v1/chat/completions HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Connection: close, Upgrade, HTTP2-Settings",
    "Upgrade: h2c",
    `HTTP2-Settings: ${HTTP2_SETTINGS}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Content-Type: application/json",
    ...extra,
    "",
    "",
  ].join("\r\n"));
}

async function runJsonCase({ writeRequest, expected, responseType = "json", serverOptions = {} }) {
  const restore = installCustomServer();
  const sockets = new Set();
  let rejectHandler;
  const handlerFailure = new Promise((_, reject) => { rejectHandler = reject; });
  const server = http.createServer(serverOptions, async (req, res) => {
    try {
      assert.equal(req.headers.upgrade, undefined);
      assert.equal(req.headers["http2-settings"], undefined);
      const { nextRequest, parsed } = await nextJson(req, res);
      assert.deepEqual(parsed, expected);
      assert.equal(nextRequest.signal.aborted, false);
      const body = responseType === "sse" ? "data: [DONE]\n\n" : JSON.stringify({ ok: true });
      res.setHeader("Content-Type", responseType === "sse" ? "text/event-stream" : "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(body));
      await new Promise((resolve) => {
        res.once("finish", resolve);
        res.end(body);
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(nextRequest.signal.aborted, false);
    } catch (error) {
      rejectHandler(error);
      if (!res.destroyed) res.destroy();
    }
  });
  server.on("upgrade", (_req, socket) => {
    rejectHandler(new Error("h2c request reached upgrade listener"));
    socket.destroy();
  });
  try {
    const port = await listen(server);
    const requestPayload = writeRequest(port);
    const response = await Promise.race([
      sendRaw(port, requestPayload, sockets),
      handlerFailure,
    ]);
    const body = responseBody(response);
    if (responseType === "sse") assert.equal(body.toString(), "data: [DONE]\n\n");
    else assert.deepEqual(JSON.parse(body), { ok: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
    restore();
  }
}

test("serves same-write h2c JSON through the real NextRequest adapter", { timeout: 5_000 }, async () => {
  const expected = { model: MODEL, stream: true };
  await runJsonCase({
    expected,
    responseType: "sse",
    writeRequest: (port) => {
      const body = JSON.stringify(expected);
      return Buffer.concat([h2cHeaders(port, body), Buffer.from(body)]);
    },
  });
});

test("serves fragmented h2c JSON through the real NextRequest adapter", { timeout: 5_000 }, async () => {
  const expected = { model: MODEL, stream: true };
  await runJsonCase({
    expected,
    writeRequest: (port) => {
      const body = JSON.stringify(expected);
      return (socket) => {
        socket.write(h2cHeaders(port, body));
        setImmediate(() => socket.write(Buffer.from(body)));
      };
    },
  });
});

test("serves Bun chunked h2c JSON through the real NextRequest adapter", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const expected = { model: MODEL, stream: true };
  await runJsonCase({
    expected,
    writeRequest: (port) => {
      const body = JSON.stringify(expected);
      const split = Math.ceil(body.length / 2);
      const first = Buffer.from(body.slice(0, split));
      const second = Buffer.from(body.slice(split));
      const headers = Buffer.from([
        "POST /v1/chat/completions HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: close, Upgrade, HTTP2-Settings",
        "Upgrade: h2c",
        `HTTP2-Settings: ${HTTP2_SETTINGS}`,
        "Transfer-Encoding: chunked",
        "Content-Type: application/json",
        "",
        "",
      ].join("\r\n"));
      return (socket) => {
        socket.write(Buffer.concat([
          headers,
          Buffer.from(`${first.length.toString(16)}\r\n`), first,
          Buffer.from("\r\n"),
        ]), () => setImmediate(() => socket.write(Buffer.concat([
          Buffer.from(`${second.length.toString(16)}\r\n`), second,
          Buffer.from("\r\n0\r\n\r\n"),
        ]))));
      };
    },
  });
});

test("Bun keeps a caller h2c upgrade callback from overriding downgrade", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  let callbackCalled = false;
  const expected = { model: MODEL, stream: true };
  await runJsonCase({
    expected,
    serverOptions: {
      shouldUpgradeCallback() {
        callbackCalled = true;
        return true;
      },
    },
    writeRequest: (port) => {
      const body = JSON.stringify(expected);
      return Buffer.concat([h2cHeaders(port, body), Buffer.from(body)]);
    },
  });
  assert.equal(callbackCalled, false);
});

test("Bun keeps non-h2c websocket upgrade routing intact", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const server = http.createServer(() => assert.fail("websocket upgrade reached request handler"));
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  try {
    const port = await listen(server);
    const response = await sendRaw(port, (socket) => socket.end([
      "GET /socket HTTP/1.1", `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket",
      `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", "",
    ].join("\r\n")));
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(response.toString("latin1"), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  } finally {
    await close(server);
    restore();
  }
});

test("Bun caller upgrade callbacks preserve websocket allow and deny decisions", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  for (const allow of [false, true]) {
    const restore = installCustomServer();
    let callbackThis;
    let callbackRequest;
    const server = http.createServer({
      shouldUpgradeCallback(req) {
        callbackThis = this;
        callbackRequest = req;
        return allow;
      },
    }, (req, res) => {
      res.setHeader("Content-Length", "2");
      res.end("ok");
    });
    let upgraded = false;
    server.on("upgrade", (_req, socket) => {
      upgraded = true;
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n");
    });
    try {
      const port = await listen(server);
      const response = await sendRaw(port, Buffer.from([
        "GET /socket HTTP/1.1", `Host: 127.0.0.1:${port}`, "Connection: close, Upgrade", "Upgrade: websocket",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", "",
      ].join("\r\n")));
      assert.equal(callbackThis, server);
      assert.equal(callbackRequest.headers.upgrade, "websocket");
      assert.equal(upgraded, allow);
      if (allow) assert.match(response.toString("latin1"), /^HTTP\/1\.1 101 /);
      else {
        assert.match(response.toString("latin1"), /^HTTP\/1\.1 200 /);
        assert.equal(responseBody(response).toString(), "ok");
      }
    } finally {
      await close(server);
      restore();
    }
  }
});

test("Bun without upgrade listeners routes websocket-shaped requests normally", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.upgrade, "websocket");
    res.setHeader("Content-Length", "2");
    res.end("ok");
  });
  try {
    const port = await listen(server);
    const response = await sendRaw(port, Buffer.from([
      "GET /socket HTTP/1.1", `Host: 127.0.0.1:${port}`, "Connection: close, Upgrade", "Upgrade: websocket", "", "",
    ].join("\r\n")));
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 200 /);
    assert.equal(responseBody(response).toString(), "ok");
  } finally {
    await close(server);
    restore();
  }
});