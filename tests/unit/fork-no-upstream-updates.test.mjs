import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (file) => readFile(path.join(root, file), "utf8");
const exists = async (file) => {
  try {
    await access(path.join(root, file));
    return true;
  } catch {
    return false;
  }
};

test("fork has no upstream release updater entry points", async () => {
  await assert.doesNotMatch(await source("src/lib/appUpdater.js"), /spawnUpdaterAndExit|UPDATER_SCRIPT_PATH/);
  assert.equal(await exists("src/app/api/version/route.js"), false);
  assert.equal(await exists("src/app/api/version/update/route.js"), false);
  assert.equal(await exists("src/lib/updater/updater.js"), false);
});

test("CLI and Sidebar do not check npm for latest releases", async () => {
  for (const file of ["cli/cli.js", "src/shared/components/Sidebar.js"]) {
    await assert.doesNotMatch(await source(file), /registry\.npmjs\.org|npm[^\n]*@latest|\/api\/version/);
  }
});

test("shared config has no upstream changelog URL", async () => {
  const config = await source("src/shared/constants/config.js");
  assert.doesNotMatch(config, /changelogUrl|raw\.githubusercontent\.com\/decolua\/9router/);
  assert.match(config, /donateUrl/);
});
