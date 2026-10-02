import { describe, it, expect } from 'vitest';
import { filterLocalOutput } from '../../open-sse/rtk/local.js';
import { classifyToolCall } from '../../open-sse/rtk/classifier.js';
import { summarizeTestOutput } from '../../open-sse/rtk/testOutput.js';

const rows = Array.from({ length: 40 }, (_, i) => `  ✓ passing synthetic test ${i + 1} [2.00ms]`).join('\n');
const tapRows = Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - passing synthetic test ${i + 1}`).join('\n');
const fixtures = {
  vitest: ` ✓ suite.js (40 tests) 20ms\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\nTest Files 1 passed (1)\nTests 40 passed (40)\nDuration 20ms\n`,
  jest: `PASS suite.js\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\nTest Suites: 1 passed, 1 total\nTests: 40 passed, 40 total\nTime: 20ms\n`,
  bun: `bun test v1.4.2\nsuite.test.js:\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\n40 pass\n0 fail\nRan 40 tests across 1 file. [20ms]\n`,
  tap: `TAP version 13\n${tapRows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\n1..40\n# tests 40\n# pass 40\n# fail 0\n`,
};
// Synthetic failure counterparts of the existing reporter grammars, not captured output.
// Bun spelling/version follows the Bun 1.4.2 runtime corpus.
const diagnostics = 'Error: KEEP_ERROR\n    at KEEP_STACK (suite.test.js:1:1)\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\nPASS is ordinary stdout, not a test record\n';
const mixed = {
  vitest: ` RUN v3.2.0\n ❯ suite.js (41 tests | 1 failed) 20ms\n${rows}\n  × KEEP_FAILURE 2ms\n${diagnostics}Test Files 1 failed (1)\nTests 1 failed | 40 passed (41)\nDuration 20ms\n`,
  jest: `FAIL suite.js\n${rows}\n  ✕ KEEP_FAILURE (2 ms)\n${diagnostics}Test Suites: 1 failed, 1 total\nTests: 1 failed, 40 passed, 41 total\nTime: 20ms\n`,
  bun: `bun test v1.4.2\nsuite.test.js:\n${rows}\n(fail) KEEP_FAILURE [2.00ms]\n${diagnostics}40 pass\n1 fail\nRan 41 tests across 1 file. [20ms]\n`,
  tap: `TAP version 13\n${tapRows}\nnot ok 41 - KEEP_FAILURE\n  ---\n  message: KEEP_TAP_DIAGNOSTIC\n  ...\n${diagnostics}1..41\n# tests 41\n# pass 40\n# fail 1\n`,
};
const passBlock = runner => runner === 'tap' ? tapRows : rows;
const firstRow = runner => passBlock(runner).split('\n')[0];

// Compare the entire wire string after the one permitted replacement. This
// checks retained ordering, paths, failures, diagnostics, footers and raw endings.
function expectOnlyPassBlockRemoved(text, block, count) {
  const output = filterLocalOutput('test', text);
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  expect(output).toBe(text.replace(block, `[${count} passing test lines omitted]`));
  expect(Buffer.byteLength(output)).toBeLessThan(Buffer.byteLength(text));
  if (ending === '\r\n') expect(output.replaceAll('\r\n', '')).not.toContain('\n');
}

