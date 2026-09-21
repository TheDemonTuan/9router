const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

test("Bun propagates client socket close through request.signal", { skip: !process.versions.bun }, async () => {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  let requestSeen;
  let resolveRequestSeen;
  requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  let clientAborted;
  let resolveClientAborted;
  clientAborted = new Promise((resolve) => { resolveClientAborted = resolve; });

  const server = http.createServer((req, res) => {
    assert.ok(req.signal, "Bun request must expose an AbortSignal");
    resolveRequestSeen();
    req.signal.addEventListener("abort", () => {
      resolveClientAborted(req.signal.reason);
      res.destroy();
    }, { once: true });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(`GET /disconnect-check HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("error", () => {});

    await requestSeen;
    socket.destroy();
    await Promise.race([
      clientAborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("request.signal did not abort")), 2_000)),
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    http.createServer = originalCreateServer;
  }
});
