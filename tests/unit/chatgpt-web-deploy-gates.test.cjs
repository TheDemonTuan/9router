// Run with Bun: its built-in YAML parser keeps workflow checks dependency-free.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "../..");

function closureFixture(failAt = "", version = "1.4.0") {
  const temp = mkdtempSync(join(tmpdir(), "cgw-closure-test-"));
  mkdirSync(join(temp, ".deploy"));
  copyFileSync(join(root, ".deploy/verify-cgw-runtime.sh"), join(temp, ".deploy/verify-cgw-runtime.sh"));
  const runtime = join(temp, "services/chatgpt-web-runtime");
  mkdirSync(runtime, { recursive: true });
  for (const name of ["src", "scripts", "tests"]) mkdirSync(join(runtime, name));
  for (const name of ["package.json", "bun.lock", "tsconfig.json", "protocol.js", "session-transfer.js", "browser-request.js", "agent-request.js", "image-build-manifest.json"]) {
    writeFileSync(join(runtime, name), "{}");
  }
  mkdirSync(join(temp, "node_modules/fflate"), { recursive: true });
  mkdirSync(join(runtime, "node_modules/fflate"), { recursive: true });
  writeFileSync(join(temp, ".env"), "MUST_NOT_BE_COPIED=1\n");
  const bin = join(temp, "bin"); mkdirSync(bin);
  const log = join(temp, "commands");
  writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == --version ]]; then printf '%s\\n' "$FIXTURE_VERSION"; exit 0; fi
[[ "$PWD" != "$FIXTURE_REPO"/services/chatgpt-web-runtime ]]
[[ ! -e node_modules && ! -e ../node_modules && ! -e .env && ! -e ../.env ]]
[[ "$HOME" == "$(dirname "$PWD")/home" && "$DATA_DIR" == "$HOME/data" && "$CGW_DATA_DIR" == "$DATA_DIR" ]]
printf '%s|%s\\n' "$PWD" "$*" >> "$FIXTURE_LOG"
[[ "$*" != "$FAIL_AT" ]] || exit 42
`, { mode: 0o700 });
  const result = spawnSync("bash", [join(temp, ".deploy/verify-cgw-runtime.sh")], {
    cwd: temp, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_VERSION: version, FIXTURE_REPO: temp, FIXTURE_LOG: log, FAIL_AT: failAt },
  });
  const commands = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => line.split("|")) : [];
  return { result, commands, close() { rmSync(temp, { recursive: true, force: true }); } };
}

test("cold closure excludes installed gateway/runtime dependencies and cleans owned state", () => {
  const f = closureFixture();
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.deepEqual(f.commands.map(([, command]) => command), [
      "install --frozen-lockfile", "run typecheck", "run test",
      `build src/server.ts src/companion/main.ts --target bun --external playwright-core --outdir ${resolve(f.commands[0][0], "../entrypoints")}`,
    ]);
    assert(!existsSync(resolve(f.commands[0][0], "..")), "The cold copy must be cleaned after success");
  } finally { f.close(); }
});

for (const failedCommand of ["install --frozen-lockfile", "run typecheck", "run test"]) {
  test(`cold closure fails closed and cleans state when ${failedCommand} fails`, () => {
    const f = closureFixture(failedCommand);
    try {
      assert.equal(f.result.status, 42, f.result.stderr);
      assert.equal(f.commands.at(-1)[1], failedCommand);
      assert(!existsSync(resolve(f.commands[0][0], "..")), "The cold copy must be cleaned after failure");
    } finally { f.close(); }
  });
}

test("cold closure rejects a Bun version mismatch before installing anything", () => {
  const f = closureFixture("", "1.4.2");
  try {
    assert.notEqual(f.result.status, 0);
    assert.deepEqual(f.commands, []);
  } finally { f.close(); }
});
