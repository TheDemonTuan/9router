// Parse a copy; retained diagnostics and line endings always come from raw lines.
const sgr = /\u001b\[[0-9;]*m/g;
const failure = /(?:^\s*FAIL(?:ED)?\b|\b(?:Traceback|AssertionError|unhandled rejection)\b|\b(?:Error|Exception|panic):|^\s+at .*(?:\(|:\d)|\(fail\)|[✗✖×]|\bnot ok\b|Bail out!|\b[1-9]\d*\s+(?:fail(?:ed)?|errors?)\b)/i;
function counts(value) {
  const total = /\s+\((\d+)\)$/.exec(value);
  const parts = value.replace(/\s+\(\d+\)$/, '').split(/[|,]/).map(s => s.trim());
  const result = { passed: 0, failed: 0, skipped: 0, todo: 0, total: null };
  const seen = new Set();
  for (const part of parts) {
    const match = /^(\d+)\s+(passed|failed|skipped|todo|total)$/.exec(part);
    if (!match || seen.has(match[2])) return null;
    seen.add(match[2]);
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n)) return null;
    result[match[2]] = n;
  }
  if (total) {
    if (result.total !== null && result.total !== Number(total[1])) return null;
    result.total = Number(total[1]);
  }
  if (!seen.has('passed') && result.failed === 0 || result.total !== null && (!Number.isSafeInteger(result.total) || result.passed + result.failed + result.skipped + result.todo !== result.total)) return null;
  return result;
}

// Failure runs require a complete record census, not just a plausible footer.
// A neighbouring unknown row may be a diagnostic attached to a passing test;
// retain that record too, even when the unknown row looks like harmless stdout.
function mixedPassRows(runner, lines, footers, totals, files) {
  const records = [];
  const boundaries = new Set();
  const suiteCounts = { passed: 0, failed: 0 };
  let declaredTests = 0;
  let section = runner === 'tap';
  let skipped = 0, todo = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (runner === 'tap' && /^TAP version 13$/.test(line)) boundaries.add(i);
    const heading = runner === 'bun' ? /^\S.*\.(?:[cm]?[jt]sx?):$/.exec(line)
      : runner === 'jest' ? /^(PASS|FAIL)\s+.+\.[cm]?[jt]sx?(?:\s+\(.+\))?\s*$/.exec(line)
      : runner === 'vitest' ? /^\s*[✓✔√❯✗✖×]\s+.+\((\d+) tests?(?:\s*\|[^)]*)?\)\s+\d+(?:\.\d+)?m?s\s*$/.exec(line) : null;
    if (heading) {
      section = true;
      boundaries.add(i);
      if (runner === 'jest') suiteCounts[heading[1] === 'PASS' ? 'passed' : 'failed']++;
      if (runner === 'vitest') {
        suiteCounts[/\b[1-9]\d* failed\b/.test(line) ? 'failed' : 'passed']++;
        declaredTests += +heading[1];
      }
      continue;
    }
    let match;
    if (runner === 'tap') {
      match = /^(ok|not ok) (\d+)(?: - .+)?\s*$/.exec(line);
      if (!match) continue;
      if (+match[2] !== records.length + 1) return null;
      const directive = /# (SKIP|TODO)\b/i.exec(line)?.[1].toLowerCase();
      if (directive === 'skip') skipped++;
      if (directive === 'todo') todo++;
      records.push({ i, status: directive ?? (match[1] === 'ok' ? 'passed' : 'failed') });
    } else if (section) {
      const timing = runner === 'jest' ? /(?:\[\d+(?:\.\d+)?ms\]|\(\d+(?:\.\d+)?\s*m?s\))\s*$/
        : /(?:\[\d+(?:\.\d+)?ms\]|\d+(?:\.\d+)?m?s)\s*$/;
      const pass = /^\s*(?:[✓✔√]|\(pass\))\s+.+/.test(line) && timing.test(line);
      const fail = /^\s*(?:[✗✖×✕]|\(fail\))\s+.+/.test(line);
      const skip = /^\s*(?:\(skip\)|[↓○])\s+.+/.test(line);
      const pending = /^\s*\(todo\)\s+.+/.test(line);
      if (pass || fail || skip || pending) {
        if (skip) skipped++;
        if (pending) todo++;
        records.push({ i, status: fail ? 'failed' : skip ? 'skip' : pending ? 'todo' : 'passed' });
      }
    }
  }
  const passed = records.filter(row => row.status === 'passed').length;
  const failed = records.filter(row => row.status === 'failed').length;
  if (passed !== totals.passed || failed !== totals.failed || skipped !== totals.skipped || todo !== totals.todo
    || totals.total === null || records.length !== totals.total) return null;
  if (files && (suiteCounts.passed !== files.passed || suiteCounts.failed !== files.failed
    || files.total === null || suiteCounts.passed + suiteCounts.failed !== files.total)) return null;
  if (runner === 'vitest' && declaredTests !== totals.total) return null;
  const keys = runner === 'bun' ? ['bunPass', 'bunFail', 'bunRan']
    : runner === 'tap' ? ['tapPlan', 'tapTests', 'tapPass', 'tapFail']
    : runner === 'jest' ? ['jestFiles', 'jestTests'] : ['vitestFiles', 'vitestTests'];
  const last = records.at(-1)?.i ?? -1;
  let previous = last;
  for (const key of keys) {
    const i = footers[key][0].i;
    if (i <= previous) return null;
    previous = i;
    boundaries.add(i);
  }
  for (const { i } of records) boundaries.add(i);
  const removable = lines.map(() => false);
  for (const { i, status } of records) {
    if (status !== 'passed' || failure.test(lines[i])) continue;
    const unknownNeighbour = offset => {
      let j = i + offset;
      while (j >= 0 && j < lines.length && !lines[j].trim()) j += offset;
      return j >= 0 && j < lines.length && !boundaries.has(j);
    };
    if (!unknownNeighbour(-1) && !unknownNeighbour(1)) removable[i] = true;
  }
  return removable;
}

