import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLIENT_VERSION } from "../../open-sse/config/codexClient.js";
import {
  CODEX_MODELS_URL,
  CODEX_OFFICIAL_MODELS_URL,
  clearCodexModelCache,
} from "../../open-sse/services/codexModels.js";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  connection: {
    id: "codex-route-account",
    provider: "codex",
    accessToken: "test-token",
    providerSpecificData: {
      chatgptAccountId: "acct-route",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.route.test:8080",
    },
  },
  updateProviderCredentials: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mocks.proxyAwareFetch(...args),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async () => mocks.connection),
  getProxyPoolById: vi.fn(async () => null),
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

const makeResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => headers[name] || headers[name.toLowerCase()] || null,
  },
  json: async () => body,
});

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

describe("Codex provider models route with live resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCodexModelCache();
  });

  it("transitions unverified (403) -> observed on refresh with correct proxy, exposes clientVersion and clears warning", async () => {
    let liveStatus = 403;

    mocks.proxyAwareFetch.mockImplementation(async (url, opts, proxyOptions) => {
      if (url.startsWith(CODEX_MODELS_URL)) {
        // Enforce proxyOptions and ChatGPT-Account-ID
        if (
          !proxyOptions?.connectionProxyUrl?.includes("proxy.route.test") ||
          opts?.headers?.["ChatGPT-Account-ID"] !== "acct-route"
        ) {
          return makeResponse({ error: "Missing or wrong proxy" }, 403);
        }

        if (liveStatus === 403) {
          return makeResponse({ error: "forbidden" }, 403);
        }

        return makeResponse({
          models: [
            {
              slug: "gpt-fixture-candidate",
              display_name: "GPT Fixture Candidate",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
              visibility: "list",
              supported_in_api: true,
              minimal_client_version: "0.153.0",
            },
          ],
        });
      }

      if (url.startsWith(CODEX_OFFICIAL_MODELS_URL)) {
        return makeResponse({
          models: [
            {
              slug: "gpt-fixture-candidate",
              display_name: "GPT Fixture Candidate Official",
              minimal_client_version: "0.153.0",
              visibility: "list",
            },
          ],
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    // Stage 1: Live returns 403 -> falls back to static + candidates with 403 warning
    const req1 = new Request(`http://localhost/api/providers/${mocks.connection.id}/models`);
    const res1 = await GET(req1, { params: Promise.resolve({ id: mocks.connection.id }) });
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    expect(data1.provider).toBe("codex");
    expect(data1.connectionId).toBe(mocks.connection.id);
    expect(data1.access).toBe("unverified");
    expect(data1.source).toBe("static");
    expect(data1.resolved).toBe(true);
    expect(data1.clientVersion).toBe(CODEX_CLIENT_VERSION);
    expect(data1.warning).toContain("Live Codex catalog unavailable (HTTP 403); using the static fallback.");
    expect(data1.models.map((m) => m.id)).not.toContain("gpt-fixture-candidate");
    const candidate = data1.candidateModels.find((m) => m.id === "gpt-fixture-candidate");
    expect(candidate).toBeDefined();
    expect(candidate.discoveryStatus).toBe("official-unverified");
    expect(candidate.discoverySource).toBe("official");

    // Stage 2: Upstream recovers, call route with ?refresh=true
    liveStatus = 200;
    const req2 = new Request(`http://localhost/api/providers/${mocks.connection.id}/models?refresh=true`);
    const res2 = await GET(req2, { params: Promise.resolve({ id: mocks.connection.id }) });
    expect(res2.status).toBe(200);
    const data2 = await res2.json();

    expect(data2.access).toBe("observed");
    expect(data2.source).toBe("live");
    expect(data2.resolved).toBe(true);
    expect(data2.clientVersion).toBe(CODEX_CLIENT_VERSION);
    expect(data2.warning).toBeUndefined(); // Warning cleared on recovery
    expect(data2.models.map((m) => m.id)).toContain("gpt-fixture-candidate");
    expect(data2.candidateModels).toBeUndefined(); // No remaining candidates
  });
});
