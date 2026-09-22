import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getApiKeys: mocks.getApiKeys,
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

describe("provider test-models route kind routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-hf",
      provider: "huggingface",
    });
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/v1/images/generations")) {
        return Promise.resolve(new Response(JSON.stringify({
          created: 1,
          data: [{ b64_json: "abc" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("loads dynamic ChatGPT Web models from the provider models route", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "bridge-1", provider: "chatgpt-web" });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ id: "chatgpt-web/high", name: "High" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const res = await POST(new Request("http://localhost/api/providers/bridge-1/test-models", { method: "POST" }), {
      params: Promise.resolve({ id: "bridge-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].modelId).toBe("chatgpt-web/high");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:20128/api/providers/bridge-1/models"
    );
  });

  it("routes huggingface image models to /api/v1/images/generations", async () => {
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");

    const req = new Request("http://localhost/api/providers/conn-hf/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-hf" }) });
    const body = await res.json();

    expect(body.provider).toBe("huggingface");
    expect(body.results.some((r) => r.modelId === "black-forest-labs/FLUX.1-schnell" && r.ok)).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/images/generations"),
      expect.objectContaining({
        method: "POST",
      })
    );
  });
});
