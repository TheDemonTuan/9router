import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import registry from "../../open-sse/providers/registry/index.js";
import { ChatGPTWebExecutor } from "../../open-sse/executors/chatgpt-web.js";
import {
  getChatGptWebCatalog,
  getChatGptWebHealth,
  invalidateChatGptWebCatalog,
  parseChatGptWebCatalog,
  resolveChatGptWebSocket,
  validateChatGptWebBridgeId,
} from "../../open-sse/services/chatgptWebBridge.js";
import { getResponsesDialect, isNativePassthrough } from "../../open-sse/utils/clientDetector.js";
import { normalizeProviderId, normalizeProviderSpecificData, sanitizeProviderSpecificData } from "../../src/lib/providerNormalization.js";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";

const cleanup = [];
afterEach(async () => {
  invalidateChatGptWebCatalog();
  delete process.env.CHATGPT_WEB_BRIDGE_SOCKET_ROOT;
  while (cleanup.length) await cleanup.pop()();
});

describe("ChatGPT Web provider contract", () => {
  it("normalizes the cgw alias to the canonical provider ID", () => {
    expect(normalizeProviderId("cgw")).toBe("chatgpt-web");
    expect(normalizeProviderId("ChatGPT Web")).toBe("chatgpt-web");
  });

  it("registers cgw separately from Codex and preserves native dialect", () => {
    const provider = registry.find((entry) => entry.id === "chatgpt-web");
    expect(provider).toMatchObject({ alias: "cgw", category: "localBridge", authType: "bridge", models: [] });
    expect(registry.find((entry) => entry.id === "codex")?.alias).toBe("cx");
    expect(isNativePassthrough("codex", "chatgpt-web")).toBe(true);
    expect(getResponsesDialect("grok-build", "chatgpt-web")).toBe("codex-native");
  });

  it("redacts native prompt, checkpoint, and echoed error content from persisted details", () => {
    const detail = buildRequestDetail({
      provider: "chatgpt-web",
      model: "chatgpt-web/high",
      request: { input: "secret prompt", reasoning: { encrypted_content: "secret checkpoint" } },
      providerRequest: { input: "secret prompt" },
      providerResponse: { output: "secret answer" },
      response: { status: 400, error: "secret echoed prompt" },
    });

    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(detail.request).toMatchObject({ redacted: true });
    expect(detail.providerRequest).toEqual({ redacted: true });
    expect(detail.response).toMatchObject({ status: 400, error: "redacted", redacted: true });
  });

  it("keeps malformed bridge IDs as data for the boundary validator instead of throwing", () => {
    expect(() => normalizeProviderSpecificData("chatgpt-web", {}, { bridgeId: { toString: "blocked" } })).not.toThrow();
    expect(normalizeProviderSpecificData("chatgpt-web", {}, { bridgeId: 7 })).toEqual({ bridgeId: 7 });
  });

  it("removes nested credentials from provider data returned to clients", () => {
    expect(sanitizeProviderSpecificData({
      bridgeId: "personal",
      nested: { accessToken: "secret", display: "ok" },
      rows: [{ refreshToken: "secret", id: "safe" }],
    })).toEqual({ bridgeId: "personal", nested: { display: "ok" }, rows: [{ id: "safe" }] });
  });

  it("accepts only bounded bridge slugs and web model rows", () => {
    expect(validateChatGptWebBridgeId("personal-1")).toBe("personal-1");
    for (const invalid of ["../x", "A", "a/b", "-x", "x-", ""]) {
      expect(() => validateChatGptWebBridgeId(invalid)).toThrow();
    }
    expect(parseChatGptWebCatalog({ models: [
      { id: "chatgpt-web/high", capabilities: { reasoning: true } },
      { id: "chatgpt-web/high" },
      { id: "chatgpt-web/" },
      { id: "chatgpt-web/a/b" },
      { id: "gpt-5.6-sol" },
      { id: 4 },
    ] }).models).toEqual([
      { id: "chatgpt-web/high", name: "chatgpt-web/high", capabilities: { reasoning: true } },
    ]);
    expect(parseChatGptWebCatalog({ models: [] }).models).toEqual([]);
    expect(() => parseChatGptWebCatalog({ data: "bad" })).toThrow();
  });

  it("keeps only typed live capability evidence at the bridge boundary", () => {
    const parsed = parseChatGptWebCatalog({ models: [{
      id: "chatgpt-web/high",
      name: "High",
      capabilities: { reasoning: true, tools: false, injected: true },
      context_window: 90000,
      auto_compact_token_limit: 80000,
      injected: "secret",
    }] });

    expect(parsed.models[0]).toEqual({
      id: "chatgpt-web/high",
      name: "High",
      capabilities: { reasoning: true, tools: false },
      context_window: 90000,
      auto_compact_token_limit: 80000,
    });
  });

  it("deduplicates concurrent catalog reads without inventing an offline catalog", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ models: [{ id: "chatgpt-web/high" }], catalog_revision: 7 });
    };
    const connection = { id: "c1", providerSpecificData: { bridgeId: "personal" } };
    const [a, b] = await Promise.all([
      getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl, force: true }),
      getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl, force: true }),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a.models[0].id).toBe("chatgpt-web/high");
  });

  it("composes caller abort with finite health and catalog deadlines", async () => {
    const connection = { id: "c-deadline", providerSpecificData: { bridgeId: "personal" } };
    const caller = new AbortController();
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(init.signal);
      return url.endsWith("/healthz")
        ? Response.json({ service: "codex-chatgpt-web", status: "ok" })
        : Response.json({ models: [{ id: "chatgpt-web/high" }] });
    };

    await getChatGptWebHealth(connection, { socketPath: "fixture", fetchImpl, signal: caller.signal });
    await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl, force: true, signal: caller.signal });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(caller.signal);
    expect(seen[1]).not.toBe(caller.signal);
    caller.abort();
    expect(seen[0].aborted).toBe(true);
    expect(seen[1].aborted).toBe(true);
  });

  it("clears an aborted catalog probe so the next request can retry", async () => {
    const connection = { id: "c-abort", providerSpecificData: { bridgeId: "personal" } };
    const caller = new AbortController();
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return Response.json({ models: [{ id: "chatgpt-web/high" }], catalog_revision: calls });
    };

    const aborted = getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl, signal: caller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const retried = await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl });
    expect(calls).toBe(2);
    expect(retried.revision).toBe("2");
  });

  it("refreshes the catalog after its 30-second verification TTL", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const connection = { id: "c-ttl", providerSpecificData: { bridgeId: "personal" } };
      const fetchImpl = async () => {
        calls += 1;
        return Response.json({ models: [{ id: "chatgpt-web/high" }], catalog_revision: calls });
      };

      const first = await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl });
      await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl });
      expect(calls).toBe(1);
      expect(first.revision).toBe("1");

      vi.advanceTimersByTime(30_001);
      const refreshed = await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl });
      expect(calls).toBe(2);
      expect(refreshed.revision).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the last verified catalog as stale after a refresh failure", async () => {
    const connection = { id: "c-stale", providerSpecificData: { bridgeId: "personal" } };
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ models: [{ id: "chatgpt-web/high" }] });
      throw new Error("bridge offline");
    };
    const fresh = await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl });
    const stale = await getChatGptWebCatalog(connection, { socketPath: "fixture", fetchImpl, force: true });
    expect(fresh.stale).toBe(false);
    expect(stale).toMatchObject({ stale: true, models: [{ id: "chatgpt-web/high" }] });
    expect(calls).toBe(2);
  });
});

