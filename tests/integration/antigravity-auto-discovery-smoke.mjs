import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = fileURLToPath(import.meta.url);

process.env.DISABLE_MITM_DNS_BYPASS = "true";

let smokeFuturePromoted = false;
let recordedGenerationBodies = [];
let recordedManifestHeaders = [];

installSmokeFetch();

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

function getAuthToken(headers) {
  const auth = getHeader(headers, "Authorization") || getHeader(headers, "authorization") || "";
  return String(auth).replace(/^Bearer\s+/i, "");
}

function installSmokeFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const headers = init.headers || input?.headers || {};
    const token = getAuthToken(headers);

    if (url.includes("manifest")) {
      recordedManifestHeaders.push(headers);
      return new Response("version: 2.19.1\n", { status: 200 });
    }

    if (url.includes(":loadCodeAssist")) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: "smoke-project",
        currentTier: { name: "Pro" },
        paidTier: { id: "smoke-pro" },
      }), { status: 200 });
    }

    if (url.includes(":retrieveUserQuotaSummary")) {
      return new Response(JSON.stringify({ groups: [] }), { status: 200 });
    }

    if (url.includes(":fetchAvailableModels")) {
      const ua = getHeader(headers, "User-Agent") || getHeader(headers, "user-agent");
      const isHub = ua.includes("antigravity/hub/2.19.1");

      if (token === "token-a") {
        return new Response(JSON.stringify({
          models: {
            "gemini-2.5-pro": {
              displayName: "Gemini 2.5 Pro",
              maxTokens: 1000000,
              maxOutputTokens: 64000,
            },
          },
        }), { status: 200 });
      }

      if (token === "token-b") {
        return new Response(JSON.stringify({
          models: {
            "gemini-2.5-pro": {
              displayName: "Gemini 2.5 Pro",
              maxTokens: 1000000,
              maxOutputTokens: 64000,
            },
            ...(isHub ? {
              "claude-sonnet-5-5": {
                displayName: "Claude Sonnet 5.5",
                maxTokens: 200000,
                maxOutputTokens: 64000,
                supportsImages: true,
                supportsThinking: true,
              },
            } : {}),
            ...(smokeFuturePromoted ? {
              "claude-sonnet-99-1": {
                displayName: "Claude Sonnet 99.1",
                maxTokens: 500000,
                maxOutputTokens: 64000,
              },
            } : {}),
          },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ models: {} }), { status: 200 });
    }
    if (url.includes(":generateContent") || url.includes(":streamGenerateContent")) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      recordedGenerationBodies.push({
        url,
        token,
        body,
      });

      const responsePayload = {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "ok" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        },
      };

      if (url.includes("streamGenerateContent")) {
        const streamText = `data: ${JSON.stringify(responsePayload)}\n\n`;
        return new Response(streamText, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected smoke URL: ${url}`);
  };
}

async function runChildSmoke() {
  installSmokeFetch();

  const { createProviderConnection, updateProviderConnection } = await import("../../src/lib/db/index.js");
  const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
  const { GET: getProviderModels } = await import("../../src/app/api/providers/[id]/models/route.js");
  const { GET: getModels } = await import("../../src/app/api/models/route.js");
  const { GET: getV1Models } = await import("../../src/app/api/v1/models/route.js");
  const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
  const { handleChat } = await import("../../src/sse/handlers/chat.js");

  // 1. Seed DB settings and connections
  await updateSettings({
    requireApiKey: false,
    requireLogin: false,
    rtkEnabled: false,
    pxpipeAutoInstall: false,
  });

  const connA = await createProviderConnection({
    name: "Account A",
    provider: "antigravity",
    isActive: true,
    accessToken: "token-a",
    providerSpecificData: {
      enabledModels: ["gemini-2.5-pro"],
      cloudaicompanionProject: "smoke-project",
    },
    priority: 1,
    expiresAt: Date.now() + 86400000,
  });

  const connB = await createProviderConnection({
    name: "Account B",
    provider: "antigravity",
    isActive: true,
    accessToken: "token-b",
    providerSpecificData: {
      enabledModels: ["gemini-2.5-pro", "claude-sonnet-5-5"],
      cloudaicompanionProject: "smoke-project",
    },
    priority: 2,
    expiresAt: Date.now() + 86400000,
  });

  // ─── Scenario 1: Version-gated discovery ───
  const resConnB = await getProviderModels(
    new Request(`http://localhost:20127/api/providers/${connB.id}/models`),
    { params: Promise.resolve({ id: connB.id }) }
  );
  assert.equal(resConnB.status, 200);
  const dataConnB = await resConnB.json();
  assert.equal(dataConnB.resolved, true);
  assert.equal(dataConnB.clientVersion, "2.19.1");
  const sonnetInB = dataConnB.models.find((m) => m.id === "claude-sonnet-5-5");
  assert.ok(sonnetInB, "claude-sonnet-5-5 must be present in Account B models");
  assert.equal(sonnetInB.name, "Claude Sonnet 5.5");

  // Verify manifest requests never carried credentials
  assert.ok(recordedManifestHeaders.length > 0, "Manifest must be requested");
  for (const h of recordedManifestHeaders) {
    assert.equal(h.Authorization, undefined);
    assert.equal(h.authorization, undefined);
  }
  console.log("PASS version-gated discovery");

  // ─── Scenario 2: Future-model promotion without static registry entry ───
  smokeFuturePromoted = true;
  await updateProviderConnection(connB.id, {
    providerSpecificData: {
      ...connB.providerSpecificData,
      enabledModels: ["gemini-2.5-pro", "claude-sonnet-5-5", "claude-sonnet-99-1"],
    },
  });

  // Advance time past model cache TTL (5 minutes)
  const realNow = Date.now;
  const mockNow = realNow() + 6 * 60 * 1000;
  Date.now = () => mockNow;

  const resPublic = await getV1Models(new Request("http://localhost:20127/v1/models"));
  assert.equal(resPublic.status, 200);
  const dataPublic = await resPublic.json();
  const futureModel = dataPublic.data.find((m) => m.id === "ag/claude-sonnet-99-1");
  assert.ok(futureModel, "Future model ag/claude-sonnet-99-1 must be promoted in public catalog");
  assert.equal(futureModel.context_length, 500000);
  assert.equal(futureModel.max_completion_tokens, 64000);

  // Check /api/models has live model and removed static 4.6
  const resApiModels = await getModels();
  assert.equal(resApiModels.status, 200);
  const dataApiModels = await resApiModels.json();
  const agApiModels = dataApiModels.models.filter((m) => m.provider === "ag" || m.provider === "antigravity");
  assert.ok(agApiModels.some((m) => m.model === "claude-sonnet-99-1"));
  assert.ok(!agApiModels.some((m) => m.model === "claude-sonnet-4-6"), "Static 4.6 must be purged when live catalog is present");

  console.log("PASS future-model promotion");

  // Restore Date.now for deadlines/streaming
  Date.now = realNow;

  // ─── Scenario 5: Account-scoped routing ───
  // Account A (priority 1) only has gemini-2.5-pro enabled.
  // When routing claude-sonnet-5-5, Account A must be rejected and Account B selected.
  const creds = await getProviderCredentials("antigravity", null, "claude-sonnet-5-5");
  assert.ok(creds, "Must obtain credentials for claude-sonnet-5-5");
  assert.equal(creds.connectionId, connB.id, "Must select Account B for claude-sonnet-5-5");
  console.log("PASS account-scoped routing");

  // ─── Scenario 6: Stream & non-stream wire ID execution ───
  recordedGenerationBodies = [];

  // Non-stream call with dynamic future model
  const nonStreamReq = new Request("http://localhost:20127/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      model: "ag/claude-sonnet-99-1",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    }),
  });
  const nonStreamRes = await handleChat(nonStreamReq);
  assert.equal(nonStreamRes.status, 200);
  const nonStreamJson = await nonStreamRes.json();
  assert.equal(nonStreamJson.choices[0].message.content, "ok");
  assert.equal(recordedGenerationBodies.length, 1);
  assert.equal(recordedGenerationBodies[0].token, "token-b");
  assert.equal(recordedGenerationBodies[0].body.model, "claude-sonnet-99-1");

  // Stream call with dynamic future model
  recordedGenerationBodies = [];
  const streamReq = new Request("http://localhost:20127/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "ag/claude-sonnet-99-1",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const streamRes = await handleChat(streamReq);
  assert.equal(streamRes.status, 200);
  const streamReader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let streamOutput = "";
  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;
    streamOutput += decoder.decode(value, { stream: true });
  }
  streamOutput += decoder.decode();
  assert.ok(streamOutput.includes("data: [DONE]"), "Stream must emit terminal [DONE]");
  const doneMatches = streamOutput.match(/data: \[DONE\]/g);
  assert.equal(doneMatches.length, 1, "Terminal [DONE] must appear exactly once");
  assert.ok(streamOutput.includes('"content":"ok"') || streamOutput.includes('"content": "ok"'));

  // Test thinking variant: ag/claude-sonnet-99-1(high)
  recordedGenerationBodies = [];
  const thinkingReq = new Request("http://localhost:20127/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      model: "ag/claude-sonnet-99-1(high)",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const thinkingRes = await handleChat(thinkingReq);
  assert.equal(thinkingRes.status, 200);
  assert.equal(recordedGenerationBodies.length, 1);
  assert.equal(recordedGenerationBodies[0].body.model, "claude-sonnet-99-1", "Wire model must strip (high) suffix");

  console.log("PASS stream/non-stream wire ID");
}

if (process.argv[2] === "child") {
  await runChildSmoke();
  process.exit(0);
} else {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ag-discovery-smoke-"));
  try {
    const env = {
      ...process.env,
      DATA_DIR: tempRoot,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      APPDATA: tempRoot,
      NO_PROXY: "*",
      DISABLE_MITM_DNS_BYPASS: "true",
    };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      delete env[key];
    }
    const jsconfig = path.join(repoRoot, "jsconfig.json");
    const child = spawnSync(
      process.execPath,
      ["--no-env-file", "--no-install", "--tsconfig-override", jsconfig, scriptPath, "child"],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        timeout: 30000,
      }
    );
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(`Smoke child failed with exit code ${child.status}:\n${child.stdout}\n${child.stderr}`);
    }
    process.stdout.write(child.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