export function summarizeTestOutput(text, onDetail) {
  const finish = (output, detail) => { onDetail?.(detail); return output; };
  const parsed = text.replace(sgr, '');
  if (parsed.includes('\u001b') || /\r(?!\n)/.test(parsed)) return finish(null, 'unknown_terminal_control');
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
  const families = [
    ['vitestFiles', 'vitestTests'], ['jestFiles', 'jestTests'],
    ['bunPass', 'bunFail', 'bunRan'], ['tapPlan', 'tapTests', 'tapPass', 'tapFail', 'tapVersion'],
  ];
  const hasFailure = lines.some(line => failure.test(line))
    || ['bunFail', 'tapFail'].some(key => footers[key].some(({ m }) => Number(m[1]) > 0));
  const bunBanners = lines.filter(line => /^bun test v/.test(line)).length;
  const vitestBanners = lines.filter(line => /^\s*(?:RUN|DEV)\s+v/.test(line)).length;
  const hints = [vitestBanners > 0, lines.some(line => /^PASS\s+.+\.[cm]?[jt]sx?(?:\s+\(.+\))?\s*$/.test(line)), bunBanners > 0, footers.tapVersion.length > 0];
  const multipleRuns = Object.values(footers).some(rows => rows.length > 1)
    || families.filter((keys, i) => hints[i] || keys.some(key => footers[key].length)).length > 1
    || bunBanners > 1 || vitestBanners > 1;
  const nestedTap = families[3].some(key => footers[key].length)
    && lines.some(line => /# Subtest|^\s+ok\b|Bail out!/.test(line)
      || /^\s*---/.test(line) && !footers.tapFail.some(({ m }) => Number(m[1]) > 0));
  // Classify only existing rejects: hints must not introduce a new acceptance gate.
  const reject = detail => finish(null, hasFailure ? 'failure_detected'
    : multipleRuns ? 'multiple_runs' : nestedTap ? 'unsupported_structure' : detail);
  const hasHint = hints.some(Boolean);
  const hasFooter = Object.entries(footers).some(([key, rows]) => key !== 'tapVersion' && rows.length);
  let runner, passed;
  const safeSummaries = new Set();
  const complete = [];
  for (const [name, files, tests] of [['vitest', 'vitestFiles', 'vitestTests'], ['jest', 'jestFiles', 'jestTests']]) {
    if (footers[files].length || footers[tests].length) {
      if (footers[files].length !== 1 || footers[tests].length !== 1) return reject('incomplete_run');
      const f = counts(footers[files][0].m[1]), t = counts(footers[tests][0].m[1]);
      if (!f || !t) return reject('totals_mismatch');
      complete.push([name, t.passed, t, f]);
      safeSummaries.add(footers[files][0].i); safeSummaries.add(footers[tests][0].i);
    }
  }
  if (footers.bunPass.length || footers.bunFail.length || footers.bunRan.length) {
    if (['bunPass', 'bunFail', 'bunRan'].some(k => footers[k].length !== 1)) return reject('incomplete_run');
    const p = +footers.bunPass[0].m[1], f = +footers.bunFail[0].m[1], n = +footers.bunRan[0].m[1];
    const skipCounts = { skip: [], todo: [] };
    for (const line of lines) {
      const match = /^\s*(\d+) (skip|todo)\s*$/.exec(line);
      if (match) skipCounts[match[2]].push(+match[1]);
    }
    if (Object.values(skipCounts).some(rows => rows.length > 1)) return reject('totals_mismatch');
    const skipped = skipCounts.skip[0] ?? 0, todo = skipCounts.todo[0] ?? 0;
    const fileCount = lines.filter(line => /^\S.*:$/.test(line)).length;
    if (![p,f,n,skipped,todo,+footers.bunRan[0].m[2]].every(Number.isSafeInteger) || p + f + skipped + todo !== n || fileCount !== +footers.bunRan[0].m[2] || bunBanners > 1) return reject('totals_mismatch');
    complete.push(['bun', p, { passed: p, failed: f, skipped, todo, total: n }]);
    for (const k of ['bunPass', 'bunFail', 'bunRan']) safeSummaries.add(footers[k][0].i);
  }
  if (Object.keys(footers).some(k => k.startsWith('tap') && footers[k].length)) {
    if (['tapPlan', 'tapTests', 'tapPass', 'tapFail', 'tapVersion'].some(k => footers[k].length !== 1)) return reject(hasFooter ? 'incomplete_run' : 'missing_footer');
    if (nestedTap) return reject('unsupported_structure');
    const n = +footers.tapPlan[0].m[1], p = +footers.tapPass[0].m[1], f = +footers.tapFail[0].m[1];
    const extra = { skipped: [], todo: [] };
    for (const line of lines) {
      const match = /^# (skipped|todo) (\d+)$/.exec(line);
      if (match) extra[match[1]].push(+match[2]);
    }
    if (Object.values(extra).some(rows => rows.length > 1)) return reject('totals_mismatch');
    const skipped = extra.skipped[0] ?? 0, todo = extra.todo[0] ?? 0;
    const rows = lines.filter(line => /^(?:not )?ok\s/.test(line));
    if (![n,p,f,skipped,todo,+footers.tapTests[0].m[1]].every(Number.isSafeInteger) || +footers.tapTests[0].m[1] !== n || p + f + skipped + todo !== n || rows.length !== n || rows.some((line,i) => !new RegExp(`^(?:not )?ok ${i+1}(?: - .+|\\s*)$`).test(line))) return reject('totals_mismatch');
    complete.push(['tap', p, { passed: p, failed: f, skipped, todo, total: n }]);
    safeSummaries.add(footers.tapFail[0].i);
  }
  if (complete.length !== 1) return reject(hasFooter ? 'incomplete_run' : hasHint ? 'missing_footer' : 'unknown_reporter');
  [runner, passed] = complete[0];
  const totals = complete[0][2];
  const mixed = totals.failed > 0;
  if (mixed && (multipleRuns || nestedTap)) return reject('unsupported_structure');
  if (!mixed && complete[0][3]?.failed > 0) return reject('totals_mismatch');
  if (!mixed && lines.some((line,i) => !safeSummaries.has(i) && failure.test(line))) return reject('failure_detected');
  let section = false;
  const removable = mixed ? mixedPassRows(runner, lines, footers, totals, complete[0][3]) : lines.map(line => {
    if (runner === 'bun') {
      if (/^\S.*:$/.test(line)) section = true;
      return section && /^\s*(?:✓|\(pass\)) .+ \[\d+(?:\.\d+)?ms\]\s*$/.test(line);
    }
    if (runner === 'tap') return /^ok \d+ - .+/.test(line) && !/# (?:SKIP|TODO)\b/i.test(line);
    return /^\s+[✓✔√]\s+.+/.test(line) && !/\(\d+ tests?\)\s*(?:\d|$)/.test(line);
  });
  if (!removable) return reject('totals_mismatch');
  const removableCount = removable.filter(Boolean).length;
  if (removableCount > passed) return reject('totals_mismatch');
  if (removableCount === 0) return finish(text, 'no_removable_rows');
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
  return finish(output.join(''), 'none');
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
