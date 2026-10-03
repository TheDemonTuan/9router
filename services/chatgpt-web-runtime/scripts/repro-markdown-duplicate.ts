import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { duplicateScenarios } from "../tests/fixtures/markdown-duplicate-scenarios";

const upstreamRoot = process.argv[2];
if (!upstreamRoot) throw new Error("Usage: bun scripts/repro-markdown-duplicate.ts <pinned-upstream-root>");
const pinnedRevision = "fa2d2c6c24926078b46eedb2186f69f2e8d548d7";
const revision = Bun.spawnSync(["git", "-C", resolve(upstreamRoot), "rev-parse", "HEAD"]);
assert.equal(revision.exitCode, 0, "Pinned source must be a readable git checkout");
assert.equal(revision.stdout.toString().trim(), pinnedRevision, "Wrong upstream revision");
const sourcePath = "src/adapters/chatgpt-web/markdown.ts";
const canonical = Bun.spawnSync(["git", "-C", resolve(upstreamRoot), "show", `${pinnedRevision}:${sourcePath}`]);
assert.equal(canonical.exitCode, 0, "Cannot read pinned Markdown source");
const checkedOut = await readFile(join(upstreamRoot, sourcePath), "utf8");
assert.equal(checkedOut.replaceAll("\r\n", "\n"), canonical.stdout.toString(), "Pinned Markdown source differs beyond Git checkout line endings");
const source = canonical.stdout;

// The source copy lives under this package only for module resolution: neither the
// upstream checkout nor an installed dependency is modified. Runtime deps are the
// frozen Turndown versions used by both before and after implementations.
const fixtureDirectory = await mkdtemp(join(import.meta.dir, ".markdown-repro-"));
try {
  const beforePath = join(fixtureDirectory, "before.ts");
  await writeFile(beforePath, source);
  // The module path contains a fresh temporary directory selected at runtime;
  // a static import cannot name the isolated pinned-source copy.
  const before = await import(pathToFileURL(beforePath).href) as { ChatGptMarkdownBuffer: typeof ChatGptMarkdownBuffer };
  const evidence: Array<{ implementation: string; scenario: string; deltas: string[]; consistent: boolean[]; final?: unknown; error?: string }> = [];
  for (const [implementation, Buffer] of [["before", before.ChatGptMarkdownBuffer], ["after", ChatGptMarkdownBuffer]] as const) {
    for (const scenario of duplicateScenarios) {
      const buffer = new Buffer(markdown => markdown, 0);
      const deltas: string[] = [];
      const consistent: boolean[] = [];
      for (const [index, observation] of scenario.observations.entries()) {
        deltas.push(buffer.observe(observation, index));
        consistent.push(buffer.currentSnapshotIsConsistent());
      }
      let final: unknown;
      let error: string | undefined;
      try { final = buffer.finish(); } catch (failure) { error = failure instanceof Error ? failure.name : "UnknownError"; }
      evidence.push({ implementation, scenario: scenario.name, deltas, consistent, final, error });
      if (implementation === "after") {
        assert.deepEqual(deltas, scenario.deltas, `${scenario.name}: incorrect incremental deltas`);
        assert.deepEqual(consistent, scenario.observations.map(() => true), `${scenario.name}: inconsistent snapshot`);
        assert.deepEqual(final, scenario.final, `${scenario.name}: incorrect final Markdown`);
        assert.equal(error, undefined, `${scenario.name}: unexpected error`);
      } else {
        assert.notDeepEqual({ deltas, final }, { deltas: scenario.deltas, final: scenario.final }, `${scenario.name}: no failing-before repro`);
      }
    }
  }
  console.log(JSON.stringify({ pinnedRevision, sourceSha256: createHash("sha256").update(source).digest("hex"), evidence }, null, 2));
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
