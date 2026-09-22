const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

const HTTP2_SETTINGS = "AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA";
const NEXT_ADAPTER_PATH = "next/dist/server/web/spec-extension/adapters/next-request.js";
const NODE_REQUEST_PATH = "next/dist/server/base-http/node.js";

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

function installCustomServer() {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");
  return () => {
    http.createServer = originalCreateServer;
    delete require.cache[require.resolve("../../custom-server.js")];
  };
}

function nextRequestFor(req, res) {
  const { NextRequestAdapter, signalFromNodeResponse } = require(NEXT_ADAPTER_PATH);
  const { NodeNextRequest } = require(NODE_REQUEST_PATH);
  return NextRequestAdapter.fromNodeNextRequest(
    new NodeNextRequest(req),
    signalFromNodeResponse(res),
  );
}

function h2cRequest(port, body) {
  const headers = Buffer.from([
    "POST /v1/chat/completions HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Connection: close, Upgrade, HTTP2-Settings",
    "Upgrade: h2c",
    `HTTP2-Settings: ${HTTP2_SETTINGS}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    "",
  ].join("\r\n"));
  return Buffer.concat([headers, Buffer.from(body)]);
}

test("Bun client disconnect reaches NextRequest.signal and aborts BaseExecutor", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const originalCreateServer = http.createServer;
  const upstreamServer = http.createServer(() => {});
  const upstreamPort = await listen(upstreamServer);

  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const { BaseExecutor } = await import("../../open-sse/executors/base.js");
  let resolveRequestSeen;
  const requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  let resolveExecutor;
  const executorDone = new Promise((resolve) => { resolveExecutor = resolve; });
  let nextRequestSignal;
  const server = http.createServer((req, res) => {
    nextRequestSignal = nextRequestFor(req, res).signal;
    resolveRequestSeen();
    const executor = new BaseExecutor("test", {
      baseUrl: `http://127.0.0.1:${upstreamPort}/hang`,
      timeoutMs: 5_000,
      retry: { 502: { attempts: 0 }, 504: { attempts: 0 } },
    });
    executor.execute({
      model: "test-model",
      body: { model: "test-model", messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: {},
      signal: nextRequestSignal,
    }).then(
      () => { resolveExecutor(new Error("executor unexpectedly succeeded")); res.end("unexpected success"); },
      (error) => { resolveExecutor(error); res.destroy(); },
    );
  });

  let socket;
  try {
    const port = await listen(server);
    socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const body = JSON.stringify({ model: "test-model" });
      socket.write([
        "POST /v1/chat/completions HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: keep-alive",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ].join("\r\n"));
    });
    socket.on("error", () => {});

    await requestSeen;
    socket.destroy();

    const error = await Promise.race([
      executorDone,
      new Promise((_, reject) => setTimeout(() => reject(new Error("BaseExecutor did not abort")), 2_000)),
    ]);
    assert.equal(error.code, "CLIENT_ABORT");
    assert.equal(error.status, 499);
    assert.equal(nextRequestSignal.aborted, true);
  } finally {
    socket?.destroy();
    await close(server);
    await close(upstreamServer);
    http.createServer = originalCreateServer;
    delete require.cache[require.resolve("../../custom-server.js")];
  }
});

test("Bun h2c disconnect after NextRequest JSON parse aborts the executor", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const upstreamServer = http.createServer(() => {});
  const upstreamPort = await listen(upstreamServer);
  const { BaseExecutor } = await import("../../open-sse/executors/base.js");
  let resolveRequestSeen;
  const requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  let resolveExecutor;
  const executorDone = new Promise((resolve) => { resolveExecutor = resolve; });
  let nextRequestSignal;
  let handlerFailure;
  const failure = new Promise((_, reject) => { handlerFailure = reject; });
  const server = http.createServer(async (req, res) => {
    try {
      const nextRequest = nextRequestFor(req, res);
      nextRequestSignal = nextRequest.signal;
      assert.deepEqual(await nextRequest.json(), { model: "test-model" });
      resolveRequestSeen();
      const executor = new BaseExecutor("test", {
        baseUrl: `http://127.0.0.1:${upstreamPort}/hang`,
        timeoutMs: 5_000,
        retry: { 502: { attempts: 0 }, 504: { attempts: 0 } },
      });
      executor.execute({
        model: "test-model",
        body: { model: "test-model", messages: [{ role: "user", content: "hello" }] },
        stream: false,
        credentials: {},
        signal: nextRequest.signal,
      }).then(
        () => { resolveExecutor(new Error("executor unexpectedly succeeded")); res.end("unexpected success"); },
        (error) => { resolveExecutor(error); res.destroy(); },
      );
    } catch (error) {
      handlerFailure(error);
      if (!res.destroyed) res.destroy();
    }
  });
  server.on("upgrade", (_req, socket) => {
    handlerFailure(new Error("h2c request reached upgrade listener"));
    socket.destroy();
  });

  let socket;
  try {
    const port = await listen(server);
    const body = JSON.stringify({ model: "test-model" });
    socket = net.createConnection({ host: "127.0.0.1", port }, () => socket.write(h2cRequest(port, body)));
    socket.on("error", () => {});
    await Promise.race([requestSeen, failure]);
    socket.destroy();
    const error = await Promise.race([
      executorDone,
      new Promise((_, reject) => setTimeout(() => reject(new Error("h2c BaseExecutor did not abort")), 2_000)),
    ]);
    assert.equal(error.code, "CLIENT_ABORT");
    assert.equal(error.status, 499);
    assert.equal(nextRequestSignal.aborted, true);
  } finally {
    socket?.destroy();
    await close(server);
    await close(upstreamServer);
    restore();
  }
});

test("Bun completed normal POST keeps NextRequest signals live through response finish", { skip: !process.versions.bun, timeout: 5_000 }, async () => {
  const restore = installCustomServer();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let parsedSignal;
  let rawSignal;
  const server = http.createServer(async (req, res) => {
    try {
      rawSignal = req.signal;
      const nextRequest = nextRequestFor(req, res);
      parsedSignal = nextRequest.signal;
      assert.equal(rawSignal.aborted, false);
      assert.equal(parsedSignal.aborted, false);
      const parsed = await nextRequest.json();
      assert.deepEqual(parsed, { model: "test-model" });
      assert.equal(parsedSignal.aborted, false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(parsedSignal.aborted, false);
      const responseBody = JSON.stringify({ ok: true });
      const finished = new Promise((resolve) => res.once("finish", resolve));
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(responseBody));
      res.end(responseBody);
      await finished;
      assert.equal(parsedSignal.aborted, false);
    } catch (error) {
      if (!res.destroyed) res.destroy();
    }
  });
  try {
    const port = await listen(server);
    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: "test-model" });
      const request = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        agent,
        headers: {
          Connection: "keep-alive",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      request.end(body);
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { ok: true });
    assert.equal(parsedSignal.aborted, false);
  } finally {
    agent.destroy();
    await close(server);
    restore();
  }
});