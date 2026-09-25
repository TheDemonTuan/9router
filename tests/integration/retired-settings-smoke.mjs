import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const retired = {
  headroomEnabled: true, headroomUrl: "http://127.0.0.1:8787",
  headroomProxyToken: "synthetic-secret", headroomCompressUserMessages: true,
  headroomCodeAware: true, headroomKompress: true,
  headroomTimeoutMs: 3000, headroomEffectiveTimeoutMs: 3000,
  headroomTimeoutSource: "legacy", HeadroomFutureFlag: true,
};
const settings = {
  ...retired, rtkEnabled: true, cavemanLevel: "ultra", customField: { arbitrary: true },
  capacityAdapter: { custom: { enabled: true } }, passwordHash: "synthetic-hash",
};
const assertClean = (value) => {
  assert.ok(!Object.keys(value).some((key) => /^headroom/i.test(key)));
  assert.equal(value.rtkEnabled, true);
  assert.equal(value.cavemanLevel, "ultra");
  assert.deepEqual(value.customField, { arbitrary: true });
  assert.deepEqual(value.capacityAdapter.custom, { enabled: true });
  assert.equal(value.passwordHash, "synthetic-hash");
};

if (!process.argv.includes("--child")) {
  for (const scenario of ["0", "1", "2", "fresh", "missing", "legacy", "malformed", "shape"]) {
    const home = await mkdtemp(join(tmpdir(), "router-retired-settings-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DATA_DIR: join(home, "data"), ENABLE_REQUEST_LOGS: "false", ENABLE_TRANSLATOR: "false" };
    for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
    try {
      const child = Bun.spawn([process.execPath, import.meta.path, "--child", scenario], { env, stdout: "inherit", stderr: "inherit" });
      const timeout = setTimeout(() => child.kill(), 20_000);
      const code = await child.exited;
      clearTimeout(timeout);
      assert.equal(code, 0, `retired settings ${scenario} failed`);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
  console.log("PASS retired settings migration, restore, and rollback");
} else {
  const scenario = process.argv.at(-1);
  const { createBunSqliteAdapter } = await import("../../src/lib/db/adapters/bunSqliteAdapter.js");
  const { TABLES, buildCreateTableSql } = await import("../../src/lib/db/schema.js");
  const { getAdapter, resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  const dbPath = join(process.env.DATA_DIR, "db", "data.sqlite");
  await mkdir(join(process.env.DATA_DIR, "db"), { recursive: true });
  const fixture = JSON.stringify(settings);
  const sentinel = { id: "synthetic-provider", provider: "openai-compatible-removal", authType: "apikey", name: "synthetic", email: null, priority: null, isActive: 1, data: '{"apiKey":"synthetic"}', createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  let seed;
  if (scenario === "legacy") {
    await writeFile(join(process.env.DATA_DIR, "db.json"), JSON.stringify({ settings, providerConnections: [{ ...sentinel, data: undefined, apiKey: "synthetic" }] }));
  } else if (scenario !== "fresh" && scenario !== "missing") {
    seed = await createBunSqliteAdapter(dbPath);
    for (const [name, def] of Object.entries(TABLES)) seed.exec(buildCreateTableSql(name, def));
    seed.run("INSERT INTO _meta(key,value) VALUES('schemaVersion',?)", [scenario === "malformed" || scenario === "shape" ? "2" : scenario]);
    seed.run("INSERT INTO settings(id,data) VALUES(1,?)", [scenario === "malformed" ? "{invalid-json" : scenario === "shape" ? "[]" : fixture]);
    seed.run("INSERT INTO providerConnections(id,provider,authType,name,email,priority,isActive,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)", Object.values(sentinel));
    seed.close();
  }
  try {
    if (scenario === "malformed" || scenario === "shape") {
      await assert.rejects(getAdapter(), { message: "Invalid persisted settings JSON" });
      const inspect = await createBunSqliteAdapter(dbPath);
      assert.equal(inspect.get("SELECT value FROM _meta WHERE key='schemaVersion'").value, "2");
      assert.equal(inspect.get("SELECT data FROM settings WHERE id=1").data, scenario === "malformed" ? "{invalid-json" : "[]");
      inspect.close();
    } else {
      const db = await getAdapter();
      assert.equal(db.get("SELECT value FROM _meta WHERE key='schemaVersion'").value, "3");
      if (scenario !== "fresh" && scenario !== "missing") assertClean(JSON.parse(db.get("SELECT data FROM settings WHERE id=1").data));
      if (scenario === "missing") assert.equal(db.get("SELECT data FROM settings WHERE id=1"), null);
      if (scenario !== "fresh" && scenario !== "missing") assert.deepEqual(db.get("SELECT * FROM providerConnections WHERE id=?", [sentinel.id]), sentinel);
      const { getSettings, updateSettings, exportSettings, exportDb, importDb } = await import("../../src/lib/db/index.js");
      const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
      assertClean(mergeWithDefaults(settings));
      assert.ok(Object.hasOwn(settings, "headroomEnabled"), "caller input must not mutate");
      if (scenario !== "fresh" && scenario !== "missing") {
        assertClean(await getSettings());
        assertClean(await exportSettings());
        assertClean((await exportDb()).settings);
      }
      await updateSettings(settings);
      assertClean(JSON.parse(db.get("SELECT data FROM settings WHERE id=1").data));
      assertClean(await getSettings());
      const before = db.get("SELECT data FROM settings WHERE id=1").data;
      resetAdapterForTest();
      const reboot = await getAdapter();
      assert.equal(reboot.get("SELECT data FROM settings WHERE id=1").data, before);
      const original = reboot.get("SELECT data FROM settings WHERE id=1").data;
      await assert.rejects(importDb({ settings: [], providerConnections: [] }), /Invalid settings object/);
      assert.equal(reboot.get("SELECT data FROM settings WHERE id=1").data, original, "failed restore must roll back");
      await importDb({ settings, providerConnections: [{ ...sentinel, data: undefined, apiKey: "synthetic" }] });
      assertClean(JSON.parse(reboot.get("SELECT data FROM settings WHERE id=1").data));
      assert.deepEqual(reboot.get("SELECT * FROM providerConnections WHERE id=?", [sentinel.id]), sentinel);
      assertClean((await exportDb()).settings);
    }
  } finally { resetAdapterForTest(); }
}
