const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("Bun client disconnect reaches NextRequest.signal and aborts BaseExecutor", { skip: !process.versions.bun }, async () => {
  const originalCreateServer = http.createServer;
  const upstreamServer = http.createServer(() => {});
  const upstreamPort = await listen(upstreamServer);

  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const { NextRequestAdapter, signalFromNodeResponse } = require("next/dist/server/web/spec-extension/adapters/next-request.js");
  const { NodeNextRequest } = require("next/dist/server/base-http/node.js");
  const { BaseExecutor } = await import("../../open-sse/executors/base.js");

  let resolveRequestSeen;
  const requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  let resolveExecutor;
  const executorDone = new Promise((resolve) => { resolveExecutor = resolve; });
  let nextRequestSignal;

  const server = http.createServer((req, res) => {
    const nextRequest = NextRequestAdapter.fromNodeNextRequest(
      new NodeNextRequest(req),
      signalFromNodeResponse(res),
    );
    nextRequestSignal = nextRequest.signal;
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
  });

  try {
    const port = await listen(server);
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
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
    await close(server);
    await close(upstreamServer);
    http.createServer = originalCreateServer;
  }
});
