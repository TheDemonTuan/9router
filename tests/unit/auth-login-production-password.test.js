import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers || {},
  })),
  getSettings: vi.fn(),
  compare: vi.fn(),
  cookies: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(() => false),
  isSamlConfigured: vi.fn(() => false),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
  isLocalRequest: vi.fn(() => false),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: mocks.isOidcConfigured }));
vi.mock("@/lib/auth/saml.js", () => ({ isSamlConfigured: mocks.isSamlConfigured }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));

const { POST } = await import("../../src/app/api/auth/login/route.js");

const originalNodeEnv = process.env.NODE_ENV;
const originalInitialPassword = process.env.INITIAL_PASSWORD;

function request(password) {
  return {
    headers: new Headers({ host: "router.example.com" }),
    json: async () => ({ password }),
  };
}

function settings(password) {
  return {
    password,
    authMode: "password",
    tunnelDashboardAccess: true,
  };
}

describe("production initial password policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.INITIAL_PASSWORD;
    mocks.getSettings.mockResolvedValue(settings(null));
    mocks.cookies.mockResolvedValue({ set: vi.fn() });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalInitialPassword === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = originalInitialPassword;
  });

  it.each(["", "123456", "change-this-production-password", "password"])(
    "rejects unsafe INITIAL_PASSWORD value %j without a stored hash",
    async (value) => {
      if (value) process.env.INITIAL_PASSWORD = value;

      const response = await POST(request(value));

      expect(response.status).toBe(503);
      expect(response.body.error).toContain("unique INITIAL_PASSWORD");
      expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    },
  );

  it("accepts a deliberate production INITIAL_PASSWORD", async () => {
    process.env.INITIAL_PASSWORD = "correct-horse-battery-staple";

    const response = await POST(request(process.env.INITIAL_PASSWORD));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });

  it("keeps stored-hash login working without INITIAL_PASSWORD", async () => {
    mocks.getSettings.mockResolvedValue(settings("$2b$10$stored-hash-fixture"));
    mocks.compare.mockResolvedValue(true);

    const response = await POST(request("stored-password"));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mocks.compare).toHaveBeenCalledWith("stored-password", "$2b$10$stored-hash-fixture");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledOnce();
  });
});
