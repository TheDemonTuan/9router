import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);
const MODEL = "gemini-3.8-flash-high";
const RESET_MS = 48 * 60 * 60 * 1000;
const STRIKE_MS = 15 * 60 * 1000;
const SMOKE_PROXY = { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:1", strictProxy: false };

function quotaBody() {
  return JSON.stringify({ error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Request cannot be served",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "QUOTA_EXHAUSTED",
      metadata: { quotaResetTimeStamp: new Date(Number(process.env.SMOKE_NOW) + RESET_MS).toISOString() },
    }],
  } });
}

function installFetch(scenario, generationCounts) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = init.headers || {};
    const authorization = headers.Authorization || headers.authorization || "";
    const token = String(authorization).replace(/^Bearer\s+/i, "");
    if (url.includes(":generateContent")) {
      generationCounts[token] = (generationCounts[token] || 0) + 1;
      if (scenario === "quota" && /^ag-token-[1-5]$/.test(token)) {
        return new Response(quotaBody(), { status: 429 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
    }
    if (url.includes(":loadCodeAssist")) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: "smoke-project",
        currentTier: { name: "Pro" },
        paidTier: { id: "smoke-pro" },
      }), { status: 200 });
    }
    if (url.includes(":fetchAvailableModels")) {
      return new Response(JSON.stringify({ models: {
        [MODEL]: { quotaInfo: { remainingFraction: scenario === "breaker" ? 0.9 : 0.9, resetTime: "2099-01-01T00:00:00Z" } },
      } }), { status: 200 });
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
    }
    throw new Error(`Unexpected smoke URL: ${url}`);
  };
}

async function closeDb(resetAdapterForTest) {
  resetAdapterForTest();
}

async function quotaWrite(now, tempRoot) {
  const generationCounts = {};
  installFetch("quota", generationCounts);
  const { createProviderConnection, getProviderConnectionById } = await import("../../src/lib/db/index.js");
  const { getAdapter, resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
  const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
  const { markAccountUnavailable, persistModelLocksBatch } = await import("../../src/sse/services/auth.js");
  const ids = [];
  const batchLocks = [
    { model: "gemini-3.8-flash-high", resetMs: now + RESET_MS },
    { model: "claude-sonnet-4-6", resetMs: now + RESET_MS },
  ];
  for (let index = 1; index <= 7; index++) {
    const connection = await createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      email: `quota-${index}@smoke.invalid`,
      accessToken: `ag-token-${index}`,
      projectId: "smoke-project",
      priority: index,
    });
    ids.push(connection.id);
  }

  for (let index = 0; index < 5; index++) {
    const executor = new AntigravityExecutor();
    executor.config.baseUrls = ["https://smoke.invalid"];
    const result = await executor.execute({
      model: MODEL,
      body: { request: { contents: [] } },
      stream: false,
      credentials: { accessToken: `ag-token-${index + 1}`, projectId: "smoke-project" },
    });
    const parsed = await parseUpstreamError(result.response, executor);
    assert.equal(parsed.errorClass, "quota_exhausted");
    assert.equal(parsed.retryable, false);
    await markAccountUnavailable(ids[index], parsed.statusCode, parsed.message, "antigravity", MODEL, parsed.resetsAtMs, parsed.errorClass);
  }

  assert.deepEqual(generationCounts, {
    "ag-token-1": 1,
    "ag-token-2": 1,
    "ag-token-3": 1,
    "ag-token-4": 1,
    "ag-token-5": 1,
  });
  const first = await getProviderConnectionById(ids[0]);
  assert.equal(first[`modelLock_${MODEL}`], new Date(now + RESET_MS).toISOString());
  assert.equal(first[`modelLockReason_${MODEL}`], "quota_exhausted");
  assert.deepEqual(await persistModelLocksBatch(ids[6], batchLocks), { changed: 2 });
  const adapter = await getAdapter();
  const beforeReplay = adapter.get("SELECT updatedAt, data FROM providerConnections WHERE id = ?", [ids[6]]);
  const changesBefore = adapter.get("SELECT total_changes() AS n").n;
  const replayLogs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => replayLogs.push(args.join(" "));
  console.warn = (...args) => replayLogs.push(args.join(" "));
  console.error = (...args) => replayLogs.push(args.join(" "));
  let replay;
  let changesAfter;
  try {
    replay = await persistModelLocksBatch(ids[6], batchLocks);
    changesAfter = adapter.get("SELECT total_changes() AS n").n;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  const afterReplay = adapter.get("SELECT updatedAt, data FROM providerConnections WHERE id = ?", [ids[6]]);
  assert.equal(replay.changed, 0);
  assert.equal(changesAfter - changesBefore, 0);
  assert.equal(afterReplay.updatedAt, beforeReplay.updatedAt);
  assert.equal(replayLogs.some((line) => /AG_QUOTA|WARN|ERROR/.test(line)), false);
  assert.equal(JSON.parse(afterReplay.data).lastErrorAt, JSON.parse(beforeReplay.data).lastErrorAt);
  console.log("PASS batch replay no-write");
  fs.writeFileSync(path.join(tempRoot, "quota-ids.json"), JSON.stringify(ids));
  await closeDb(resetAdapterForTest);
  console.log("PASS one-call quota");
  console.log("PASS durable timestamp");
}

