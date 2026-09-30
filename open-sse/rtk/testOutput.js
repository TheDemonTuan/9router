// Parse a copy; retained diagnostics and line endings always come from raw lines.
const sgr = /\u001b\[[0-9;]*m/g;
const failure = /(?:^\s*FAIL(?:ED)?\b|\b(?:Traceback|AssertionError|unhandled rejection)\b|\b(?:Error|Exception|panic):|^\s+at .*(?:\(|:\d)|\(fail\)|[✗✖×]|\bnot ok\b|Bail out!|\b[1-9]\d*\s+(?:fail(?:ed)?|errors?)\b)/i;
function counts(value) {
  const total = /\s+\((\d+)\)$/.exec(value);
  const parts = value.replace(/\s+\(\d+\)$/, '').split(/[|,]/).map(s => s.trim());
  const result = { passed: 0, skipped: 0, todo: 0, total: null };
  const seen = new Set();
  for (const part of parts) {
    const match = /^(\d+)\s+(passed|failed|skipped|todo|total)$/.exec(part);
    if (!match || seen.has(match[2])) return null;
    seen.add(match[2]);
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n) || match[2] === 'failed' && n !== 0) return null;
    result[match[2]] = n;
  }
  if (total) {
    if (result.total !== null && result.total !== Number(total[1])) return null;
    result.total = Number(total[1]);
  }
  if (!seen.has('passed') || result.total !== null && result.passed + result.skipped + result.todo !== result.total) return null;
  return result;
}

