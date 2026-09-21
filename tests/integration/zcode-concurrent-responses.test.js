import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function makeSseResponse(chunkText) {
  const stream = new ReadableStream({
    start(controller) {
      const payload = `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: chunkText })}\n\n`;
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeJsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe("CodexExecutor — concurrent request isolation (Issue #3164)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps compact routing across a connect-timeout retry", async () => {
    const executor = new CodexExecutor();
    executor.config.timeoutMs = 10;
    executor.config.retry = { 504: { attempts: 1, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } };
    const urls = [];

    fetchMock.mockImplementation((url, options) => {
      urls.push(url);
      if (urls.length === 1) {
        return new Promise((resolve, reject) => {
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (options.signal.aborted) fail();
          else options.signal.addEventListener("abort", fail, { once: true });
        });
      }
      return Promise.resolve(makeSseResponse("compact retry succeeded"));
    });

    const result = await executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        input: [{ type: "message", role: "user", content: "compact request" }],
        session_id: "compact-session",
        _compact: true,
      },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "compact-connection" },
    });

    expect(result.response.status).toBe(200);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.endsWith("/responses/compact"))).toBe(true);
  });

  it("prevents state collision between concurrent non-stream title and stream main requests", async () => {
    // Shared singleton executor instance
    const executor = new CodexExecutor();
    const recordedCalls = [];

    fetchMock.mockImplementation(async (url, options) => {
      const reqBody = JSON.parse(options.body);
      const sid = options.headers["session_id"];
      recordedCalls.push({ url, headers: { ...options.headers }, body: reqBody });

      // Artificial small delay to guarantee in-flight concurrency overlap
      await new Promise((r) => setTimeout(r, 20));

      if (options.headers["session_id"] === "sess-A") {
        return makeJsonResponse({ id: "resp-title-A", title: "Refactor auth" });
      }
      return makeSseResponse("stream chunk from sess-B");
    });

    const reqA = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        input: [{ type: "message", role: "user", content: "generate title" }],
        session_id: "sess-A",
        _compact: true,
      },
      stream: false,
      credentials: { accessToken: "tok-A", connectionId: "conn-A" },
    });

    const reqB = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        input: [{ type: "message", role: "user", content: "main turn execution" }],
        session_id: "sess-B",
        _compact: false,
      },
      stream: true,
      credentials: { accessToken: "tok-B", connectionId: "conn-B" },
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);

    // Request A assertion: compact URL, session_id = sess-A, JSON body preserved
    const callA = recordedCalls.find((c) => c.headers.session_id === "sess-A");
    expect(callA).toBeDefined();
    expect(callA.url).toContain("/compact");
    expect(callA.headers.session_id).toBe("sess-A");

    // Request B assertion: standard URL, session_id = sess-B, stream preserved
    const callB = recordedCalls.find((c) => c.headers.session_id === "sess-B");
    expect(callB).toBeDefined();
    expect(callB.url).not.toContain("/compact");
    expect(callB.headers.session_id).toBe("sess-B");

    // Responses check: no swapping, no race conditions
    expect(resA.response.status).toBe(200);
    const jsonA = await resA.response.json();
    expect(jsonA.title).toBe("Refactor auth");

    expect(resB.response.status).toBe(200);
    const streamB = await readStream(resB.response.body);
    expect(streamB).toContain("stream chunk from sess-B");
  });
});

