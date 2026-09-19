// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const relativeTestName = (name) => {
  const normalized = String(name || "").replace(/\\/g, "/");
  const marker = "/tests/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? `tests/${normalized.slice(index + marker.length)}` : normalized;
};

const nowFails = r.testResults.flatMap(f => {
  const assertions = f.assertionResults || [];
  const assertionFails = assertions
    .filter(a => a.status === "failed")
    .map(a => `${relativeTestName(f.name)} :: ${a.fullName}`);
  // Vitest reports collection/import failures as a failed suite with no assertions.
  return assertionFails.length || f.status !== "failed"
    ? assertionFails
    : [`${relativeTestName(f.name)} :: ${f.message || "test suite failed"}`];
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
