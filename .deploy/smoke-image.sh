#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 && "$1" =~ ^ghcr\.io/thedemontuan/9router@sha256:[0-9a-f]{64}$ ]] || { echo 'Expected immutable 9router image digest' >&2; exit 2; }
image_ref="$1"
echo 'Pulling freshly built image for runtime smoke test...'
docker pull "$image_ref"

cid="$(docker run -d \
  -e DATA_DIR=/tmp/9router-smoke \
  -e DEPLOY_SLOT=blue \
  "$image_ref")"

echo "Container ID: $cid"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

echo 'Waiting for health check (max 30s)...'
healthy=false
for i in $(seq 1 30); do
  if docker exec "$cid" wget -qO- http://127.0.0.1:20128/api/health 2>/dev/null | grep -q '"ok":true'; then
    healthy=true
    echo "Health check passed in ${i}s."
    break
  fi
  sleep 1
done

if [ "$healthy" != true ]; then
  echo 'Health check failed!'
  docker logs "$cid"
  exit 1
fi
docker exec "$cid" bun -e '
const assert = require("node:assert/strict");
const response = await fetch("http://127.0.0.1:20128/api/health");
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const health = await response.json();
assert.equal(health.ok, true);
assert.equal(health.deployment_slot, "blue");
'

echo 'Running native h2c image smoke...'
docker exec "$cid" bun -e '
const assert = require("node:assert/strict");
const http = require("node:http");
const HTTP2_SETTINGS = "AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA";
const headersFor = (body) => ({
  Connection: "keep-alive, Upgrade, HTTP2-Settings",
  Upgrade: "h2c",
  "HTTP2-Settings": HTTP2_SETTINGS,
  "Content-Type": "application/json",
  "Content-Length": Buffer.byteLength(body),
});
function post(agent, body, expectedStatus, expectedMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const request = http.request({
      host: "127.0.0.1",
      port: 20128,
      path: "/v1/chat/completions",
      method: "POST",
      agent,
      headers: headersFor(body),
    }, (response) => {
      const chunks = [];
      response.on("aborted", () => finish(new Error("response aborted")));
      response.on("error", finish);
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, expectedStatus);
          assert.equal(response.headers.upgrade, undefined);
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          assert.equal(parsed.error?.message, expectedMessage);
          finish();
        } catch (error) {
          finish(error);
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("request timed out")));
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      finish(new Error("unexpected HTTP upgrade"));
    });
    request.on("error", finish);
    request.end(body);
  });
}
async function chain(agent, prefix) {
  for (let index = 0; index < 3; index += 1) {
    const body = JSON.stringify({
      model: "cx/gpt-5.6-luna",
      messages: [{ role: "user", content: `${prefix}-${index}` }],
      stream: false,
    });
    await post(agent, body, 401, "Missing API key");
  }
}
const agents = [
  new http.Agent({ keepAlive: true, maxSockets: 1 }),
  new http.Agent({ keepAlive: true, maxSockets: 1 }),
];
try {
  await Promise.all([chain(agents[0], "smoke-a"), chain(agents[1], "smoke-b")]);
  await post(agents[0], "{", 400, "Invalid JSON body");
} finally {
  for (const agent of agents) agent.destroy();
}
'
echo 'Native h2c image smoke passed.'

echo 'Waiting 12s for initial background token refresh tick...'
sleep 12

logs="$(docker logs "$cid" 2>&1)"
printf '%s\n' "$logs"

if printf '%s\n' "$logs" | grep -E 'Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|BG_TOKEN_REFRESH.*Tick failed'; then
  echo 'Runtime smoke test failed: detected missing package or background refresh tick failure!'
  exit 1
fi

echo 'Runtime smoke test passed cleanly.'
