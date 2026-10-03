import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  verifyCloudflareAccessJwt: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/auth/cloudflareAccess", () => ({
  verifyCloudflareAccessJwt: mocks.verifyCloudflareAccessJwt,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(localRequest("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote /responses rewrite without API key", async () => {
    const response = await proxy(request("/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote /responses rewrite with a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/responses", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("RTK dashboard API guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    delete process.env.API_HOST;
  });

  for (const path of ["/api/rtk/status", "/api/rtk/check", "/api/token-saver/status"]) {
    it(`${path} requires dashboard auth and stays off API_HOST`, async () => {
      expect((await proxy(request(path, { host: "dashboard.example.com" }))).status).toBe(401);
      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      const authorized = request(path, { host: "dashboard.example.com" });
      authorized.cookies.get.mockReturnValue({ value: "test-session" });
      expect(await proxy(authorized)).toBe(mocks.nextResponse);
      process.env.API_HOST = "api.example.com";
      expect((await proxy(request(path, { host: "api.example.com" }))).status).toBe(404);
    });
  }
  it("protects metrics with dashboard auth and excludes the API domain", async () => {
    const path = "/dashboard/token-saver/metrics";
    const denied = await proxy(request(path, { host: "dashboard.example.com" }));
    expect(denied.status).toBe(307);
    expect(denied.url.pathname).toBe("/login");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const authorized = request(path, { host: "dashboard.example.com" });
    authorized.cookies.get.mockReturnValue({ value: "test-session" });
    expect(await proxy(authorized)).toBe(mocks.nextResponse);
    process.env.API_HOST = "api.example.com";
    expect((await proxy(request(path, { host: "api.example.com" }))).status).toBe(404);
  });
});

describe("dashboard and monitor Access guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_HOST;
    mocks.getSettings.mockResolvedValue({ requireLogin: true, tunnelDashboardAccess: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it("accepts verified Access JWT on dashboard", async () => {
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(true);
    expect(await proxy(request("/dashboard", { "cf-access-jwt-assertion": "valid-jwt" }))).toBe(mocks.nextResponse);
    expect(mocks.verifyCloudflareAccessJwt).toHaveBeenCalledWith("valid-jwt");
  });

  it("redirects invalid JWT instead of trusting its presence", async () => {
    const response = await proxy(request("/dashboard", { "cf-access-jwt-assertion": "invalid-jwt" }));
    expect(response.status).toBe(307);
    expect(response.url.pathname).toBe("/login");
  });

  it("accepts existing signed dashboard cookie", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const authorized = request("/dashboard");
    authorized.cookies.get.mockImplementation((name) => name === "auth_token" ? { value: "session" } : undefined);
    expect(await proxy(authorized)).toBe(mocks.nextResponse);
  });

  it("requires auth for readiness even with requireLogin disabled", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    expect((await proxy(request("/api/monitor/ready", { host: "admin.example.com" }))).status).toBe(401);
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(true);
    expect(await proxy(request("/api/monitor/ready", { "cf-access-jwt-assertion": "jwt" }))).toBe(mocks.nextResponse);
  });

  it("keeps readiness off the API host", async () => {
    process.env.API_HOST = "api.example.com";
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(true);
    expect((await proxy(request("/api/monitor/ready", {
      host: "api.example.com", "cf-access-jwt-assertion": "jwt",
    }))).status).toBe(404);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});

describe("ChatGPT Web runtime dashboard-only administration", () => {
  const path = "/api/providers/chatgpt-web/runtime/profiles";
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_HOST;
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(false);
  });
  it.each([{}, { authorization: "Bearer valid-api-key" }, { "x-9r-cli-token": "cli-token" }])("rejects non-dashboard credentials even with login disabled: %j", async (headers) => {
    expect((await proxy(localRequest(path, { host: "localhost:20127", ...headers }))).status).toBe(401);
  });
  it("accepts only a verified dashboard session or Access JWT", async () => {
    const authorized = request(path, { host: "admin.example.com" });
    authorized.cookies.get.mockImplementation(name => name === "auth_token" ? { value: "session" } : undefined);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    expect(await proxy(authorized)).toBe(mocks.nextResponse);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(true);
    expect(await proxy(request(path, { "cf-access-jwt-assertion": "access-jwt" }))).toBe(mocks.nextResponse);
  });
  it("excludes the public API domain even with valid dashboard authentication", async () => {
    process.env.API_HOST = "api.example.com";
    mocks.verifyCloudflareAccessJwt.mockResolvedValue(true);
    expect((await proxy(request(path, { host: "api.example.com", "cf-access-jwt-assertion": "jwt" }))).status).toBe(404);
  });
});
