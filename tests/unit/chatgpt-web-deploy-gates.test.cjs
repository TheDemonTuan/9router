// Run with Bun: its built-in YAML parser keeps workflow checks dependency-free.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "../..");
const workflow = name => Bun.YAML.parse(readFileSync(join(root, ".github/workflows", name), "utf8"));

test("app build waits for same-revision offline native gates without inheriting deployment secrets", () => {
  const deploy = workflow("deploy.yml");
  const gates = deploy.jobs["runtime-gates"];
  assert.equal(gates.uses, "./.github/workflows/chatgpt-web-runtime.yml");
  assert.equal(gates.needs, "activation-fence");
  assert.deepEqual(gates.with, { verification_only: true });
  assert.equal(gates.secrets, undefined);
  assert.equal(gates.if, undefined);
  assert(deploy.jobs.build.needs.includes("runtime-gates"));
  assert(deploy.jobs.build.needs.includes("security-source"));
  assert(deploy.jobs.deploy.needs.includes("security-image"));
  assert.equal(deploy.jobs.build.if, undefined);
});

test("reusable gates preserve both native architectures and cannot activate operator jobs", () => {
  const runtime = workflow("chatgpt-web-runtime.yml");
  assert.deepEqual(runtime.on.workflow_call.inputs, {
    verification_only: {
      type: "boolean", default: true,
      description: "Run offline gates only; never activate live accounts, publication or deployment",
    },
  });
  assert.equal(runtime.on.push, undefined, "Master pushes must not launch duplicate native jobs");
  assert(runtime.on.pull_request);
  assert(runtime.on.workflow_dispatch);
  assert.deepEqual(runtime.jobs.native.strategy.matrix.include.map(row => row.arch), ["amd64", "arm64"]);
  const closure = runtime.jobs.native.steps.find(step => step.name === "Check frozen runtime types, behavior and entrypoint closure");
  assert(closure.run.includes("bash ../../.deploy/verify-cgw-runtime.sh"));
  assert(closure.run.includes("bun install --frozen-lockfile"));
  for (const name of ["live-staging", "security-source", "publish", "security-image", "deploy-runtime"]) {
    assert(runtime.jobs[name].if.includes("!inputs.verification_only"), `${name} must be disabled for release verification`);
    assert(runtime.jobs[name].if.includes("github.event_name == 'workflow_dispatch'"));
  }
  for (const name of ["activation-fence", "gateway-contracts", "native"]) {
    const concurrency = runtime.jobs[name].concurrency;
    assert(concurrency.group.includes("inputs.verification_only"));
    assert(concurrency.group.includes("github.run_id"));
    assert(concurrency["cancel-in-progress"].includes("!inputs.verification_only"));
  }
  assert(runtime.concurrency.group.includes("cgw-runtime-verification-run-{0}"));
});

function closureFixture(failAt = "", version = "1.4.0") {
  const temp = mkdtempSync(join(tmpdir(), "cgw-closure-test-"));
  mkdirSync(join(temp, ".deploy"));
  copyFileSync(join(root, ".deploy/verify-cgw-runtime.sh"), join(temp, ".deploy/verify-cgw-runtime.sh"));
  const runtime = join(temp, "services/chatgpt-web-runtime");
  mkdirSync(runtime, { recursive: true });
  for (const name of ["src", "scripts", "tests"]) mkdirSync(join(runtime, name));
  for (const name of ["package.json", "bun.lock", "tsconfig.json", "protocol.js", "session-transfer.js", "browser-request.js", "image-build-manifest.json"]) {
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