export function summarizeTestOutput(text) {
  const parsed = text.replace(sgr, '');
  if (parsed.includes('\u001b') || /\r(?!\n)/.test(parsed)) return null;
  const raw = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines = raw.map(line => line.replace(sgr, '').replace(/\r?\n$/, ''));
  const footers = { vitestFiles: [], vitestTests: [], jestFiles: [], jestTests: [], bunPass: [], bunFail: [], bunRan: [], tapPlan: [], tapTests: [], tapPass: [], tapFail: [], tapVersion: [] };
  lines.forEach((line, i) => {
    const t = line.trim();
    for (const [key, pattern] of Object.entries({ vitestFiles: /^Test Files\s+(.+)$/, vitestTests: /^Tests\s+(.+)$/, jestFiles: /^Test Suites:\s+(.+)$/, jestTests: /^Tests:\s+(.+)$/, bunPass: /^(\d+) pass$/, bunFail: /^(\d+) fail$/, bunRan: /^Ran (\d+) tests? across (\d+) files?(?:\..*)?$/, tapPlan: /^1\.\.(\d+)$/, tapTests: /^# tests (\d+)$/, tapPass: /^# pass (\d+)$/, tapFail: /^# fail (\d+)$/, tapVersion: /^TAP version (13)$/ })) {
      const m = pattern.exec(t);
      if (m) footers[key].push({ i, m });
    }
  });
  let runner, passed;
  const safeSummaries = new Set();
  const complete = [];
  for (const [name, files, tests] of [['vitest', 'vitestFiles', 'vitestTests'], ['jest', 'jestFiles', 'jestTests']]) {
    if (footers[files].length || footers[tests].length) {
      if (footers[files].length !== 1 || footers[tests].length !== 1) return null;
      const f = counts(footers[files][0].m[1]), t = counts(footers[tests][0].m[1]);
      if (!f || !t) return null;
      complete.push([name, t.passed]);
      safeSummaries.add(footers[files][0].i); safeSummaries.add(footers[tests][0].i);
    }
  }
  if (footers.bunPass.length || footers.bunFail.length || footers.bunRan.length) {
    if (['bunPass', 'bunFail', 'bunRan'].some(k => footers[k].length !== 1) || +footers.bunFail[0].m[1] !== 0) return null;
    const p = +footers.bunPass[0].m[1], n = +footers.bunRan[0].m[1];
    const skips = lines.flatMap(line => /^\s*(\d+) (?:skip|todo)\s*$/.exec(line)?.slice(1) ?? []).reduce((a,b) => a + Number(b), 0);
    const fileCount = lines.filter(line => /^\S.*:$/.test(line)).length;
    if (![p,n,+footers.bunRan[0].m[2]].every(Number.isSafeInteger) || p + skips !== n || fileCount !== +footers.bunRan[0].m[2] || lines.filter(line => /^bun test v/.test(line)).length > 1) return null;
    complete.push(['bun', p]);
    for (const k of ['bunPass', 'bunFail', 'bunRan']) safeSummaries.add(footers[k][0].i);
  }
  if (Object.keys(footers).some(k => k.startsWith('tap') && footers[k].length)) {
    if (['tapPlan', 'tapTests', 'tapPass', 'tapFail', 'tapVersion'].some(k => footers[k].length !== 1)) return null;
    if (lines.some(line => /# Subtest|^\s+ok\b|^\s*---|Bail out!/.test(line))) return null;
    const n = +footers.tapPlan[0].m[1], p = +footers.tapPass[0].m[1];
    const s = lines.flatMap(line => /^# (?:skipped|todo) (\d+)$/.exec(line)?.slice(1) ?? []).reduce((a,b) => a + Number(b), 0);
    const rows = lines.filter(line => /^ok\s/.test(line));
    if (+footers.tapTests[0].m[1] !== n || +footers.tapFail[0].m[1] !== 0 || p + s !== n || rows.length !== n || rows.some((line,i) => !new RegExp(`^ok ${i+1}(?: - .+|\\s*)$`).test(line))) return null;
    complete.push(['tap', p]);
    safeSummaries.add(footers.tapFail[0].i);
  }
  if (complete.length !== 1) return null;
  [runner, passed] = complete[0];
  if (lines.some((line,i) => !safeSummaries.has(i) && failure.test(line))) return null;
  let section = false;
  const removable = lines.map(line => {
    if (runner === 'bun') {
      if (/^\S.*:$/.test(line)) section = true;
      return section && /^\s*(?:✓|\(pass\)) .+ \[\d+(?:\.\d+)?ms\]\s*$/.test(line);
    }
    if (runner === 'tap') return /^ok \d+ - .+/.test(line) && !/# (?:SKIP|TODO)\b/i.test(line);
    return /^\s+[✓✔√]\s+.+/.test(line) && !/\(\d+ tests?\)\s*(?:\d|$)/.test(line);
  });
  if (removable.filter(Boolean).length > passed) return null;
  const output = [];
  for (let i = 0; i < raw.length;) {
    if (!removable[i]) { output.push(raw[i++]); continue; }
    let end = i + 1;
    while (removable[end]) end++;
    const run = raw.slice(i, end).join('');
    const ending = /\r?\n$/.exec(raw[end-1])?.[0] ?? '';
    const marker = `[${end-i} passing test lines omitted]${ending}`;
    output.push(Buffer.byteLength(marker) < Buffer.byteLength(run) ? marker : run);
    i = end;
  }
  return output.join('');
}

export function isPassingVitestJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const allowed = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
  const integer = v => Number.isSafeInteger(v) && v >= 0;
  const top = ['testResults', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'success', 'startTime', 'endTime', 'status', 'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites', 'numRuntimeErrorTestSuites'];
  if (!allowed(value, top) || !Array.isArray(value.testResults) || !['numTotalTests','numPassedTests','numFailedTests'].every(k => integer(value[k])) || value.numFailedTests !== 0 || value.numPassedTests !== value.numTotalTests || value.success === false) return false;
  for (const k of ['numPendingTests','numFailedTestSuites','numPendingTestSuites','numRuntimeErrorTestSuites']) if (value[k] !== undefined && (!integer(value[k]) || value[k] !== 0)) return false;
  if (value.status !== undefined && !['passed','success'].includes(value.status)) return false;
  if (value.success !== undefined && typeof value.success !== 'boolean') return false;
  for (const k of ['numTotalTestSuites','numPassedTestSuites']) if (value[k] !== undefined && !integer(value[k])) return false;
  if (value.numTotalTestSuites !== undefined && value.numTotalTestSuites !== value.testResults.length) return false;
  if (value.numPassedTestSuites !== undefined && value.numPassedTestSuites !== value.testResults.length) return false;
  let assertions = 0;
  for (const file of value.testResults) {
    if (!allowed(file, ['name','assertionResults','startTime','endTime','status']) || typeof file.name !== 'string' || !Array.isArray(file.assertionResults) || file.status !== undefined && !['passed','success'].includes(file.status)) return false;
    for (const a of file.assertionResults) {
      if (!allowed(a, ['fullName','status','failureMessages','ancestorTitles','title','duration']) || typeof a.fullName !== 'string' || a.status !== 'passed' || !Array.isArray(a.failureMessages) || a.failureMessages.length !== 0) return false;
      if (a.ancestorTitles !== undefined && (!Array.isArray(a.ancestorTitles) || !a.ancestorTitles.every(v => typeof v === 'string'))) return false;
      if (a.title !== undefined && typeof a.title !== 'string') return false;
      if (a.duration !== undefined && (!Number.isFinite(a.duration) || a.duration < 0)) return false;
      assertions++;
    }
  }
  return assertions === value.numTotalTests;
}