describe('test runner output contracts', () => {
  for (const [runner, fixture] of Object.entries(fixtures)) {
    it(`compresses passing ${runner} without losing diagnostics or raw endings`, () => {
      expectOnlyPassBlockRemoved(fixture, passBlock(runner), 40);
      const text = fixture.replaceAll('\n', '\r\n').replaceAll('✓', '\x1b[32m✓\x1b[0m');
      const block = passBlock(runner).replaceAll('\n', '\r\n').replaceAll('✓', '\x1b[32m✓\x1b[0m');
      expectOnlyPassBlockRemoved(text, block, 40);
    });
    it(`keeps unaccounted ${runner} failures, redraws and repeated runs raw`, () => {
      for (const text of [fixture + '\x1b[31mFAIL failed case\x1b[0m\n', fixture + '✗ failure\n', fixture + 'Error: stack\n', fixture + fixture, fixture + '\rredraw', fixture + '\x1b]0;title\x07']) {
        expect(filterLocalOutput('test', text)).toBeNull();
      }
    });
  }

  for (const [runner, fixture] of Object.entries(mixed)) {
    it(`collapses forty ${runner} passes while retaining the entire failure run`, () => {
      expectOnlyPassBlockRemoved(fixture, passBlock(runner), 40);
      const text = fixture.replaceAll('\n', '\r\n').replaceAll('✓', '\x1b[32m✓\x1b[0m');
      const block = passBlock(runner).replaceAll('\n', '\r\n').replaceAll('✓', '\x1b[32m✓\x1b[0m');
      expectOnlyPassBlockRemoved(text, block, 40);
    });
    it(`retains ${runner} passing records with attached diagnostics`, () => {
      const block = passBlock(runner);
      const attached = runner === 'tap' ? '  ---\n  message: KEEP_PASS_DIAGNOSTIC\n  ...' : '    console: KEEP_PASS_DIAGNOSTIC\n    at KEEP_PASS_STACK (suite.test.js:2:1)';
      const text = fixture.replace(firstRow(runner), `${firstRow(runner)}\n${attached}`);
      // The unknown diagnostic can belong to either neighbouring test. Both
      // adjacent records remain; only the following 38 contiguous passes go.
      expectOnlyPassBlockRemoved(text, block.split('\n').slice(2).join('\n'), 38);
    });
    it(`retains ${runner} group names and PASS prose between pass blocks`, () => {
      const block = passBlock(runner);
      const before = block.split('\n').slice(0, 20).join('\n');
      const after = block.split('\n').slice(20).join('\n');
      const unknown = '  KEEP_GROUP_NAME\nPASS KEEP_STDOUT\nwarning: KEEP_MIDDLE_WARNING';
      const text = fixture.replace(block, `${before}\n${unknown}\n${after}`);
      const output = filterLocalOutput('test', text);
      const expected = text.replace(before.split('\n').slice(0, -1).join('\n'), '[19 passing test lines omitted]')
        .replace(after.split('\n').slice(1).join('\n'), '[19 passing test lines omitted]');
      expect(output).toBe(expected);
    });
    it(`does not trust ambiguous ${runner} footer or record counts`, () => {
      const badTotals = runner === 'bun' ? fixture.replace('Ran 41 tests', 'Ran 42 tests')
        : runner === 'tap' ? fixture.replace('# pass 40', '# pass 39')
        : runner === 'jest' ? fixture.replace('41 total', '42 total') : fixture.replace('(41)', '(42)');
      const noFooter = runner === 'bun' ? fixture.replace('1 fail\n', '')
        : runner === 'tap' ? fixture.replace('# fail 1\n', '')
        : runner === 'jest' ? fixture.replace('Test Suites: 1 failed, 1 total\n', '') : fixture.replace('Test Files 1 failed (1)\n', '');
      const duplicateFooter = runner === 'bun' ? fixture + '40 pass\n'
        : runner === 'tap' ? fixture + '# tests 41\n'
        : runner === 'jest' ? fixture + 'Tests: 1 failed, 40 passed, 41 total\n' : fixture + 'Tests 1 failed | 40 passed (41)\n';
      for (const text of [badTotals, noFooter, duplicateFooter, fixture.replace(firstRow(runner) + '\n', ''), fixture + firstRow(runner) + '\n', fixture + fixture]) {
        expect(filterLocalOutput('test', text)).toBeNull();
      }
    });
  }

  it('accepts native Bun and verbose Jest pass spellings in failure runs', () => {
    const bun = mixed.bun.replaceAll('✓', '(pass)');
    expectOnlyPassBlockRemoved(bun, rows.replaceAll('✓', '(pass)'), 40);
    const jest = mixed.jest.replaceAll('[2.00ms]', '(2 ms)');
    expectOnlyPassBlockRemoved(jest, rows.replaceAll('[2.00ms]', '(2 ms)'), 40);
  });
  it('rejects unnumbered, duplicate and nested TAP failure records', () => {
    for (const text of [mixed.tap.replace('not ok 41', 'not ok 40'), mixed.tap.replace('not ok 41', 'not ok'), mixed.tap.replace('ok 1 -', '# Subtest: KEEP_NESTED\nok 1 -')]) {
      expect(filterLocalOutput('test', text)).toBeNull();
    }
  });
  it('retains incomplete and unknown reporters', () => {
    for (const text of [rows + '\nTests 40 passed (40)\n', 'everything passed\n' + rows, fixtures.bun.replace('0 fail', '1 fail'), fixtures.tap.replace('ok 4 -', 'not ok 4 -'), fixtures.tap.replace('# pass 40', '# pass 39'), fixtures.tap.replace('ok 1 -', '# Subtest: nested\nok 1 -')]) {
      expect(filterLocalOutput('test', text)).toBeNull();
    }
  });
  it('rejects inconsistent footer totals and bare stack traces', () => {
    for (const text of [fixtures.vitest.replace('(40)', '(41)'), fixtures.bun.replace('1 file', '2 files'), fixtures.jest + '    at synthetic (suite.js:1:1)\n']) {
      expect(filterLocalOutput('test', text)).toBeNull();
    }
  });
  it('retains skip/todo rows and filtered counts in passing runs', () => {
    const tap = fixtures.tap.replace('ok 1 - passing synthetic test 1', 'ok 1 - synthetic skipped # SKIP').replace('ok 2 - passing synthetic test 2', 'ok 2 - synthetic todo # TODO').replace('# pass 40', '# pass 38\n# skipped 1\n# todo 1');
    expectOnlyPassBlockRemoved(tap, tapRows.split('\n').slice(2).join('\n'), 38);
    const bun = fixtures.bun.replace('40 pass', '3 filtered out\n40 pass');
    expectOnlyPassBlockRemoved(bun, rows, 40);
    for (const runner of ['vitest', 'jest', 'bun']) {
      let fixture = fixtures[runner].replace('  ✓ passing synthetic test 1 [2.00ms]', '  (skip) synthetic skipped').replace('  ✓ passing synthetic test 2 [2.00ms]', '  (todo) synthetic todo');
      fixture = runner === 'bun' ? fixture.replace('40 pass', '38 pass\n1 skip\n1 todo') : fixture.replace('40 passed', runner === 'vitest' ? '38 passed | 1 skipped | 1 todo' : '38 passed, 1 skipped, 1 todo');
      expectOnlyPassBlockRemoved(fixture, rows.split('\n').slice(2).join('\n'), 38);
    }
  });
  it('preserves already compact summaries and non-saving pass records', () => {
    for (const [runner, fixture] of Object.entries(fixtures)) {
      const text = runner === 'tap'
        ? fixture.replace(/(ok \d+ - passing synthetic test \d+)/g, '$1 # SKIP').replace('# pass 40', '# pass 0\n# skipped 40')
        : fixture.replace(rows + '\n', '');
      expect(summarizeTestOutput(text)).toBe(text);
      expect(filterLocalOutput('test', text)).toBeNull();
    }
    const tiny = 'Test Files 1 passed (1)\nTests 1 passed (1)\n  ✓ x\n';
    expect(summarizeTestOutput(tiny)).toBe(tiny);
    expect(filterLocalOutput('test', tiny)).toBeNull();
  });
  it('routes only exact all-pass Vitest JSON contracts', () => {
    const value = { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: 'suite.js', assertionResults: [{ fullName: 'synthetic test', status: 'passed', failureMessages: [] }] }] };
    const classify = v => classifyToolCall({ name: 'Bash', input: { command: 'vitest --reporter=json' } }, JSON.stringify(v));
    expect(classify(value)).toBe('vitest');
    for (const extra of [{ console: 'KEEP' }, { coverage: {} }, { unknown: true }, { success: false }, { numFailedTests: 1 }, { numPendingTests: 1 }]) expect(classify({ ...value, ...extra })).toBeNull();
    expect(classify({ ...value, testResults: [{ ...value.testResults[0], assertionResults: [{ fullName: 'test', status: 'failed', failureMessages: ['KEEP_DIAGNOSTIC'] }] }] })).toBeNull();
    expect(classifyToolCall({ name: 'Bash', input: { command: 'vitest' } }, fixtures.vitest)).toBe('local:test');
  });
});
