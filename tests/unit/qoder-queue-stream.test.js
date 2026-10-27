import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async () => ({ key: "smodel", source: "system", max_output_tokens: 65536 })),
  resolveQoderModels: vi.fn(),
  isQoderPat: () => false,
  resolveQoderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/shared/qoder/cosy.js", () => ({
  buildCosyHeaders: () => ({ "Cosy-Request-Id": "test-signature" }),
  deriveMachineId: () => "test-machine",
}));

import { QoderExecutor } from "../../open-sse/executors/qoder.js";

const frame = (body, statusCodeValue = 200) =>
  `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(body) })}\n\n`;
const credentials = { accessToken: "test-token", providerSpecificData: { userId: "test-user" } };
const execute = () => new QoderExecutor().execute({
  model: "smodel",
  body: { messages: [{ role: "user", content: "ping" }] },
  stream: true,
  credentials,
});

function upstreamResponse(chunks, cancel, close = true) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
    cancel,
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("Qoder queue-aware executor streaming", () => {
  beforeEach(() => { proxyAwareFetch.mockReset(); });

  it("forwards a clean completion exactly once without replaying inference", async () => {
    proxyAwareFetch.mockResolvedValue(upstreamResponse([
      frame({ choices: [{ delta: { content: "PONG" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]));
    const result = await execute();
    const text = await result.response.text();
    expect(text.match(/PONG/g)).toHaveLength(1);
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("ends at the terminal frame without forwarding trailing completion data", async () => {
    proxyAwareFetch.mockResolvedValue(upstreamResponse([
      frame({ choices: [{ delta: { content: "OK" } }] }),
      "data: [DONE]\n\n",
      frame({ choices: [{ delta: { content: "ignored" } }] }),
    ]));
    const result = await execute();
    const text = await result.response.text();
    expect(text).toContain("OK");
    expect(text).not.toContain("ignored");
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a refused stream and does not replay a billing failure", async () => {
    const cancel = vi.fn();
    proxyAwareFetch.mockResolvedValue(upstreamResponse([
      frame({ code: "112", message: "Quota exhausted" }, 403),
    ], cancel, false));
    const result = await execute();
    expect(result.response.status).toBe(403);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
