// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});

describe("ChatGPT Web profile migration", () => {
  async function fixture() {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { default: migration } = await import("@/lib/db/migrations/005-chatgpt-web-runtime-profiles.js");
    const db = await getAdapter();
    const connection = (id, providerSpecificData, provider = "chatgpt-web") => db.run(
      "INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt) VALUES(?, ?, 'bridge', 1, ?, 'fixture', 'fixture')",
      [id, provider, JSON.stringify({ providerSpecificData })],
    );
    const row = id => {
      const persisted = db.get("SELECT data, isActive FROM providerConnections WHERE id = ?", [id]);
      return { ...JSON.parse(persisted.data), isActive: persisted.isActive };
    };
    return { db, migration, connection, row };
  }

  it("converts valid selectors, removes duplicate runtime settings and leaves non-CGW rows intact", async () => {
    const { db, migration, connection, row } = await fixture();
    connection("old", { bridgeId: "personal", mode: "full", cookie: "old-private" });
    connection("new", { profileId: "new-profile", useSavedChats: true });
    connection("other", { bridgeId: "unrelated", baseUrl: "https://example.test" }, "ollama-local");
    db.transaction(() => migration.up(db));
    expect(row("old")).toEqual({ providerSpecificData: { profileId: "personal" }, isActive: 1 });
    expect(row("new")).toEqual({ providerSpecificData: { profileId: "new-profile" }, isActive: 1 });
    expect(row("other")).toEqual({ providerSpecificData: { bridgeId: "unrelated", baseUrl: "https://example.test" }, isActive: 1 });
  });

  it("deactivates invalid or conflicting selectors instead of guessing an account", async () => {
    const { db, migration, connection, row } = await fixture();
    connection("conflict", { profileId: "new", bridgeId: "old" });
    connection("invalid", { bridgeId: "../escape" });
    connection("missing", {});
    db.transaction(() => migration.up(db));
    for (const id of ["conflict", "invalid", "missing"]) {
      expect(row(id)).toMatchObject({ isActive: 0, providerSpecificData: {}, testStatus: "error", errorCode: "cgw_profile_migration_required", lastError: expect.any(String) });
    }
  });

  it("preserves legacy keys and lastUsed as terminal tombstones and is idempotent", async () => {
    const { db, migration, connection } = await fixture();
    connection("old", { bridgeId: "personal" });
    db.run("INSERT INTO kv(scope, key, value) VALUES('chatgptWebPins', ?, ?)", ["exact-thread-key", JSON.stringify({ connectionId: "old", lastUsed: 12345 })]);
    db.transaction(() => migration.up(db));
    const snapshot = () => ({ connections: db.all("SELECT * FROM providerConnections ORDER BY id"), pins: db.all("SELECT * FROM kv ORDER BY scope, key") });
    const once = snapshot();
    db.transaction(() => migration.up(db));
    expect(snapshot()).toEqual(once);
    expect(db.all("SELECT * FROM kv WHERE scope = 'chatgptWebPins'")).toEqual([]);
    expect(JSON.parse(db.get("SELECT value FROM kv WHERE scope = 'chatgptWebLegacyPins' AND key = 'exact-thread-key'").value)).toEqual({ status: "legacy_unavailable", lastUsed: 12345 });
  });

  it("rolls back converted connections and pins if a later persisted pin is malformed", async () => {
    const { db, migration, connection, row } = await fixture();
    connection("old", { bridgeId: "personal", mode: "full" });
    db.run("INSERT INTO kv(scope, key, value) VALUES('chatgptWebPins', 'broken', 'not-json')");
    expect(() => db.transaction(() => migration.up(db))).toThrow();
    expect(row("old")).toEqual({ providerSpecificData: { bridgeId: "personal", mode: "full" }, isActive: 1 });
    expect(db.all("SELECT * FROM kv WHERE scope = 'chatgptWebLegacyPins'")).toEqual([]);
    expect(db.get("SELECT value FROM kv WHERE scope = 'chatgptWebPins' AND key = 'broken'").value).toBe("not-json");
  });
});
