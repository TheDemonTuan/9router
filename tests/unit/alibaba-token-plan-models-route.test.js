// Route-level acceptance: /api/providers/[id]/models uses the same effective
// Alibaba Token Plan catalog contract as /v1/models. Network mocked; isolated
// DB supplied by the test harness DATA_DIR.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchMock, connections } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  connections: new Map(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
  default: (...args) => fetchMock(...args),
}));
// Route boundary only: emulate the connection repository so this integration
// test runs under Node Vitest. The handler, effective catalog resolver, and
// network boundary remain the shipped modules.
vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async (id) => connections.get(id) || null),
}));

import { GET } from "@/app/api/providers/[id]/models/route.js";
import { clearAlitpCatalogCache } from "../../open-sse/services/alibabaTokenPlanModels.js";

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => data,
});

beforeEach(() => {
  fetchMock.mockReset();
  connections.clear();
  clearAlitpCatalogCache();
});

function seed(edition = "personal", suffix = Date.now()) {
  const connection = {
    id: `alitp-${edition}-${suffix}`,
    provider: "alitp-intl",
    apiKey: `sk-alitp-route-${suffix}`,
    providerSpecificData: { tokenPlanEdition: edition },
    isActive: true,
  };
  connections.set(connection.id, connection);
  return connection;
}

const getModels = (id) => GET(
  new Request(`http://localhost/api/providers/${id}/models`),
  { params: Promise.resolve({ id }) },
);

describe("Alibaba Token Plan models route", () => {
  it("403 discovery falls back to Personal catalog without credential/error leakage", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "forbidden raw detail" }, 403));
    const conn = seed("personal", "fallback");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.provider).toBe("alitp-intl");
    expect(data.source).toBe("fallback");
    expect(data.models).toHaveLength(11);
    expect(data.models.map((m) => m.id)).toContain("qwen3.8-max");
    expect(data.models.map((m) => m.id)).toContain("glm-5.3");
    expect(data.models.map((m) => m.id)).not.toContain("kimi-k2.7-code");
    expect(data.models.map((m) => m.id)).not.toContain("qwen3.8-max-preview");
    expect(data.warning).toMatch(/official personal catalog/i);
    expect(JSON.stringify(data)).not.toContain(conn.apiKey);
    expect(JSON.stringify(data)).not.toContain("forbidden raw detail");
  });

  it("Team fallback includes Team-only models, still hides deprecated preview", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 404));
    const conn = seed("team", "team");
    const data = await (await getModels(conn.id)).json();
    const ids = data.models.map((m) => m.id);
    expect(data.source).toBe("fallback");
    expect(ids).toContain("kimi-k2.7-code");
    expect(ids).toContain("qwen3.6-plus");
    expect(ids).toContain("MiniMax-M2.5");
    expect(ids).not.toContain("qwen3.8-max-preview");
  });

  it("live discovery wins, returns curated capabilities, and filters preview", async () => {
    fetchMock.mockResolvedValueOnce(response({
      data: [
        { id: "qwen3.8-max" },
        { id: "qwen3.8-max-preview" },
        { id: "new-live-model" },
      ],
    }));
    const conn = seed("personal", "live");
    const data = await (await getModels(conn.id)).json();
    expect(data.source).toBe("live");
    expect(data.models.map((m) => m.id)).toEqual(["qwen3.8-max", "new-live-model"]);
    expect(data.models.find((m) => m.id === "qwen3.8-max").capabilities).toMatchObject({
      vision: true,
      contextWindow: 1000000,
    });
    expect(JSON.stringify(data)).not.toContain(conn.apiKey);
  });

  it("unknown connection remains a 404", async () => {
    const res = await getModels("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});