describe("ZCode CLI multi-request simulation (6 concurrent requests across 2 sessions)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("handles 6 concurrent requests without cross-contamination or false 499", async () => {
    const executor = new CodexExecutor();
    const upstreamCalls = [];

    fetchMock.mockImplementation(async (url, options) => {
      const headers = { ...options.headers };
      const body = JSON.parse(options.body);
      upstreamCalls.push({ url, headers, body });

      // Stagger responses slightly to test random resolution order
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));

      const firstItem = body.input?.[0];
      const text =
        typeof firstItem?.content === "string"
          ? firstItem.content
          : (firstItem?.content?.[0]?.text || "");
      const isStream = text.includes("main_turn");
      const sid = headers["session_id"];

      if (isStream) {
        return makeSseResponse(`chunk for ${sid} - ${text}`);
      }
      return makeJsonResponse({ result: `result for ${sid} - ${text}`, sessionId: sid });
    });

    // Session 1: CLI_A
    const sessionA_title = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "session_title",
        session_id: "zcode-cli-a",
        input: [{ type: "message", role: "user", content: "cli-a:session_title" }],
        stream: false,
      },
      stream: false,
      credentials: {
        accessToken: "tok-A",
        connectionId: "conn-cli-a",
        providerSpecificData: { accountId: "acc-A" },
      },
    });

    const sessionA_main = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "main_turn",
        session_id: "zcode-cli-a",
        input: [{ type: "message", role: "user", content: "cli-a:main_turn" }],
        stream: true,
      },
      stream: true,
      credentials: {
        accessToken: "tok-A",
        connectionId: "conn-cli-a",
        providerSpecificData: { accountId: "acc-A" },
      },
    });

    const sessionA_memory = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "project_memory",
        session_id: "zcode-cli-a",
        input: [{ type: "message", role: "user", content: "cli-a:project_memory" }],
        stream: false,
      },
      stream: false,
      credentials: {
        accessToken: "tok-A",
        connectionId: "conn-cli-a",
        providerSpecificData: { accountId: "acc-A" },
      },
    });

    // Session 2: CLI_B
    const sessionB_title = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "session_title",
        session_id: "zcode-cli-b",
        input: [{ type: "message", role: "user", content: "cli-b:session_title" }],
        stream: false,
      },
      stream: false,
      credentials: {
        accessToken: "tok-B",
        connectionId: "conn-cli-b",
        providerSpecificData: { accountId: "acc-B" },
      },
    });

    const sessionB_main = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "main_turn",
        session_id: "zcode-cli-b",
        input: [{ type: "message", role: "user", content: "cli-b:main_turn" }],
        stream: true,
      },
      stream: true,
      credentials: {
        accessToken: "tok-B",
        connectionId: "conn-cli-b",
        providerSpecificData: { accountId: "acc-B" },
      },
    });

    const sessionB_memory = executor.execute({
      model: "gpt-5.6-luna",
      body: {
        model: "gpt-5.6-luna",
        purpose: "project_memory",
        session_id: "zcode-cli-b",
        input: [{ type: "message", role: "user", content: "cli-b:project_memory" }],
        stream: false,
      },
      stream: false,
      credentials: {
        accessToken: "tok-B",
        connectionId: "conn-cli-b",
        providerSpecificData: { accountId: "acc-B" },
      },
    });

    // Fire all 6 concurrently
    const [resA_title, resA_main, resA_memory, resB_title, resB_main, resB_memory] =
      await Promise.all([
        sessionA_title,
        sessionA_main,
        sessionA_memory,
        sessionB_title,
        sessionB_main,
        sessionB_memory,
      ]);

    // All 6 succeeded with 200
    expect(resA_title.response.status).toBe(200);
    expect(resA_main.response.status).toBe(200);
    expect(resA_memory.response.status).toBe(200);
    expect(resB_title.response.status).toBe(200);
    expect(resB_main.response.status).toBe(200);
    expect(resB_memory.response.status).toBe(200);

    // Verify upstream received exactly 6 requests with correct account and session IDs
    expect(upstreamCalls.length).toBe(6);

    const callsA = upstreamCalls.filter((c) => c.headers.session_id === "zcode-cli-a");
    const callsB = upstreamCalls.filter((c) => c.headers.session_id === "zcode-cli-b");
    expect(callsA.length).toBe(3);
    expect(callsB.length).toBe(3);

    for (const c of callsA) {
      expect(c.headers["ChatGPT-Account-ID"]).toBe("acc-A");
    }
    for (const c of callsB) {
      expect(c.headers["ChatGPT-Account-ID"]).toBe("acc-B");
    }

    // Verify non-stream JSON responses match corresponding session
    const jsonA_title = await resA_title.response.json();
    expect(jsonA_title.sessionId).toBe("zcode-cli-a");
    expect(jsonA_title.result).toContain("cli-a:session_title");

    const jsonA_memory = await resA_memory.response.json();
    expect(jsonA_memory.sessionId).toBe("zcode-cli-a");
    expect(jsonA_memory.result).toContain("cli-a:project_memory");

    const jsonB_title = await resB_title.response.json();
    expect(jsonB_title.sessionId).toBe("zcode-cli-b");
    expect(jsonB_title.result).toContain("cli-b:session_title");

    const jsonB_memory = await resB_memory.response.json();
    expect(jsonB_memory.sessionId).toBe("zcode-cli-b");
    expect(jsonB_memory.result).toContain("cli-b:project_memory");

    // Verify stream SSE responses match corresponding session
    const streamA_main = await readStream(resA_main.response.body);
    expect(streamA_main).toContain("chunk for zcode-cli-a - cli-a:main_turn");

    const streamB_main = await readStream(resB_main.response.body);
    expect(streamB_main).toContain("chunk for zcode-cli-b - cli-b:main_turn");
  });
});