describe.skipIf(process.platform === "win32")("ChatGPT Web Unix socket dispatch", () => {
  it("rejects a symlinked socket root", async () => {
    const realRoot = await mkdtemp(join(tmpdir(), "9router-cgw-real-"));
    const parent = await mkdtemp(join(tmpdir(), "9router-cgw-link-"));
    const linkedRoot = join(parent, "root");
    await symlink(realRoot, linkedRoot, "dir");
    cleanup.push(
      () => rm(parent, { recursive: true, force: true }),
      () => rm(realRoot, { recursive: true, force: true }),
    );
    process.env.CHATGPT_WEB_BRIDGE_SOCKET_ROOT = linkedRoot;
    await expect(resolveChatGptWebSocket("personal")).rejects.toThrow("real directory");
  });

  it("drives the shipped executor, preserves native payload/header, and dispatches once", async () => {
    const root = await mkdtemp(join(tmpdir(), "9router-cgw-"));
    const socketPath = join(root, "personal.sock");
    process.env.CHATGPT_WEB_BRIDGE_SOCKET_ROOT = root;
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/v1/web-models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          models: [{ id: "chatgpt-web/high", capabilities: { native_responses: true } }],
          catalog_revision: "r1",
        }));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      response.end("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\"}}\n\ndata: [DONE]\n\n");
    });
    await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
    cleanup.push(async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });

    const executor = new ChatGPTWebExecutor();
    const body = {
      model: "chatgpt-web/high",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      client_metadata: { thread_id: "thread_fixture", unknown_extension: { keep: true } },
      reasoning: { effort: "high", encrypted_content: "opaque" },
      tools: [{ type: "custom", name: "shell", format: { type: "text" } }],
      metadata: { private: "kept-in-flight" },
    };
    const result = await executor.execute({
      model: "chatgpt-web/high",
      body,
      stream: true,
      credentials: {
        id: "c1",
        providerSpecificData: { bridgeId: "personal" },
        rawHeaders: {
          authorization: "Bearer gateway-secret",
          "x-codex-turn-metadata": "turn-fixture",
          cookie: "browser-secret",
        },
      },
      signal: new AbortController().signal,
      clientTool: "codex",
    });
    expect(result.response.ok).toBe(true);
    expect(await result.response.text()).toContain("resp_fixture");
    expect(requests.map((request) => request.url)).toEqual(["/v1/web-models", "/v1/responses"]);
    const posted = requests[1];
    expect(JSON.parse(posted.body)).toEqual(body);
    expect(posted.headers["x-codex-turn-metadata"]).toBe("turn-fixture");
    expect(posted.headers.authorization).toBeUndefined();
    expect(posted.headers.cookie).toBeUndefined();
  });
});
