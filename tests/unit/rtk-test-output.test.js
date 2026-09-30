import { describe, it, expect } from 'vitest';
import { filterLocalOutput } from '../../open-sse/rtk/local.js';
import { classifyToolCall } from '../../open-sse/rtk/classifier.js';
const rows = Array.from({length:40},(_,i)=>`  ✓ passing synthetic test ${i+1} [2.00ms]`).join('\n');
const fixtures = {
 vitest: ` ✓ suite.js (40 tests) 20ms\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\nTest Files 1 passed (1)\nTests 40 passed (40)\nDuration 20ms\n`,
 jest: `PASS suite.js\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\nTest Suites: 1 passed, 1 total\nTests: 40 passed, 40 total\nTime: 20ms\n`,
 bun: `bun test v1.4.2\nsuite.test.js:\n${rows}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\n40 pass\n0 fail\nRan 40 tests across 1 file. [20ms]\n`,
 tap: `TAP version 13\n${Array.from({length:40},(_,i)=>`ok ${i+1} - passing synthetic test ${i+1}`).join('\n')}\nwarning: KEEP_WARNING\nconsole: KEEP_CONSOLE\n1..40\n# tests 40\n# pass 40\n# fail 0\n`,
};
describe('test runner output contracts',()=>{
 for(const [runner,fixture] of Object.entries(fixtures)) {
  it(`compresses ${runner} without losing diagnostics or raw endings`,()=>{
   for(const text of [fixture, fixture.replaceAll('\n','\r\n').replaceAll('✓','\x1b[32m✓\x1b[0m')]) {
    const out=filterLocalOutput('test',text);
    expect(out).toContain('[40 passing test lines omitted]');
    expect(out).toContain('warning: KEEP_WARNING'); expect(out).toContain('console: KEEP_CONSOLE');
    expect(out).toContain(runner==='tap'?'# fail 0':runner==='bun'?'0 fail':runner==='jest'?'Tests: 40 passed, 40 total':'Tests 40 passed (40)');
    if(text.includes('\r\n')) expect(out.replaceAll('\r\n','')).not.toContain('\n');
   }
  });
  it(`keeps ${runner} failures, redraws and repeated runs raw`,()=>{
   for(const text of [fixture+'\x1b[31mFAIL failed case\x1b[0m\n', fixture+'✗ failure\n',fixture+'Error: stack\n',fixture+fixture,fixture+'\rredraw',fixture+'\x1b]0;title\x07']) expect(filterLocalOutput('test',text)).toBeNull();
  });
 }
 it('retains incomplete and unknown reporters',()=>{
  for(const t of [rows+'\nTests 40 passed (40)\n', 'everything passed\n'+rows, fixtures.bun.replace('0 fail','1 fail'),fixtures.tap.replace('ok 4 -','not ok 4 -'),fixtures.tap.replace('# pass 40','# pass 39'), fixtures.tap.replace('ok 1 -','# Subtest: nested\nok 1 -')]) expect(filterLocalOutput('test',t)).toBeNull();
 });
 it('rejects inconsistent footer totals and bare stack traces',()=>{
  for(const text of [fixtures.vitest.replace('(40)','(41)'),fixtures.bun.replace('1 file','2 files'),fixtures.jest+'    at synthetic (suite.js:1:1)\n']) expect(filterLocalOutput('test',text)).toBeNull();
 });
 it('retains skip/todo rows and filtered counts in recognized runs',()=>{
  const tap=fixtures.tap.replace('ok 1 - passing synthetic test 1','ok 1 - synthetic skipped # SKIP').replace('# pass 40','# pass 39\n# skipped 1');
  const out=filterLocalOutput('test',tap);
  expect(out).toContain('ok 1 - synthetic skipped # SKIP');
  expect(out).toContain('[39 passing test lines omitted]');
  const bun=fixtures.bun.replace('40 pass','3 filtered out\n40 pass');
  expect(filterLocalOutput('test',bun)).toContain('3 filtered out');
 });
 it('routes only exact all-pass Vitest JSON contracts',()=>{
  const value={numTotalTests:1,numPassedTests:1,numFailedTests:0,testResults:[{name:'suite.js',assertionResults:[{fullName:'synthetic test',status:'passed',failureMessages:[]}]}]};
  const classify=v=>classifyToolCall({name:'Bash',input:{command:'vitest --reporter=json'}},JSON.stringify(v));
  expect(classify(value)).toBe('vitest');
  for(const extra of [{console:'KEEP'}, {coverage:{}}, {unknown:true}, {success:false},{numFailedTests:1},{numPendingTests:1}]) expect(classify({...value,...extra})).toBeNull();
  expect(classify({...value,testResults:[{...value.testResults[0],assertionResults:[{fullName:'test',status:'failed',failureMessages:['KEEP_DIAGNOSTIC']}]}]})).toBeNull();
  expect(classifyToolCall({name:'Bash',input:{command:'vitest'}},fixtures.vitest)).toBe('local:test');
 });
});
