import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/server";
import { sha256 } from "../src/authority";

const browser = process.env.CGW_CHROMIUM_EXECUTABLE;
if (!browser) throw new Error("CGW_CHROMIUM_EXECUTABLE is required for actual offline Chromium smoke");
const root = mkdtempSync(join(tmpdir(), "9router-cgw-offline-"));
const previous = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "DATA_DIR", "CGW_DATA_DIR"].map(key => [key, process.env[key]]));
for (const key of Object.keys(previous)) process.env[key] = root;
const runtime = startRuntime({ dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: browser,
  runtimeToken: Buffer.from("synthetic-data-token".repeat(4)), adminToken: Buffer.from("synthetic-admin-token".repeat(4)) });
const base = `http://127.0.0.1:${runtime.server.port}`;
const data = `Bearer ${"synthetic-data-token".repeat(4)}`, admin = `Bearer ${"synthetic-admin-token".repeat(4)}`;
const fixture = readFileSync(new URL("../tests/fixtures/chatgpt-runtime.html", import.meta.url), "utf8");
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const post = (path: string, body: unknown, authorization = data) => fetch(`${base}${path}`, {
  method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error",
});
try {
  runtime.state.createProfile("offline-fixture");
  const context = await (await runtime.profiles.ensureProfileBrowser("offline-fixture")).ensureContext();
  let physicalSends = 0, sessionExpired = false;
  await context.exposeBinding("syntheticObserveSend", () => { physicalSends++; });
  await context.addInitScript(() => {
    document.addEventListener("submit", () => {
      const observer = Reflect.get(window, "syntheticObserveSend");
      if (typeof observer === "function") void observer();
    });
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://chatgpt.com") return route.abort();
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: { expires: new Date(Date.now() + (sessionExpired ? -1000 : 600000)).toISOString(), user: { id: "synthetic-account" } } });
    return route.fulfill({ body: fixture, contentType: "text/html" });
  });
  const probe = await post("/admin/smoke", { profileId: "offline-fixture", kind: "browser" }, admin);
  assert(probe.ok, `Actual DOM profile probe failed (${probe.status})`);
  const catalogResponse = await fetch(`${base}/v1/web-models`, { headers: { authorization: data, "x-cgw-profile-id": "offline-fixture" } });
  const catalog = await catalogResponse.json();
  assert(catalogResponse.ok && catalog.models.some((row: { id: string }) => row.id === "chatgpt-web/gpt-5.6-sol"), "Dotted model route missing after actual browser probe");
  const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671", turnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
  const bindingResponse = await post("/v1/thread-bindings/resolve", { clientId: "offline-client", threadId, candidateProfileIds: ["offline-fixture"] });
  const binding = await bindingResponse.json(); assert(bindingResponse.ok, "Durable thread binding failed");
  const request = { model: "chatgpt-web/gpt-5.6-sol", stream: true, reasoning: { effort: "high" }, client_metadata: {
    "x-codex-turn-metadata": { request_kind: "turn", thread_id: threadId, turn_id: turnId, agent_name: "/root", sandbox_mode: "read-only", workspaces: { "/synthetic": {} } },
  }, input: [{ type: "message", id: "synthetic-prompt", role: "user", content: [{ type: "input_text", text: "Synthetic offline browser transport question" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }] };
  const now = Math.floor(Date.now() / 1000);
  const authority = { v: 1, aud: "9router-cgw", purpose: "responses", clientId: "offline-client", jti: "offline-one-use", iat: now, exp: now + 60,
    method: "POST", path: "/v1/responses", bodySha256: sha256(JSON.stringify(request)), threadId, turnId, agentName: "/root", pathFlavor: "posix",
    environment: { cwd: "/synthetic", roots: ["/synthetic"], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false } } };
  const envelope = { protocolVersion: 1, profileId: "offline-fixture", profileEpoch: binding.profileEpoch, request, authority,
    originalModel: `cgw/${request.model}`, effectiveModel: request.model, effectiveReasoning: "high", transformedRequestSha256: sha256(JSON.stringify(request)) };
  const responses = await Promise.all([post("/v1/responses", envelope), post("/v1/responses", envelope)]);
  const accepted = responses.find(response => response.status === 200), replay = responses.find(response => response.status === 409);
  assert(accepted && replay, "Parallel JTI replay was not rejected before second admission");
  const sse = await accepted.text();
  assert(sse.includes("response.completed") && !sse.includes("response.failed"), "Browser fixture did not produce exactly completed terminal semantics");
  assert(sse.includes("Offline answer first paragraph.") && sse.includes("Offline answer second paragraph."), "Real DOM answer did not reach Responses stream");
  const observations = await Promise.all(context.pages().map(page => page.evaluate(() => {
    const state = Reflect.get(window, "fixture");
    return state ? { sends: state.sends, efforts: state.selectedEfforts, prompts: state.prompts } : { sends: 0, efforts: [], prompts: [] };
  })));
  assert(observations.reduce((sum, state) => sum + state.sends, 0) === 1, "Replay or composer draft caused a duplicate physical Send");
  const submitted = observations.flatMap(state => state.prompts);
  assert(submitted.length === 1 && !submitted[0].includes("Stale draft must be cleared"), "Persistent composer state leaked into submission");
  assert(observations.flatMap(state => state.efforts).every(effort => effort === 2), "Actual selected effort differed from High");
  assert(physicalSends === 1, "Replay generated more than one physical DOM submit");
  const unsupportedRequest = { ...request, reasoning: { effort: "xhigh" } };
  const unsupported = await post("/v1/responses", { ...envelope, request: unsupportedRequest, effectiveReasoning: "xhigh",
    transformedRequestSha256: sha256(JSON.stringify(unsupportedRequest)), authority: { ...authority, jti: "unsupported-effort" } });
  assert(unsupported.status === 400 && physicalSends === 1, "Unsupported effort reached Send");
  sessionExpired = true;
  const nextTurn = "01a06c66-4380-75c6-a0df-318f890ef6df";
  const expiredRequest = { ...request,
    client_metadata: { "x-codex-turn-metadata": { ...request.client_metadata["x-codex-turn-metadata"], turn_id: nextTurn } },
    input: [...request.input,
      { type: "message", id: "completed-fixture-answer", role: "assistant", content: [{ type: "output_text", text: "Offline answer first paragraph.\n\nOffline answer second paragraph." }], internal_chat_message_metadata_passthrough: { turn_id: turnId } },
      ...request.input.map(item => ({ ...item, id: "expired-prompt", internal_chat_message_metadata_passthrough: { turn_id: nextTurn } }))],
  };
  const expired = await post("/v1/responses", { ...envelope, request: expiredRequest, transformedRequestSha256: sha256(JSON.stringify(expiredRequest)),
    authority: { ...authority, jti: "expired-session-turn", turnId: nextTurn } });
  const expiredWire = await expired.text();
  assert(expiredWire.includes("response.failed") && expiredWire.includes("login_required") && physicalSends === 1,
    `Expired-session gate failed (physicalSends=${physicalSends}, status=${expired.status}): ${expiredWire}`);
  assert(!runtime.profiles.ready("offline-fixture"), "Expired session retained account readiness");
  console.info(JSON.stringify({ gate: "runtime-offline-browser", protocolVersion: 1, platform: process.platform,
    chromiumVersion: context.browser()?.version(), authenticatedHttp: true, modelEffortReadback: true, composerCleared: true,
    parallelReplayRejected: true, unsupportedEffortNotSent: true, expiredSessionNotSent: true, physicalSends,
    terminal: "completed", liveChatGpt: false, outerCodexToolE2e: false }));
} finally {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
