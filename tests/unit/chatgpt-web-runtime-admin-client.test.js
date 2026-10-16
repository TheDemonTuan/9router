import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestChatGptWebRuntimeAdmin, requestChatGptWebRuntime, parseChatGptWebCatalog, getChatGptWebCatalog } from "../../open-sse/services/chatgptWebRuntimeClient.js";

const names = ["NEXT_PUBLIC_CHATGPT_WEB_ENABLED", "CHATGPT_WEB_RUNTIME_URL", "CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE", "CHATGPT_WEB_RUNTIME_TOKEN_FILE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
let original, directory, server, trap, seen, trapped, handler;
const adminToken = "fixture-admin-bearer-not-a-real-token";
const dataToken = "fixture-data-bearer-not-a-real-token";
const connection = { providerSpecificData: { profileId: "personal" } };
beforeEach(async () => {
  original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  delete process.env.NEXT_PUBLIC_CHATGPT_WEB_ENABLED;
  directory = await mkdtemp(join(tmpdir(), "cgw-direct-"));
  seen = []; trapped = 0;
  handler = () => Response.json({ ok: true });
  trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { trapped++; return new Response("proxy trap", { status: 502 }); } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push({ url: new URL(request.url), headers: request.headers, body: await request.text() });
    return handler(request);
  } });
  process.env.CHATGPT_WEB_RUNTIME_URL = server.url.href;
  process.env.CHATGPT_WEB_RUNTIME_ADMIN_TOKEN_FILE = join(directory, "admin");
  process.env.CHATGPT_WEB_RUNTIME_TOKEN_FILE = join(directory, "data");
  await Bun.write(join(directory, "admin"), adminToken);
  await Bun.write(join(directory, "data"), dataToken);
  for (const name of names.filter(name => /proxy/i.test(name))) process.env[name] = /no_proxy/i.test(name) ? "" : trap.url.href;
});
afterEach(async () => {
  server?.stop(true); trap?.stop(true);
  await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("managed harness internal transport", () => {
  it("denies runtime, admin and catalog access while suspended without reading credentials or using the network", async () => {
    process.env.NEXT_PUBLIC_CHATGPT_WEB_ENABLED = "false";
    await rm(join(directory, "admin"));
    await rm(join(directory, "data"));
    await expect(requestChatGptWebRuntimeAdmin("/admin/login/start", { method: "POST" })).rejects.toMatchObject({ code: "chatgpt_web_disabled" });
    await expect(requestChatGptWebRuntime(connection, "/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "chatgpt_web_disabled" });
    expect(() => getChatGptWebCatalog(connection)).toThrow(expect.objectContaining({ code: "chatgpt_web_disabled" }));
    expect(seen).toEqual([]);
    expect(trapped).toBe(0);
  });
  it.each(["configure", "start", "verify", "activate", "disconnect"])("authenticates admin %s directly and strips caller authority", async name => {
    const body = JSON.stringify({ profileId: "personal", revision: 3 });
    await requestChatGptWebRuntimeAdmin(`/admin/harness/${name}`, { method: "POST", body, proxy: trap.url.href, headers: { authorization: "Bearer spoofed", "x-cgw-profile-id": "other", "x-9router-cgw-attestation": "fake", "x-codex-turn-metadata": "fake", "content-type": "application/json" } });
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${adminToken}`);
    for (const key of ["x-cgw-profile-id", "x-9router-cgw-attestation", "x-codex-turn-metadata"]) expect(seen[0].headers.has(key)).toBe(false);
    expect(trapped).toBe(0);
  });
  it("separates data-plane credentials and retains validated profile", async () => {
    await requestChatGptWebRuntime(connection, "/v1/responses", { method: "POST", headers: { "x-cgw-profile-id": "other" } });
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${dataToken}`);
    expect(seen[0].headers.get("x-cgw-profile-id")).toBe("personal");
    expect(trapped).toBe(0);
  });
  it.each([
    ["/admin/harness/status?profileId=personal", "POST"],
    ["/admin/harness/status", "GET"],
    ["/admin/harness/status?profileId=personal&profileId=other", "GET"],
    ["/admin/harness/status?profileId=../escape", "GET"],
    ["/admin/harness/status?profileId=personal&probe=true", "GET"],
    ["/admin/harness/configure", "GET"],
    ["/admin/harness/start", "PATCH"],
    ["/admin/harness/verify?profileId=personal", "POST"],
    ["/admin/harness/activate#fragment", "POST"],
    ["/admin/harness/disconnect?key=secret", "POST"],
    ["/admin/harness/delete", "POST"],
    ["https://foreign.example.test/admin/harness/start", "POST"],
  ])("rejects unsupported %s %s without network access", async (path, method) => {
    await expect(requestChatGptWebRuntimeAdmin(path, { method })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it.each(["status", "configure", "start", "verify", "activate", "disconnect"])("denies data-plane harness/%s", async name => {
    await expect(requestChatGptWebRuntime(connection, `/admin/harness/${name}`, { method: "POST" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it("rejects redirects before leaking credentials", async () => {
    handler = () => Response.redirect(trap.url.href, 302);
    await expect(requestChatGptWebRuntimeAdmin("/admin/profiles")).rejects.toThrow();
    expect(trapped).toBe(0);
  });
  it("delivers SSE before completion", async () => {
    let finish;
    handler = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); finish = () => controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const response = await requestChatGptWebRuntime(connection, "/v1/responses");
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish();
    expect((await reader.read()).done).toBe(true);
  });
  it.each(["caller", "timeout"])("cancels an unfinished stream by %s", async mode => {
    handler = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([65])); } }));
    const controller = new AbortController();
    const response = await requestChatGptWebRuntime(connection, "/v1/responses", { signal: controller.signal }, mode === "timeout" ? { timeoutMs: 100 } : {});
    const reader = response.body.getReader(); await reader.read();
    const pending = reader.read();
    if (mode === "caller") controller.abort();
    await expect(pending).rejects.toThrow();
  });
  it("retains generic capability booleans from the verified catalog without unknown capabilities", () => {
    const catalog = { protocolVersion: 1, profile_id: "personal", profile_epoch: "fixture-epoch", catalog_revision: "fixture-revision", checked_at: "2026-10-08T00:00:00.000Z", max_concurrency: 5, models: [{ id: "chatgpt-web/gpt-5.6-sol", supported_reasoning_levels: ["medium", "high"], default_reasoning_level: "high", model_family: "5.6", legacy: false, context_window: 100000, auto_compact_token_limit: 80000, capabilities: { text: true, generic_responses: true, generic_tools: false, unknownAuthority: true, toolToken: "fixture-secret" } }] };
    expect(parseChatGptWebCatalog(catalog).models[0].capabilities).toEqual({ text: true, generic_responses: true, generic_tools: false });
    catalog.models[0].capabilities.generic_tools = "true";
    expect(parseChatGptWebCatalog(catalog).models[0].capabilities).toEqual({ text: true, generic_responses: true });
  });
});
