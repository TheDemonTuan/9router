import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestChatGptWebBridge,
  resetChatGptWebTurnSlots,
  sanitizeChatGptWebMaxConcurrency,
} from "../../open-sse/services/chatgptWebBridge.js";

const connection = { id: "bridge-concurrency", providerSpecificData: { bridgeId: "personal" } };

function streamResponse() {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  return { response: new Response(body, { status: 200 }), controller };
}

beforeEach(() => resetChatGptWebTurnSlots());
afterEach(() => vi.restoreAllMocks());

describe("ChatGPT Web per-connection concurrency", () => {
  it("accepts five turns and returns structured provider_busy for the sixth", async () => {
    const pending = [];
    const fetchImpl = vi.fn(async () => {
      const item = streamResponse();
      pending.push(item);
      return item.response;
    });

    const results = await Promise.all(Array.from({ length: 6 }, () => requestChatGptWebBridge(
      connection,
      "/v1/responses",
      { method: "POST" },
      { socketPath: "fixture", fetchImpl, turn: true },
    )));

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(results.slice(0, 5).every((result) => result.status === 200)).toBe(true);
    expect(results[5].status).toBe(503);
    await expect(results[5].json()).resolves.toMatchObject({ error: { code: "provider_busy" } });

    const reads = results.slice(0, 5).map((result) => result.text());
    pending.forEach(({ controller }) => controller.close());
    await Promise.all(reads);
  });

  it("releases a slot after an error body is consumed", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response("after"));

    const error = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    expect(error.status).toBe(429);
    await expect(error.text()).resolves.toBe("busy");

    const after = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    expect(after.status).toBe(200);
  });

  it("releases a slot on EOF and body cancellation", async () => {
    const first = streamResponse();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(new Response("done"));

    const held = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    const heldText = held.text();
    first.controller.close();
    expect(await heldText).toBe("");

    const released = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    expect(released.status).toBe(200);

    const cancellable = streamResponse();
    fetchImpl.mockResolvedValueOnce(cancellable.response);
    const cancelled = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    await cancelled.body.cancel("client closed");
    fetchImpl.mockResolvedValueOnce(new Response("after"));
    const afterCancel = await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    });
    expect(afterCancel.status).toBe(200);
  });

  it("does not leak slots on fetch errors and clamps catalog limits", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("ok"));

    await expect(requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    })).rejects.toThrow("offline");
    expect(await (await requestChatGptWebBridge(connection, "/v1/responses", {}, {
      socketPath: "fixture", fetchImpl, turn: true,
    })).text()).toBe("ok");

    expect(sanitizeChatGptWebMaxConcurrency(99)).toBe(5);
    expect(sanitizeChatGptWebMaxConcurrency(0)).toBeNull();
    expect(sanitizeChatGptWebMaxConcurrency("5")).toBeNull();
  });
});