async function quotaRead(now, tempRoot) {
  const ids = JSON.parse(fs.readFileSync(path.join(tempRoot, "quota-ids.json"), "utf8"));
  const generationCounts = {};
  installFetch("quota", generationCounts);
  const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
  const { credentialUnavailableResponse } = await import("../../open-sse/utils/error.js");
  const { getProviderConnectionById } = await import("../../src/lib/db/index.js");
  const { resetAdapterForTest } = await import("../../src/lib/db/driver.js");

  const healthy = await getProviderCredentials("antigravity", null, MODEL);
  assert.equal(healthy.connectionId, ids[5]);
  const executor = new AntigravityExecutor();
  executor.config.baseUrls = ["https://smoke.invalid"];
  const result = await executor.execute({
    model: MODEL,
    body: { request: { contents: [] } },
    stream: false,
    credentials: { accessToken: healthy.accessToken, projectId: "smoke-project" },
  });
  assert.equal(result.response.status, 200);
  assert.equal(generationCounts["ag-token-6"], 1);
  console.log("PASS fresh-process skip");
  console.log("PASS healthy-only generation");

  await markAccountUnavailable(ids[5], 429, "quota", "antigravity", MODEL, now + RESET_MS, "quota_exhausted");
  const allLocked = await getProviderCredentials("antigravity", null, MODEL);
  assert.equal(allLocked.unavailabilityReason, "quota_exhausted");
  const terminal = credentialUnavailableResponse(503, "quota", allLocked);
  assert.equal(terminal.status, 429);
  assert.equal(terminal.headers.get("x-should-retry"), "false");
  assert.equal(terminal.headers.get("x-9router-error-code"), "provider_quota_exhausted");
  assert.equal(terminal.headers.get("Retry-After"), null);

  Date.now = () => now + RESET_MS;
  const rotated = await getProviderCredentials("antigravity", null, MODEL);
  assert.equal(rotated.connectionId, ids[0]);
  await clearAccountError(rotated.connectionId, rotated, MODEL);
  const cleared = await getProviderConnectionById(ids[0]);
  assert.equal(cleared[`modelLock_${MODEL}`], null);
  assert.equal(cleared[`modelLockReason_${MODEL}`], null);
  await closeDb(resetAdapterForTest);
}

