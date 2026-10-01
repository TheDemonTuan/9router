import { describe, it, expect } from 'vitest';
import { filterLocalOutput } from '../../open-sse/rtk/local.js';
import { classifyToolCall } from '../../open-sse/rtk/classifier.js';
import { summarizeTestOutput } from '../../open-sse/rtk/testOutput.js';
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
    const outcomes=[];
    const out=filterLocalOutput('test',text,(...args)=>outcomes.push(args));
    expect(outcomes).toEqual([['candidate',Buffer.byteLength(out),'none']]);
    const passingRows=runner==='tap' ? /(?:ok \d+ - passing synthetic test \d+\r?\n){40}/ : /(?:  (?:\x1b\[32m)?✓(?:\x1b\[0m)? passing synthetic test \d+ \[2\.00ms\]\r?\n){40}/;
    expect(out).toBe(text.replace(passingRows,`[40 passing test lines omitted]${text.includes('\r\n')?'\r\n':'\n'}`));
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
  const tap=fixtures.tap.replace('ok 1 - passing synthetic test 1','ok 1 - synthetic skipped # SKIP').replace('ok 2 - passing synthetic test 2','ok 2 - synthetic todo # TODO').replace('# pass 40','# pass 38\n# skipped 1\n# todo 1');
  const out=filterLocalOutput('test',tap);
  expect(out).toContain('ok 1 - synthetic skipped # SKIP');
  expect(out).toContain('ok 2 - synthetic todo # TODO');
  expect(out).toContain('[38 passing test lines omitted]');
  const bun=fixtures.bun.replace('40 pass','3 filtered out\n40 pass');
  expect(filterLocalOutput('test',bun)).toContain('3 filtered out');
  for(const runner of ['vitest','jest','bun']) {
   let fixture=fixtures[runner].replace('  ✓ passing synthetic test 1 [2.00ms]','  (skip) synthetic skipped').replace('  ✓ passing synthetic test 2 [2.00ms]','  (todo) synthetic todo');
   fixture=runner==='bun' ? fixture.replace('40 pass','38 pass\n1 skip\n1 todo') : fixture.replace('40 passed',runner==='vitest'?'38 passed | 1 skipped | 1 todo':'38 passed, 1 skipped, 1 todo');
   const output=filterLocalOutput('test',fixture);
   expect(output).toContain('(skip) synthetic skipped');
   expect(output).toContain('(todo) synthetic todo');
   expect(output).toContain('[38 passing test lines omitted]');
  }
 });
 it('reports one fixed reason for every rejected grammar without changing the input',()=>{
  const cases = [
   ['unknown_terminal_control', fixtures.bun+'\x1b[2K\rredraw\nFAIL failure\n'],
   ['unknown_terminal_control', fixtures.bun+'\rredraw'],
   ['unknown_terminal_control', fixtures.bun+'\x1b]0;title\x07'],
   ['failure_detected', fixtures.bun.replace('0 fail','1 fail')+fixtures.bun],
   ['failure_detected', fixtures.tap.replace('# fail 0','# fail 1')],
   ['multiple_runs', fixtures.vitest+fixtures.vitest],
   ['multiple_runs', fixtures.bun+fixtures.jest],
   ['unsupported_structure', fixtures.tap.replace('ok 1 -','# Subtest: nested\nok 1 -')],
   ['unsupported_structure', fixtures.tap.replace('ok 1 -','  ---\nok 1 -')],
   ['unknown_reporter', rows+'\neverything passed\n'],
   ['missing_footer', 'bun test v1.4.2\nsuite.test.js:\n'+rows+'\n'],
   ['missing_footer', ' RUN v3.2.0\n'+rows+'\n'],
   ['missing_footer', 'PASS suite.js\n'+rows+'\n'],
   ['missing_footer', 'TAP version 13\nok 1 - passing synthetic test\n'],
   ['incomplete_run', fixtures.vitest.replace('Test Files 1 passed (1)\n','')],
   ['incomplete_run', fixtures.bun.replace('0 fail\n','')],
   ['totals_mismatch', fixtures.vitest.replace('Tests 40 passed (40)','Tests 40 passed (41)')],
   ['totals_mismatch', fixtures.bun.replace('1 file','2 files')],
   ['totals_mismatch', fixtures.jest.replace('40 passed, 40 total','9007199254740992 passed, 9007199254740992 total')],
   ['totals_mismatch', fixtures.tap.replace('# pass 40','# pass 39')],
  ];
  for(const [detail,text] of cases) {
   const details=[];
   expect(summarizeTestOutput(text,value=>details.push(value))).toBeNull();
   expect(details).toEqual([detail]);
   const outcomes=[];
   expect(filterLocalOutput('test',text,(...args)=>outcomes.push(args))).toBeNull();
   expect(outcomes).toEqual([['format_not_accepted',0,detail]]);
  }
 });
 it('distinguishes valid compact summaries from rejected or removable output',()=>{
  for(const [runner,fixture] of Object.entries(fixtures)) {
   // A compact TAP run still needs every numbered result, so retain skipped rows.
   const text=runner==='tap'
    ? fixture.replace(/(ok \d+ - passing synthetic test \d+)/g,'$1 # SKIP').replace('# pass 40','# pass 0\n# skipped 40')
    : fixture.split('\n').filter(line=>!/^\s+✓ passing/.test(line)).join('\n');
   const details=[];
   expect(summarizeTestOutput(text,value=>details.push(value))).toBe(text);
   expect(details).toEqual(['no_removable_rows']);
   const outcomes=[];
   expect(filterLocalOutput('test',text,(...args)=>outcomes.push(args))).toBeNull();
   expect(outcomes).toEqual([['not_smaller',Buffer.byteLength(text),'no_removable_rows']]);
  }
  const details=[];
  const out=filterLocalOutput('test',fixtures.bun,(...args)=>details.push(args));
  expect(details).toEqual([['candidate',Buffer.byteLength(out),'none']]);
  const tiny='Test Files 1 passed (1)\nTests 1 passed (1)\n  ✓ x\n';
  const tinyDetails=[];
  expect(filterLocalOutput('test',tiny,(...args)=>tinyDetails.push(args))).toBeNull();
  expect(tinyDetails).toEqual([['not_smaller',Buffer.byteLength(tiny),'none']]);
 });
 it('keeps accepted banner variants and Bun pass spelling byte-identical',()=>{
  const bun=fixtures.bun.replaceAll('✓','(pass)');
  expect(summarizeTestOutput(bun)).toBe(fixtures.bun.replace(rows,'[40 passing test lines omitted]'));
  const vitest=' RUN v3.2.0\n RUN v3.2.0\n'+fixtures.vitest;
  const details=[];
  expect(summarizeTestOutput(vitest,value=>details.push(value))).toBe(vitest.replace(rows,'[40 passing test lines omitted]'));
  expect(details).toEqual(['none']);
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
