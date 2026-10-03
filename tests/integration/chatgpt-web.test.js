import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getChatGptWebCatalog, getChatGptWebHealth, invalidateChatGptWebCatalog, parseChatGptWebCatalog, validateChatGptWebProfileId } from "../../open-sse/services/chatgptWebRuntimeClient.js";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";
const cleanups = [];
const previous = {};
afterEach(async () => { invalidateChatGptWebCatalog(); while (cleanups.length) await cleanups.pop()(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; delete previous[key]; } });
const row = { id: "chatgpt-web/gpt-5.6-sol", display_name: "Synthetic Sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", legacy: false, context_window: 90000, auto_compact_token_limit: 80000, capabilities: { text: true, native_responses: true, generic_responses: false, tools: false } };
const catalog = (profileId = "fixture") => ({ protocolVersion: 1, profile_id: profileId, profile_epoch: "epoch", catalog_revision: "revision", checked_at: new Date().toISOString(), max_concurrency: 5, models: [row] });
async function fixture(handler) {
  const root = await mkdtemp(join(tmpdir(), "cgw-http-test-")), secret = join(root, "data.key"); await writeFile(secret, "synthetic-secret".repeat(4)); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const [key, value] of Object.entries({ CHATGPT_WEB_RUNTIME_URL: `http://127.0.0.1:${server.address().port}`, CHATGPT_WEB_RUNTIME_TOKEN_FILE: secret })) { previous[key] = process.env[key]; process.env[key] = value; }
  return { id: "connection", providerSpecificData: { profileId: "fixture" } };
}
describe("authenticated profile transport", () => {
  it("preserves dotted route reasoning metadata and rejects unsafe profile paths", () => {
    expect(parseChatGptWebCatalog(catalog()).models[0]).toMatchObject({ id: row.id, supported_reasoning_levels: ["medium", "high"], model_family: "5.6" });
    for (const unsafe of ["../fixture", "A", "a/b", "-a", "a-", "", "a?x"]) expect(() => validateChatGptWebProfileId(unsafe)).toThrow();
  });
  it("rejects returned profile mismatch and keeps liveness separate from account readiness", async () => {
    const connection = await fixture((request, response) => {
      if (request.headers.authorization !== `Bearer ${"synthetic-secret".repeat(4)}`) { response.writeHead(401); response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/healthz" ? { service: "9router-cgw-runtime", protocolVersion: 1, draining: true } : catalog("other-profile")));
    });
    expect(await getChatGptWebHealth(connection)).toMatchObject({ draining: true });
    await expect(getChatGptWebCatalog(connection)).rejects.toThrow("profile mismatch");
  });
  it("does not reuse stale catalog for dispatch after a failed refresh", async () => {
    let failed = false;
    const connection = await fixture((_request, response) => { response.writeHead(failed ? 503 : 200, { "content-type": "application/json" }); response.end(JSON.stringify(failed ? { error: { code: "login_required" } } : catalog())); });
    expect((await getChatGptWebCatalog(connection)).stale).toBe(false); failed = true;
    await expect(getChatGptWebCatalog(connection, { force: true })).rejects.toThrow("unavailable");
  });
  it("never persists native request/answer/checkpoint or echoed error contents in request detail", () => {
    const detail = buildRequestDetail({ provider: "chatgpt-web", model: row.id, request: { input: "secret synthetic prompt" }, providerRequest: { input: "secret synthetic" }, providerResponse: { output: "secret synthetic" }, response: { status: 400, error: "secret synthetic echoed" } });
    expect(JSON.stringify(detail)).not.toContain("secret synthetic"); expect(detail.response).toMatchObject({ error: "redacted" });
  });
});
it("dotted catalog IDs survive, while malformed metadata never grants model capabilities", () => {
  const row = { id: "chatgpt-web/gpt-5.6-sol", display_name: "Synthetic Sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", legacy: false, context_window: 90000, auto_compact_token_limit: 80000, capabilities: { text: true, native_responses: true, generic_responses: false, tools: false } };
  const catalog = { protocolVersion: 1, profile_id: "synthetic", profile_epoch: "epoch", catalog_revision: "revision", checked_at: new Date().toISOString(), max_concurrency: 5, models: [row] };
  expect(parseChatGptWebCatalog(catalog).models[0]?.id).toBe(row.id);
  for (const invalid of [{ ...row, id: "chatgpt-web/gpt..5" }, { ...row, model_family: "future" }, { ...row, supported_reasoning_levels: ["high", "high"] }, { ...row, default_reasoning_level: "xhigh" }, { ...row, legacy: "false" }, { ...row, capabilities: { tools: "true" } }]) {
    expect(() => parseChatGptWebCatalog({ ...catalog, models: [invalid] })).toThrow("no verified model rows");
  }
});