async function breakerWrite(now, tempRoot) {
  const generationCounts = {};
  installFetch("breaker", generationCounts);
  const { createProviderConnection } = await import("../../src/lib/db/index.js");
  const { resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  const { handleAntigravityQuotaError } = await import("../../src/sse/services/antigravityQuota.js");
  const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
  const connection = await createProviderConnection({ provider: "antigravity", authType: "oauth", email: "breaker@smoke.invalid", accessToken: "breaker-token", projectId: "smoke-project" });
  for (const [offset, status] of [[0, 429], [3_000, 409], [6_000, 429]]) {
    Date.now = () => now + offset;
    const evidence = await handleAntigravityQuotaError(connection.id, status, MODEL, "breaker-token", SMOKE_PROXY);
    await markAccountUnavailable(connection.id, status, "too many requests", "antigravity", MODEL, evidence?.resetsAtMs || null, evidence?.errorClass || null);
    if (offset === 6_000) assert.deepEqual(evidence, { resetsAtMs: now + 6_000 + STRIKE_MS, errorClass: "rate_limited" });
  }
  const { getProviderConnectionById } = await import("../../src/lib/db/index.js");
  const row = await getProviderConnectionById(connection.id);
  assert.equal(row[`modelLock_${MODEL}`], new Date(now + 6_000 + STRIKE_MS).toISOString());
  assert.equal(row[`modelLockReason_${MODEL}`], "rate_limited");
  fs.writeFileSync(path.join(tempRoot, "breaker-id.json"), JSON.stringify(connection.id));
  await closeDb(resetAdapterForTest);
  console.log("PASS breaker durable");
}

async function breakerRead(now, tempRoot) {
  const id = JSON.parse(fs.readFileSync(path.join(tempRoot, "breaker-id.json"), "utf8"));
  installFetch("breaker", {});
  const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
  const { refreshAntigravityQuota } = await import("../../src/sse/services/antigravityQuota.js");
  const { credentialUnavailableResponse } = await import("../../open-sse/utils/error.js");
  const { resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  Date.now = () => now + 6_000;
  const locked = await getProviderCredentials("antigravity", null, MODEL);
  assert.equal(locked.allRateLimited, true);
  assert.equal(locked.unavailabilityReason, "rate_limited");
  const response = credentialUnavailableResponse(503, "busy", locked);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), String(Math.ceil((15 * 60_000) / 1000)));
  const snapshot = await refreshAntigravityQuota(id, "breaker-token", SMOKE_PROXY);
  assert.equal(snapshot[MODEL].remainingPercentage, 90);
  Date.now = () => now + 6_000 + STRIKE_MS;
  const available = await getProviderCredentials("antigravity", null, MODEL);
  assert.equal(available.connectionId, id);
  await closeDb(resetAdapterForTest);
  console.log("PASS breaker restart");
}

async function childMain([phase, scenario, tempRoot, nowText]) {
  const now = Number(nowText);
  process.env.SMOKE_NOW = String(now);
  Date.now = () => now;
  if (phase === "write" && scenario === "quota") return quotaWrite(now, tempRoot);
  if (phase === "read" && scenario === "quota") return quotaRead(now, tempRoot);
  if (phase === "write" && scenario === "breaker") return breakerWrite(now, tempRoot);
  if (phase === "read" && scenario === "breaker") return breakerRead(now, tempRoot);
  throw new Error(`Unknown smoke phase: ${phase}/${scenario}`);
}

function runChild(phase, scenario, tempRoot, now) {
  const env = { ...process.env, DATA_DIR: tempRoot, HOME: tempRoot, USERPROFILE: tempRoot, APPDATA: tempRoot, SMOKE_NOW: String(now), NO_PROXY: "*" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  const jsconfig = path.join(repoRoot, "jsconfig.json");
  const child = spawnSync(process.execPath, ["--no-env-file", "--no-install", "--tsconfig-override", jsconfig, scriptPath, phase, scenario, tempRoot, String(now)], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${phase}/${scenario} failed (${child.status})\n${child.stdout}\n${child.stderr}`);
  }
  process.stdout.write(child.stdout);
}

if (process.argv[2]) {
  await childMain(process.argv.slice(2));
  process.exit(0);
} else {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-smoke-"));
  const quotaRoot = fs.mkdtempSync(path.join(tempRoot, "quota-"));
  const breakerRoot = fs.mkdtempSync(path.join(tempRoot, "breaker-"));
  const now = Date.parse("2026-09-23T00:00:00.000Z");
  try {
    runChild("write", "quota", quotaRoot, now);
    runChild("read", "quota", quotaRoot, now);
    runChild("write", "breaker", breakerRoot, now);
    runChild("read", "breaker", breakerRoot, now);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
