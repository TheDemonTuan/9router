const assert = require("node:assert/strict");
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

function requestBlock(port, body, connection) {
  return [
    "POST /v1/chat/completions HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Connection: ${connection}, Upgrade, HTTP2-Settings`,
    "Upgrade: h2c",
    `HTTP2-Settings: ${HTTP2_SETTINGS}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Content-Type: application/json",
    "",
    body,
  ].join("\r\n");
}

function decodeResponses(buffer) {
  const responses = [];
  let offset = 0;
  while (offset < buffer.length) {
    const headerEndRelative = buffer.subarray(offset).indexOf(Buffer.from("\r\n\r\n"));
    assert.notEqual(headerEndRelative, -1, "response headers missing");
    const headerEnd = offset + headerEndRelative;
    const headerText = buffer.subarray(offset, headerEnd).toString("latin1");
    const statusMatch = /^HTTP\/1\.1 (\d{3}) [^\r\n]+/.exec(headerText);
    assert.ok(statusMatch, "invalid HTTP response status");
    const lengthMatch = /\r\ncontent-length: (\d+)\r\n/i.exec(headerText);
    assert.ok(lengthMatch, "response Content-Length missing");
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    assert.ok(bodyEnd <= buffer.length, "response body truncated");
    responses.push({
      status: Number(statusMatch[1]),
      headers: headerText,
      body: buffer.subarray(bodyStart, bodyEnd),
    });
    offset = bodyEnd;
  }
  assert.equal(offset, buffer.length, "response contains trailing bytes");
  return responses;
}

function collectSocket(port, payload, sockets, onData = () => {}) {
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
      finish(new Error("h2c pipeline timed out"));
    });
    socket.on("connect", () => {
      // Deliberately do not end here: only the final request's close token ends the session.
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      onData(Buffer.concat(chunks));
    });
    socket.on("end", () => finish(null, Buffer.concat(chunks)));
    socket.on("error", (error) => finish(error));
  });
}

function agentRequest(port, body, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      agent,
      headers: {
        Connection: "keep-alive, Upgrade, HTTP2-Settings",
        Upgrade: "h2c",
        "HTTP2-Settings": HTTP2_SETTINGS,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      const socket = req.socket;
      res.on("aborted", () => reject(new Error("agent response aborted")));
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ response: res, socket, body: Buffer.concat(chunks) }));
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("agent request unexpectedly upgraded"));
    });
    req.once("error", reject);
    req.end(body);
  });
}

test("keeps pipelined h2c request bodies and response attribution isolated", { timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const sockets = new Set();
  let rejectHandler;
  const handlerFailure = new Promise((_, reject) => { rejectHandler = reject; });
  const received = [];
  const server = http.createServer(async (req, res) => {
    try {
      const { nextRequest, parsed } = await nextJson(req, res);
      received.push({ parsed, signal: nextRequest.signal });
      const body = JSON.stringify({ reqId: parsed.reqId });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(body));
      await new Promise((resolve) => {
        res.once("finish", resolve);
        res.end(body);
      });
      assert.equal(nextRequest.signal.aborted, false);
    } catch (error) {
      rejectHandler(error);
      if (!res.destroyed) res.destroy();
    }
  });
  server.on("upgrade", (_req, socket) => {
    rejectHandler(new Error("pipelined h2c request reached upgrade listener"));
    socket.destroy();
  });
  try {
    const port = await listen(server);
    const bodyA = JSON.stringify({ model: MODEL, reqId: "A", stream: false });
    const bodyB = JSON.stringify({ model: MODEL, reqId: "B", stream: false });
    const payload = Buffer.from(`${requestBlock(port, bodyA, "keep-alive")}${requestBlock(port, bodyB, "close")}`);
    const responseBuffer = await Promise.race([
      collectSocket(port, payload, sockets),
      handlerFailure,
    ]);
    assert.deepEqual(received.map(({ parsed }) => parsed), [
      { model: MODEL, reqId: "A", stream: false },
      { model: MODEL, reqId: "B", stream: false },
    ]);
    const responses = decodeResponses(responseBuffer);
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map(({ status, body }) => ({ status, body: JSON.parse(body) })), [
      { status: 200, body: { reqId: "A" } },
      { status: 200, body: { reqId: "B" } },
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
    restore();
  }
});

test("Bun reuses one keep-alive socket for sequential h2c requests", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const server = http.createServer(async (req, res) => {
    try {
      const { nextRequest, parsed } = await nextJson(req, res);
      const body = JSON.stringify({ reqId: parsed.reqId });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(body));
      await new Promise((resolve) => {
        res.once("finish", resolve);
        res.end(body);
      });
      assert.equal(nextRequest.signal.aborted, false);
    } catch (error) {
      if (!res.destroyed) res.destroy(error);
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  try {
    const port = await listen(server);
    const first = await agentRequest(port, JSON.stringify({ model: MODEL, reqId: "A", stream: false }), agent);
    const second = await agentRequest(port, JSON.stringify({ model: MODEL, reqId: "B", stream: false }), agent);
    assert.equal(first.response.statusCode, 200);
    assert.equal(second.response.statusCode, 200);
    assert.deepEqual(JSON.parse(first.body), { reqId: "A" });
    assert.deepEqual(JSON.parse(second.body), { reqId: "B" });
    assert.equal(first.socket, second.socket);
  } finally {
    agent.destroy();
    await close(server);
    restore();
  }
});

test("Bun keeps two pipelined ZCode sessions ordered with overlapping streams", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const sockets = new Set();
  let rejectHandler;
  const handlerFailure = new Promise((_, reject) => { rejectHandler = reject; });
  const firstFrameSessions = new Set();
  let resolveFirstFrames;
  const firstFrames = new Promise((resolve) => { resolveFirstFrames = resolve; });
  const seenSignals = [];
  const server = http.createServer(async (req, res) => {
    try {
      const { nextRequest, parsed } = await nextJson(req, res);
      seenSignals.push(nextRequest.signal);
      const id = parsed.reqId;
      if (parsed.purpose === "main_turn") {
        const first = `data: ${JSON.stringify({ reqId: id, session_id: parsed.session_id })}\n\n`;
        const last = "data: [DONE]\n\n";
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Content-Length", Buffer.byteLength(first) + Buffer.byteLength(last));
        res.write(first);
        await firstFrames;
        res.end(last);
      } else {
        const body = JSON.stringify({ reqId: id, session_id: parsed.session_id, purpose: parsed.purpose });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      }
      await new Promise((resolve) => res.once("finish", resolve));
      assert.equal(nextRequest.signal.aborted, false);
    } catch (error) {
      rejectHandler(error);
      if (!res.destroyed) res.destroy();
    }
  });
  server.on("upgrade", (_req, socket) => {
    rejectHandler(new Error("ZCode h2c request reached upgrade listener"));
    socket.destroy();
  });
  const sessions = ["zcode-cli-a", "zcode-cli-b"];
  try {
    const port = await listen(server);
    const payloads = sessions.map((sessionId) => {
      const requests = [
        ["session_title", false],
        ["main_turn", true],
        ["project_memory", false],
      ];
      return Buffer.from(requests.map(([purpose, stream], index) => {
        const body = JSON.stringify({
          model: MODEL,
          session_id: sessionId,
          purpose,
          stream,
          reqId: `${sessionId}:${purpose}`,
        });
        return requestBlock(port, body, index === requests.length - 1 ? "close" : "keep-alive");
      }).join(""));
    });
    const responses = await Promise.race([
      Promise.all(payloads.map((payload, index) => collectSocket(port, payload, sockets, (buffer) => {
        const sessionId = sessions[index];
        const frame = Buffer.from(`data: ${JSON.stringify({ reqId: `${sessionId}:main_turn`, session_id: sessionId })}\n\n`);
        if (buffer.indexOf(frame) !== -1 && !firstFrameSessions.has(sessionId)) {
          firstFrameSessions.add(sessionId);
          if (firstFrameSessions.size === sessions.length) resolveFirstFrames();
        }
      }))),
      handlerFailure,
    ]);
    assert.equal(firstFrameSessions.size, 2);
    assert.equal(responses.length, 2);
    assert.equal(seenSignals.length, 6);
    for (const responseBuffer of responses) {
      const decoded = decodeResponses(responseBuffer);
      assert.equal(decoded.length, 3);
      assert.deepEqual(decoded.map(({ status }) => status), [200, 200, 200]);
      const title = JSON.parse(decoded[0].body);
      assert.match(title.session_id, /^zcode-cli-[ab]$/);
      assert.deepEqual(title, {
        reqId: `${title.session_id}:session_title`,
        session_id: title.session_id,
        purpose: "session_title",
      });
      const streamBody = decoded[1].body.toString();
      assert.match(decoded[1].headers, /content-type: text\/event-stream/i);
      assert.equal(streamBody, `data: ${JSON.stringify({ reqId: `${title.session_id}:main_turn`, session_id: title.session_id })}\n\ndata: [DONE]\n\n`);
      const memory = JSON.parse(decoded[2].body);
      assert.deepEqual(memory, {
        reqId: `${title.session_id}:project_memory`,
        session_id: title.session_id,
        purpose: "project_memory",
      });
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
    restore();
  }
});