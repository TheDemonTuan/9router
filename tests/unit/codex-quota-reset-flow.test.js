import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let getProviderCredentials;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-reset-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  const authModule = await import("@/sse/services/auth.js");
  getProviderCredentials = authModule.getProviderCredentials;
});

afterAll(async () => {
  try {
    const { resetAdapterForTest } = await import("@/lib/db/driver.js");
    resetAdapterForTest();
  } catch {}
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Codex Quota Reset End-to-End Flow", () => {
  it("clears 429 quota exhaustion lock on connection reactivation and allows routing", async () => {
    // 1. Create a valid Codex connection
    const conn = await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "test-user@example.com",
      accessToken: "valid-codex-access-token",
      refreshToken: "valid-codex-refresh-token",
      expiresAt: Date.now() + 3600_000,
      testStatus: "active",
      providerSpecificData: {
        chatgptAccountId: "ws-123",
      },
    });

    // Verify it is routable initially
    const initialCreds = await getProviderCredentials("codex", null, "gpt-5.3-codex");
    expect(initialCreds).toBeDefined();
    expect(initialCreds.allRateLimited).toBeUndefined();
    expect(initialCreds.accessToken).toBe("valid-codex-access-token");
    expect(initialCreds.connectionId).toBe(conn.id);

    // 2. Simulate 429 quota exhaustion lock (as recorded by markAccountUnavailable / chat failure)
    const futureReset = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await db.updateProviderConnection(conn.id, () => ({
      testStatus: "unavailable",
      errorCode: 429,
      unavailabilityReason: "quota_exhausted",
      lastError: "All accounts have exhausted their usage quota",
      "modelLock_gpt-5.3-codex": futureReset,
      "modelLockReason_gpt-5.3-codex": "quota_exhausted",
      "modelLockErrorCode_gpt-5.3-codex": 429,
    }), { resetHealth: false });

    // Verify DB state is locked
    const lockedConn = await db.getProviderConnectionById(conn.id);
    expect(lockedConn.testStatus).toBe("unavailable");
    expect(lockedConn.errorCode).toBe(429);
    expect(lockedConn.unavailabilityReason).toBe("quota_exhausted");
    expect(lockedConn["modelLock_gpt-5.3-codex"]).toBe(futureReset);

    // Verify getProviderCredentials rejects it with 429 quota exhaustion
    const lockedCreds = await getProviderCredentials("codex", null, "gpt-5.3-codex");
    expect(lockedCreds.allRateLimited).toBe(true);
    expect(lockedCreds.unavailabilityReason).toBe("quota_exhausted");

    // 3. Simulate quota reset action (calling updateProviderConnection with testStatus: 'active')
    await db.updateProviderConnection(conn.id, { testStatus: "active" });

    // Verify DB health state is completely cleansed
    const unlockedConn = await db.getProviderConnectionById(conn.id);
    expect(unlockedConn.testStatus).toBe("active");
    expect(unlockedConn.errorCode).toBeNull();
    expect(unlockedConn.unavailabilityReason).toBeNull();
    expect(unlockedConn.lastErrorType).toBeNull();
    expect(unlockedConn.rateLimitedUntil).toBeNull();
    expect(unlockedConn.backoffLevel).toBe(0);
    expect(unlockedConn["modelLock_gpt-5.3-codex"]).toBeNull();
    expect(unlockedConn["modelLockReason_gpt-5.3-codex"]).toBeNull();
    expect(unlockedConn["modelLockErrorCode_gpt-5.3-codex"]).toBeNull();

    // 4. Verify getProviderCredentials successfully selects the connection again
    const restoredCreds = await getProviderCredentials("codex", null, "gpt-5.3-codex");
    expect(restoredCreds).toBeDefined();
    expect(restoredCreds.allRateLimited).toBeUndefined();
    expect(restoredCreds.accessToken).toBe("valid-codex-access-token");
    expect(restoredCreds.connectionId).toBe(conn.id);
  });
});
