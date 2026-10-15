import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
let origin, proxy, original, origins, proxies, connects;
beforeEach(async () => {
  original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  origins = 0; proxies = 0; connects = 0;
  origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { origins++; return new Response("direct-origin"); } });
  proxy = createServer((request, response) => { proxies++; response.end("selected-proxy"); });
  proxy.on("connect", (request, socket) => { connects++; socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  for (const key of keys) process.env[key] = /no_proxy/i.test(key) ? "" : `http://127.0.0.1:${proxy.address().port}`;
});
afterEach(async () => {
  origin.stop(true); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it("does not let environment NO_PROXY bypass an explicitly selected connection proxy", async () => {
  process.env.NO_PROXY = "*"; process.env.no_proxy = "*";
  const response = await proxyAwareFetch(origin.url.href, {}, { enabled: true, url: `http://127.0.0.1:${proxy.address().port}` });
  expect(await response.text()).toBe("selected-proxy");
  expect(origins).toBe(0); expect(proxies).toBe(1);
});

it("falls back directly once without re-reading the environment proxy", async () => {
  const response = await proxyAwareFetch(origin.url.href, {}, { enabled: true, url: "http://127.0.0.1:1" });
  expect(await response.text()).toBe("direct-origin");
  expect(origins).toBe(1); expect(proxies).toBe(0);
});

it("fails closed on a strict proxy connection failure", async () => {
  await expect(proxyAwareFetch(origin.url.href, {}, { enabled: true, url: "http://127.0.0.1:1", strictProxy: true })).rejects.toThrow();
  expect(origins).toBe(0); expect(proxies).toBe(0);
});

it("treats CONNECT 407 as a transport failure, not an origin response", async () => {
  await expect(proxyAwareFetch(`https://127.0.0.1:${origin.port}/`, {}, { enabled: true, url: `http://127.0.0.1:${proxy.address().port}`, strictProxy: true })).rejects.toThrow();
  expect(connects).toBe(1); expect(origins).toBe(0);
});
