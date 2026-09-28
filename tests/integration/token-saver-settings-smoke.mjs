import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--child")) {
  const home = await mkdtemp(join(tmpdir(), "router-token-saver-smoke-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    DATA_DIR: join(home, "data"),
    ENABLE_REQUEST_LOGS: "false",
    ENABLE_TRANSLATOR: "false",
  };
  delete env.RTK_URL;
  for (const key of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy)$/i.test(key)) delete env[key];
  }
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    const code = await child.exited;
    clearTimeout(timeout);
    assert.equal(code, 0, "token saver settings smoke failed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
} else {
  const { getAdapter, resetAdapterForTest } = await import("../../src/lib/db/driver.js");
  const { getSettings, updateSettings, mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");
  const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
  const { injectPonytail } = await import("../../open-sse/rtk/ponytail.js");
  const { CAVEMAN_PROMPTS, CAVEMAN_LEVELS, normalizeCavemanLevel } = await import("../../open-sse/rtk/cavemanPrompts.js");
  const { PONYTAIL_PROMPTS, PONYTAIL_LEVELS } = await import("../../open-sse/rtk/ponytailPrompt.js");
  const { FORMATS } = await import("../../open-sse/translator/formats.js");

  try {
    // 1. Fresh DB via adapter and seed synthetic settings row with wenyan-full alias
    const db = await getAdapter();
    const initialData = { cavemanLevel: "wenyan-full", cavemanEnabled: true, customField: { keep: true } };
    db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [JSON.stringify(initialData)]);

    // 2. getSettings() returns canonical wenyan without modifying raw DB row
    const rowBefore = db.get("SELECT data FROM settings WHERE id = 1");
    const readSettings = await getSettings();
    assert.equal(readSettings.cavemanLevel, "wenyan");
    const rowAfter = db.get("SELECT data FROM settings WHERE id = 1");
    assert.equal(rowAfter.data, rowBefore.data, "read must not rewrite the database row");

    const rawInput = { cavemanLevel: "wenyan-full", other: 123 };
    const rawInputClone = structuredClone(rawInput);
    const merged = mergeWithDefaults(rawInput);
    assert.equal(merged.cavemanLevel, "wenyan");
    assert.deepEqual(rawInput, rawInputClone, "input object to mergeWithDefaults must not mutate");

    // 3. updateSettings normalizes next when cavemanLevel present and preserves other fields
    const updated1 = await updateSettings({ ponytailEnabled: true });
    assert.equal(updated1.cavemanLevel, "wenyan");
    const rowAfterUpdate1 = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    assert.equal(rowAfterUpdate1.cavemanLevel, "wenyan");
    assert.deepEqual(rowAfterUpdate1.customField, { keep: true });

    const updated2 = await updateSettings({ cavemanLevel: "wenyan-full" });
    assert.equal(updated2.cavemanLevel, "wenyan");
    const rowAfterUpdate2 = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    assert.equal(rowAfterUpdate2.cavemanLevel, "wenyan");

    resetAdapterForTest();
    const dbReopened = await getAdapter();
    const reloaded = await getSettings();
    assert.equal(reloaded.cavemanLevel, "wenyan");

    await updateSettings({ cavemanLevel: "wenyan" });
    const rowCanonical = JSON.parse(dbReopened.get("SELECT data FROM settings WHERE id = 1").data);
    assert.equal(rowCanonical.cavemanLevel, "wenyan");

    // 4. Seed row without cavemanLevel: unrelated updates must NOT add cavemanLevel to raw data
    dbReopened.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [JSON.stringify({ customField: { keep: true } })]);
    await updateSettings({ ponytailEnabled: false });
    const rowMissingLevel = JSON.parse(dbReopened.get("SELECT data FROM settings WHERE id = 1").data);
    assert.equal(rowMissingLevel.cavemanLevel, undefined, "raw row without cavemanLevel must not gain cavemanLevel on unrelated update");
    const missingLevelSettings = await getSettings();
    assert.equal(missingLevelSettings.cavemanLevel, "full", "missing level gets default full");

    await updateSettings({ cavemanLevel: "not-a-level" });
    const rowUnknown = JSON.parse(dbReopened.get("SELECT data FROM settings WHERE id = 1").data);
    assert.equal(rowUnknown.cavemanLevel, "not-a-level", "unknown level round-trip preserved");
    const unknownSettings = await getSettings();
    assert.equal(unknownSettings.cavemanLevel, "not-a-level");

    assert.equal(normalizeCavemanLevel(undefined), undefined);
    assert.equal(normalizeCavemanLevel(null), null);
    assert.equal(normalizeCavemanLevel("WENYAN-FULL"), "WENYAN-FULL");
    assert.equal(normalizeCavemanLevel("wenyan-full"), "wenyan");

    // 5. Injections: alias vs canonical yield identical bodies and SEP segments
    const bodyCanonical = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] };
    const bodyAlias = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] };

    injectCaveman(bodyCanonical, FORMATS.OPENAI, "wenyan");
    injectCaveman(bodyAlias, FORMATS.OPENAI, "wenyan-full");
    assert.deepEqual(bodyAlias, bodyCanonical);
    assert.deepEqual(bodyAlias.messages[0].content.split("\n\n"), ["base", CAVEMAN_PROMPTS.wenyan]);

    injectCaveman(bodyAlias, FORMATS.OPENAI, "wenyan");
    injectPonytail(bodyAlias, FORMATS.OPENAI, "full");
    injectPonytail(bodyAlias, FORMATS.OPENAI, "full");
    assert.deepEqual(bodyAlias.messages[0].content.split("\n\n"), ["base", CAVEMAN_PROMPTS.wenyan, PONYTAIL_PROMPTS.full]);
    assert.equal(bodyAlias.messages[1].content, "hello");

    const bodyUnknown = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] };
    injectCaveman(bodyUnknown, FORMATS.OPENAI, "not-a-level");
    assert.equal(bodyUnknown.messages[0].content, "base");

    // 6. Measure UTF-8 byte lengths of all Caveman (<=1900) and Ponytail (<=2100) prompts
    for (const [lvl, prompt] of Object.entries(CAVEMAN_PROMPTS)) {
      const bytes = Buffer.byteLength(prompt, "utf8");
      assert.ok(bytes <= 1900, `Caveman prompt ${lvl} exceeds 1900 bytes (${bytes})`);
      console.log(`Caveman ${lvl}: ${bytes} bytes`);
    }
    for (const [lvl, prompt] of Object.entries(PONYTAIL_PROMPTS)) {
      const bytes = Buffer.byteLength(prompt, "utf8");
      assert.ok(bytes <= 2100, `Ponytail prompt ${lvl} exceeds 2100 bytes (${bytes})`);
      console.log(`Ponytail ${lvl}: ${bytes} bytes`);
    }

    console.log("PASS token saver alias, settings persistence, injection boundaries");
  } finally {
    resetAdapterForTest();
  }
}
