import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("model test route kind routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      created: 1,
      data: [{ b64_json: "abc" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes image model tests to /api/v1/images/generations", async () => {
    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hf/black-forest-labs/FLUX.1-schnell",
        kind: "image",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/images/generations"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "hf/black-forest-labs/FLUX.1-schnell",
          prompt: "test",
        }),
      })
    );
  });

  it("routes embedding model tests to /api/v1/embeddings", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2] }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voyage/voyage-3-large",
        kind: "embedding",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/embeddings"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "voyage/voyage-3-large",
          input: "test",
        }),
      })
    );
  });

  it("fails embedding model tests when provider returns no embedding data", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: null }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voyage/voyage-3-large",
        kind: "embedding",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.error).toBe("Provider returned no embedding data");
  });

  it("routes stt model tests to /api/v1/audio/transcriptions", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: "test",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hf/openai/whisper-small",
        kind: "stt",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/audio/transcriptions"),
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      })
    );
  });

  it("returns formatted HTTP errors for non-2xx embedding responses", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "bad upstream" },
    }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    }));

    const { POST } = await import("../../src/app/api/models/test/route.js");

    const req = new Request("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voyage/voyage-3-large",
        kind: "embedding",
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.status).toBe(502);
    expect(body.error).toBe("HTTP 502: bad upstream");
  });
});

describe("ChatGPT Web inference outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "synthetic-key", isActive: true }]);
    mocks.getProviderConnectionById.mockResolvedValue({ id: "account-a", provider: "chatgpt-web", isActive: true });
  });
  afterEach(() => { global.fetch = originalFetch; });
  const probe = async (body = {}) => {
    const { POST } = await import("../../src/app/api/models/test/route.js");
    return POST(new Request("http://localhost/api/models/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "cgw/chatgpt-web/gpt-5.6-sol", ...body }) }));
  };
  it("does not send without a real active API key", async () => {
    mocks.getApiKeys.mockResolvedValue([]); global.fetch = vi.fn();
    const response = await probe(); expect((await response.json()).ok).toBe(false); expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.getConsistentMachineId).not.toHaveBeenCalled();
  });
  it.each([
    { error: { message: "runtime failed" } },
    { status: "failed", choices: [{ finish_reason: "stop", message: { content: "partial" } }] },
    { choices: [{ finish_reason: "length", message: { content: "partial" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "" } }] },
  ])("rejects HTTP200 without successful complete text: %j", async payload => {
    global.fetch = vi.fn().mockResolvedValue(Response.json(payload));
    expect((await (await probe()).json()).ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("reports text and actual account only after a successful terminal", async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: "Offline answer" } }] }, { headers: { "x-9router-connection-id": "account-a" } }));
    expect(await (await probe({ connectionId: "account-a" })).json()).toMatchObject({ ok: true, completionText: "Offline answer", connectionId: "account-a" });
  });
  it("rejects disabled or mismatched pins without account rotation", async () => {
    global.fetch = vi.fn();
    for (const connection of [null, { provider: "chatgpt-web", isActive: false }, { provider: "codex", isActive: true }]) {
      mocks.getProviderConnectionById.mockResolvedValue(connection);
      expect((await probe({ connectionId: "account-a" })).status).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
