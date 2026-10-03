import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import migration from "../../src/lib/db/migrations/005-chatgpt-web-runtime-profiles.js";

const root = await mkdtemp(join(tmpdir(), "cgw-profile-migration-"));
let sqlite;
try {
  const file = join(root, "fixture.sqlite");
  sqlite = new Database(file, { create: true });
  const adapter = {
    all: (sql, params = []) => sqlite.query(sql).all(...params),
    run: (sql, params = []) => sqlite.query(sql).run(...params),
    transaction: fn => sqlite.transaction(fn)(),
  };
  sqlite.exec("CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, isActive INTEGER, data TEXT); CREATE TABLE kv(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key));");
  const insert = (id, selectors) => adapter.run("INSERT INTO providerConnections VALUES(?, 'chatgpt-web', 1, ?)", [id, JSON.stringify({ providerSpecificData: selectors })]);
  insert("valid", { bridgeId: "personal", mode: "full" });
  insert("conflict", { bridgeId: "personal", profileId: "other" });
  adapter.run("INSERT INTO kv VALUES('chatgptWebPins', 'native-thread-key', ?)", [JSON.stringify({ connectionId: "valid", lastUsed: 9876 })]);
  adapter.run("INSERT INTO kv VALUES('chatgptWebPins', 'broken', 'invalid-json')");
  assert.throws(() => adapter.transaction(() => migration.up(adapter)));
  assert.deepEqual(JSON.parse(adapter.all("SELECT data FROM providerConnections WHERE id = 'valid'")[0].data).providerSpecificData, { bridgeId: "personal", mode: "full" });
  assert.deepEqual(adapter.all("SELECT * FROM kv WHERE scope = 'chatgptWebLegacyPins'"), []);
  adapter.run("DELETE FROM kv WHERE key = 'broken'");
  adapter.transaction(() => migration.up(adapter));
  const once = adapter.all("SELECT * FROM providerConnections ORDER BY id");
  adapter.transaction(() => migration.up(adapter));
  assert.deepEqual(adapter.all("SELECT * FROM providerConnections ORDER BY id"), once);
  sqlite.close();
  sqlite = new Database(file, { readonly: true });
  const valid = sqlite.query("SELECT * FROM providerConnections WHERE id = 'valid'").get();
  assert.equal(valid.isActive, 1);
  assert.deepEqual(JSON.parse(valid.data).providerSpecificData, { profileId: "personal" });
  const conflict = sqlite.query("SELECT * FROM providerConnections WHERE id = 'conflict'").get();
  assert.equal(conflict.isActive, 0);
  assert.equal(JSON.parse(conflict.data).errorCode, "cgw_profile_migration_required");
  assert.deepEqual(sqlite.query("SELECT * FROM kv WHERE scope = 'chatgptWebPins'").all(), []);
  const tombstone = sqlite.query("SELECT * FROM kv WHERE scope = 'chatgptWebLegacyPins'").get();
  assert.equal(tombstone.key, "native-thread-key");
  assert.deepEqual(JSON.parse(tombstone.value), { status: "legacy_unavailable", lastUsed: 9876 });
  console.log("CGW profile migration smoke passed: persisted selector, conflict deactivation, rollback, idempotency, terminal legacy pin");
} finally {
  sqlite?.close();
  await rm(root, { recursive: true, force: true });
}
