const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

test("serves h2c POST requests concurrently without cross-talk or corruption", async () => {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.connection, "close");
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const parsed = JSON.parse(Buffer.concat(body).toString("utf8"));

    if (!parsed.stream) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ title: parsed.reqId }));
    } else {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ chunk: parsed.reqId })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;

    const makeH2cRequest = (reqId, purpose, isStream) => {
      return new Promise((resolve, reject) => {
        const chunks = [];
        const body = JSON.stringify({ model: "cx/gpt-5.6-luna", purpose, reqId, stream: isStream });
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.write([
            "POST /v1/chat/completions HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade, HTTP2-Settings",
            "Upgrade: h2c",
            "HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Content-Type: application/json",
            "",
            "",
          ].join("\r\n"));
          setImmediate(() => socket.write(body));
        });
        socket.setTimeout(5_000, () => {
          socket.destroy();
          reject(new Error(`h2c request ${reqId} timed out`));
        });
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });
    };

    // Send 6 concurrent requests (mix of title, memory, main turn)
    const requests = [
      makeH2cRequest("CLI_A_TITLE", "session_title", false),
      makeH2cRequest("CLI_A_MAIN", "main_turn", true),
      makeH2cRequest("CLI_A_MEMORY", "project_memory", false),
      makeH2cRequest("CLI_B_TITLE", "session_title", false),
      makeH2cRequest("CLI_B_MAIN", "main_turn", true),
      makeH2cRequest("CLI_B_MEMORY", "project_memory", false),
    ];

    const responses = await Promise.all(requests);

    // Verify response isolation: each response matches its own reqId
    assert.match(responses[0], /"title":"CLI_A_TITLE"/);
    assert.match(responses[1], /"chunk":"CLI_A_MAIN"/);
    assert.match(responses[2], /"title":"CLI_A_MEMORY"/);
    assert.match(responses[3], /"title":"CLI_B_TITLE"/);
    assert.match(responses[4], /"chunk":"CLI_B_MAIN"/);
    assert.match(responses[5], /"title":"CLI_B_MEMORY"/);

    for (const resp of responses) {
      assert.match(resp, /^HTTP\/1\.1 200 OK\r\n/);
      assert.match(resp, /\r\nConnection: close\r\n/i);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    http.createServer = originalCreateServer;
  }
});
