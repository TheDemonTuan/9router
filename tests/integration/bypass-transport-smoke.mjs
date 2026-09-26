import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createTlsServer } from "node:https";
import { createServer as createProxyServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { Resolver } from "node:dns";
import { fileURLToPath } from "node:url";
import { generate } from "selfsigned";

const host = "daily-cloudcode-pa.googleapis.com";
if (!process.env.BYPASS_SMOKE_CHILD) {
  const dir = mkdtempSync(join(tmpdir(), "9router-bypass-"));
  try {
    const cert = await generate([{ name: "commonName", value: host }], {
      days: 1, keySize: 2048, extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: host }] }],
    });
    writeFileSync(join(dir, "cert.pem"), cert.cert);
    writeFileSync(join(dir, "key.pem"), cert.private);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir], {
      cwd: process.cwd(), encoding: "utf8", timeout: 8000,
      env: { ...process.env, BYPASS_SMOKE_CHILD: "1", NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"), NO_PROXY: "", no_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    assert.equal(child.status, 0, `child status ${child.status}: ${child.error || child.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  const dir = process.argv[2];
  const probeResolver = new Resolver();
  let prototype = Object.getPrototypeOf(probeResolver);
  while (prototype && !Object.hasOwn(prototype, "resolve4")) prototype = Object.getPrototypeOf(prototype);
  assert.ok(prototype);
  prototype.resolve4 = function (_hostname, callback) { callback(null, ["127.0.0.1"]); };
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  let connections = 0;
  let requests = 0;
  const requestSockets = [];
  const server = createTlsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    requests++;
    requestSockets.push(req.socket);
    if (req.url === "/hold") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n"); return; }
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok");
  });
  server.on("connection", () => { connections++; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `https://${host}:${server.address().port}`;
  const untrusted = await generate([{ name: "commonName", value: host }], {
    days: 1, keySize: 2048, extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: host }] }],
  });
  const wrongCa = createTlsServer({ key: untrusted.private, cert: untrusted.cert }, (_req, res) => res.end("unsafe"));
  await new Promise(resolve => wrongCa.listen(0, "127.0.0.1", resolve));
  let connectCount = 0;
  const proxy = createProxyServer();
  proxy.on("connect", (_request, client, head) => {
    connectCount++;
    const upstream = connect(server.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyOptions = { enabled: true, url: `http://127.0.0.1:${proxy.address().port}`, strictProxy: true };
  try {
    const before = new AbortController();
    before.abort(new Error("already aborted"));
    await assert.rejects(proxyAwareFetch(url, { signal: before.signal }), /already aborted/);
    assert.equal(requests, 0);
    await assert.rejects(proxyAwareFetch(`https://${host}.invalid:${server.address().port}`, { signal: AbortSignal.timeout(1500) }), error => {
      assert.match(String(error.cause?.code || error.code), /CERT|TLS|SSL/);
      return true;
    });
    await assert.rejects(proxyAwareFetch(`https://${host}:${wrongCa.address().port}`, { signal: AbortSignal.timeout(1500) }), error => {
      assert.match(String(error.cause?.code || error.code), /CERT|TLS|SSL|SELF_SIGNED/);
      return true;
    });
    for (let i = 0; i < 2; i++) {
      const response = await proxyAwareFetch(url);
      assert.equal(response.headers.get("Content-Type"), "text/plain");
      assert.equal(await response.text(), "ok");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(requestSockets[0], requestSockets[1], "sequential requests must reuse the same TLS connection");
    const viaProxy = await proxyAwareFetch(url, {}, proxyOptions);
    assert.equal(await viaProxy.text(), "ok");
    assert.equal(connectCount, 1);
    await assert.rejects(proxyAwareFetch(url, {}, { ...proxyOptions, url: "http://127.0.0.1:1" }), /strictProxy=true/);
    assert.equal(requests, 3, "strict proxy failure must not connect directly");
    const response = await proxyAwareFetch(`${url}/hold`);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    const closed = once(requestSockets.at(-1), "close");
    await reader.cancel();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("canceled body kept socket open")), 500))]);
    assert.equal(requests, 4);
    console.log("bypass TLS hostname, CA, pooling, pre-abort, cancellation, CONNECT, strictProxy: OK");
  } finally {
    proxy.closeAllConnections?.();
    await new Promise(resolve => proxy.close(resolve));
    wrongCa.closeAllConnections?.();
    await new Promise(resolve => wrongCa.close(resolve));
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}
