import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn(), init: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("../../open-sse/translator/index.js", () => ({ initTranslators: mocks.init }));

const { POST: geminiPost } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { POST: ollamaPost } = await import("../../src/app/api/v1/api/chat/route.js");
const encode = (text) => new TextEncoder().encode(text);
const decode = (value) => new TextDecoder().decode(value);
const geminiRequest = (action, signal) => new Request(`http://localhost/v1beta/models/test:${action}`, {
  method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }), signal,
});
const ollamaRequest = (signal) => new Request("http://localhost/v1/api/chat", {
  method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], stream: true }), signal,
});

// Real deadline; never mock the budget whose behavior these routes must preserve.
describe("final route adapters", () => {
  it.each([
    ["Gemini JSON", () => geminiPost(geminiRequest("generateContent"), { params: { path: ["test:generateContent"] } })],
    ["Gemini SSE", () => geminiPost(geminiRequest("streamGenerateContent"), { params: { path: ["test:streamGenerateContent"] } })],
    ["Ollama", () => ollamaPost(ollamaRequest())],
  ])("returns a controlled deadline for stalled %s", async (_, run) => {
    vi.useFakeTimers();
    mocks.init.mockImplementation(() => new Promise(() => {}));
    const pending = run();
    const outcome = pending.then((response) => response);
    await vi.advanceTimersByTimeAsync(100_001);
    const response = await outcome;
    expect(response.status).toBe(504);
    expect(response.headers.get("x-9router-no-fallback")).toBe("true");
    expect(response.headers.get("x-should-retry")).toBe("true");
    expect((await response.json()).error.type).toBe("gateway_timeout");
    mocks.init.mockReset();
    vi.useRealTimers();
  });

  it("returns 499 for pre-response client cancellation", async () => {
    const abort = new AbortController();
    mocks.init.mockImplementation(() => new Promise(() => {}));
    const pending = geminiPost(geminiRequest("generateContent", abort.signal), { params: { path: ["test:generateContent"] } });
    abort.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    mocks.init.mockReset();
  });

  it("emits Gemini final-wire keepalive before real candidate and cancels upstream", async () => {
    vi.useFakeTimers();
    mocks.init.mockResolvedValue();
    let source;
    const cancel = vi.fn();
    mocks.handleChat.mockImplementation(() => new Response(new ReadableStream({ start(controller) { source = controller; }, cancel }), {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await geminiPost(geminiRequest("streamGenerateContent"), { params: { path: ["test:streamGenerateContent"] } });
    source.enqueue(encode(": upstream keepalive\n\n"));
    const reader = response.body.getReader();
    const firstRead = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const first = await firstRead;
    expect(decode(first.value)).toBe(": keepalive\n\n");
    source.enqueue(encode('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
    let content = "";
    while (!content.includes("hello")) content += decode((await reader.read()).value);
    expect(JSON.parse(content.match(/data: ([^\n]+)/)[1]).candidates[0].content.parts[0].text).toBe("hello");
    expect(content).not.toContain("[DONE]");
    await reader.cancel("done");
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("emits Ollama whitespace without an empty JSON line and preserves HTTP errors", async () => {
    vi.useFakeTimers();
    mocks.init.mockResolvedValue();
    let source;
    const cancel = vi.fn();
    mocks.handleChat.mockImplementation(() => new Response(new ReadableStream({ start(controller) { source = controller; }, cancel }), {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await ollamaPost(ollamaRequest());
    source.enqueue(encode(": upstream keepalive\n\n"));
    const reader = response.body.getReader();
    const firstRead = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const first = await firstRead;
    expect(decode(first.value)).toBe(" ");
    source.enqueue(encode('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
    const record = decode((await reader.read()).value);
    expect(JSON.parse(`${decode(first.value)}${record}`).message.content).toBe("hello");
    await reader.cancel("done");
    expect(cancel).toHaveBeenCalledTimes(1);
    mocks.handleChat.mockResolvedValueOnce(new Response('{"error":"limited"}', { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } }));
    const rejected = await ollamaPost(ollamaRequest());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("x-should-retry")).toBe("false");
    expect(await rejected.json()).toEqual({ error: "limited" });
    vi.useRealTimers();
  });

  it("propagates a post-handoff Ollama request abort to the upstream body", async () => {
    mocks.init.mockResolvedValue();
    const client = new AbortController();
    const cancel = vi.fn();
    mocks.handleChat.mockImplementation(() => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await ollamaPost(ollamaRequest(client.signal));
    const pending = response.body.getReader().read();
    client.abort(new Error("closed"));
    await pending;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});
