const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

test("keeps pipelined h2c request bodies isolated on one socket", async () => {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const received = [];
  const server = http.createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
    received.push(parsed.reqId);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reqId: parsed.reqId }));
  });
  server.on("upgrade", (_req, socket) => socket.destroy());

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const bodyA = JSON.stringify({ model: "cx/gpt-5.6-luna", reqId: "A", stream: false });
    const bodyB = JSON.stringify({ model: "cx/gpt-5.6-luna", reqId: "B", stream: false });
    const request = (body) => [
      "POST /v1/chat/completions HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade, HTTP2-Settings",
      "Upgrade: h2c",
      "HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Content-Type: application/json",
      "",
      body,
    ].join("\r\n");

    const response = await new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        // Deliberately pipeline B in the same write. Its bytes arrive as head data
        // after A's body and must not be discarded by the downgrade wrapper.
        socket.end(`${request(bodyA)}${request(bodyB)}`);
      });
      socket.setTimeout(5_000, () => {
        socket.destroy();
        reject(new Error("same-socket h2c pipeline timed out"));
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });

    assert.deepEqual(received, ["A", "B"]);
    assert.match(response, /"reqId":"A"/);
    assert.match(response, /"reqId":"B"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    http.createServer = originalCreateServer;
  }
});
