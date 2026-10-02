import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { codexOutput, mixedBun, largePatch, ompGrep, openCodeGrep } from "../fixtures/compression-coverage.js";

if (!process.argv.includes("--child")) {
  const home = await mkdtemp(join(tmpdir(), "router-token-saver-runtime-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DATA_DIR: join(home,"data"), ENABLE_REQUEST_LOGS: "false", ENABLE_TRANSLATOR: "false" };
  for (const k of Object.keys(env)) if (/proxy/i.test(k) || k === "RTK_URL") delete env[k];
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child", ...process.argv.slice(2)], { env, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), 45000);
    const code = await child.exited; clearTimeout(timer);
    assert.equal(code, 0, "provider-bound token saver smoke failed");
  } finally { await rm(home, {recursive:true,force:true}); }
} else {
  await import("../translator/registerAll.js");
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const { getRtkSnapshot } = await import("../../open-sse/rtk/state.js");
  const { getTokenSaverSnapshot } = await import("../../open-sse/token-saver/state.js");
  const { translateRequest } = await import("../../open-sse/translator/index.js");
  const { inspectSource } = await import("../../open-sse/token-saver/sourceWalker.js");
  const binaryIndex = process.argv.indexOf("--rtk-binary");
  let sidecar;
  if (binaryIndex >= 0) {
    const binaryPath = process.argv[binaryIndex+1]; assert(isAbsolute(binaryPath), "absolute RTK binary path required");
    const { startRtkServer } = await import("../../sidecars/rtk/server.mjs");
    sidecar = await startRtkServer({hostname:"127.0.0.1",port:0,binaryPath});
    process.env.RTK_URL = `http://127.0.0.1:${sidecar.port}`;
  }
  const captured = [];
  const provider = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const body = await request.json(); captured.push(body);
    if (body.input) {
      const response = { id: "resp-synthetic", object: "response", status: "completed", model: "synthetic", output: [{ id: "msg-synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      if (!body.stream) return Response.json(response);
      const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_text.delta", item_id: "msg-synthetic", output_index: 0, content_index: 0, delta: "ok" }, { type: "response.completed", response }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (body.contents) {
      const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      return request.url.includes("gemini-stream") ? new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(chunk);
    }
    if (body.stream) return new Response(`data: ${JSON.stringify({id:"chatcmpl-synthetic",object:"chat.completion.chunk",choices:[{index:0,delta:{content:"ok"},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`, {headers:{"content-type":"text/event-stream"}});
    return Response.json({id:"chatcmpl-synthetic",object:"chat.completion",model:"synthetic",choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}]});
  }});
  const read = "synthetic exact result ".repeat(100).slice(0,2048);
  const bun = "suite.test.js:\n"+Array.from({length:40},(_,i)=>`✓ synthetic passing test ${i} [1.00ms]`).join("\n")+"\nwarning: KEEP_WARNING\n40 pass\n0 fail\nRan 40 tests across 1 file. [40ms]\n";
  const fixture = stream => {
    const messages = [];
    for(let i=0;i<6;i++) messages.push({role:"user",content:`genuine synthetic turn ${i}`},{role:"assistant",tool_calls:[{id:`r${i}`,type:"function",function:{name:"read_file",arguments:'{"path":"synthetic"}'}}]},{role:"tool",tool_call_id:`r${i}`,content:read});
    messages.push({role:"assistant",tool_calls:[{id:"bun",type:"function",function:{name:"Bash",arguments:'{"command":"bun test"}'}}]},{role:"tool",tool_call_id:"bun",content:bun});
    return {model:"synthetic",stream,messages};
  };
  const options = {modelInfo:{provider:"openai-compatible-chat-token-saver-smoke",model:"synthetic"},credentials:{apiKey:"synthetic-key",providerSpecificData:{baseUrl:`http://127.0.0.1:${provider.port}/v1`,apiType:"chat"}},rtkEnabled:true,sessionDedupMode:"on"};
  async function run(body, extra={}) {
    const original=structuredClone(body);
    const result=await handleChatCore({body,...options,...extra});
    assert.equal(result.response.status,200); const response=await result.response.text(); assert(response.includes("ok"));
    if (body.stream) assert(extra.sourceFormatOverride === "openai-responses" ? response.includes("response.completed") : extra.modelInfo?.provider === "gemini" ? /"finish_reason":"stop"/.test(response) : response.includes("[DONE]"));
    assert.deepEqual(body,original,"caller must remain unchanged");
    return captured.at(-1);
  }
  const tools = body => body.messages.filter(m=>m.role==='tool');
  try {
    for (const stream of [false, true]) {
      const scenarios = [
        ["exec_command", { cmd: "bun --cwd tests run test --config vitest.config.js" }, codexOutput(mixedBun), "mixed"],
        ["Bash", { command: "git diff" }, largePatch, "patch"],
        ["grep", { path: "src", pattern: "synthetic" }, ompGrep.repeat(20), "omp"],
        ["glob", { path: "**/*.js" }, "src/\n" + Array.from({ length: 40 }, (_, i) => `  synthetic-${i}.js\n`).join("") + "… 2 more\n", "glob"],
        ["grep", { path: "src", pattern: "synthetic" }, openCodeGrep.replace("Found 3 matches", "Found 60 matches").replace("  Line 2: other\n", "  Line 2: other\n".repeat(58)), "opencode"],
      ];
      for (const [name, input, raw, scenario] of scenarios) {
        const body = { model: "synthetic", stream, messages: [{ role: "assistant", tool_calls: [{ id: "corpus", type: "function", function: { name, arguments: JSON.stringify(input) } }] }, { role: "tool", tool_call_id: "corpus", content: raw }] };
        const before = getRtkSnapshot().usage.http.attempts;
        const started = performance.now();
        const output = tools(await run(body, { sessionDedupMode: "off" }))[0].content;
        if (scenario === "mixed") {
          assert.equal(output.slice(0, raw.indexOf("Output:\n") + 8), raw.slice(0, raw.indexOf("Output:\n") + 8));
          for (const token of ["KEEP_FAILURE", "KEEP_ERROR", "KEEP_STACK", "KEEP_WARNING", "40 pass", "1 fail", "Ran 41 tests"]) assert(output.includes(token));
          assert(Buffer.byteLength(output) < Buffer.byteLength(raw));
        } else if (scenario === "opencode") {
          assert.equal((output.match(/synthetic/g) ?? []).length, 2, 'duplicate matches retain multiplicity');
          assert.equal((output.match(/other/g) ?? []).length, 58);
          assert(output.includes("/src/example.js:"));
          assert(Buffer.byteLength(output) < Buffer.byteLength(raw));
        } else assert.equal(output, raw);
        assert.equal(getRtkSnapshot().usage.http.attempts, before);
        console.log(JSON.stringify({ scenario: `RTK corpus ${scenario}`, stream, originalBytes: Buffer.byteLength(raw), reconstructedBytes: Buffer.byteLength(output), providerBound: true, latencyMs: +(performance.now() - started).toFixed(2) }));
      }
    }
    for (const stream of [false, true]) {
      const countersBefore = getTokenSaverSnapshot().usage;
      const bodies = Array.from({ length: 6 }, (_, i) => codexOutput(read, `chunk${i}`, `0.${i}`));
      const body = { model: "synthetic", stream, messages: bodies.flatMap((text, i) => [{ role: "user", content: `synthetic exec turn ${i}` }, { role: "assistant", tool_calls: [{ id: `exec${i}`, type: "function", function: { name: "exec_command", arguments: '{"cmd":"bun test"}' } }] }, { role: "tool", tool_call_id: `exec${i}`, content: text }]) };
      const started = performance.now();
      const sent = tools(await run(body));
      for (const i of [0, 3, 4, 5]) assert.equal(sent[i].content, bodies[i]);
      const countersAfter = getTokenSaverSnapshot().usage;
      assert.equal(countersAfter.bodyExactDuplicatesFound - countersBefore.bodyExactDuplicatesFound, 2);
      assert.equal(countersAfter.rawExactDuplicatesFound - countersBefore.rawExactDuplicatesFound, 0);
      assert.equal(countersAfter.exactDuplicatesFound - countersBefore.exactDuplicatesFound, 2);
      assert.equal(countersAfter.bodyAppliedResults - countersBefore.bodyAppliedResults, 2);
      assert.deepEqual(countersAfter.cleanupShadow, countersBefore.cleanupShadow, 'on mode must not scan cleanup');
      for (const i of [1, 2]) {
        const prefix = bodies[i].slice(0, bodies[i].indexOf("Output:\n") + 8);
        assert.equal(sent[i].content.slice(0, prefix.length), prefix);
        assert.match(sent[i].content.slice(prefix.length), /^\[9router dedup:v2 this tool body is byte-identical/);
      }
      const originalBytes = bodies.reduce((n, s) => n + Buffer.byteLength(s), 0);
      const reconstructedBytes = sent.reduce((n, s) => n + Buffer.byteLength(s.content), 0);
      console.log(JSON.stringify({ scenario: "body-identical exec provider-bound", stream, appliedResults: 2, originalBytes, reconstructedBytes, bytesSaved: originalBytes - reconstructedBytes, headerPreserved: true, latencyMs: +(performance.now() - started).toFixed(2) }));
      assert.equal(countersAfter.bodyAppliedSaveBytes - countersBefore.bodyAppliedSaveBytes, originalBytes - reconstructedBytes);
      const replay = structuredClone(body); replay.messages.filter(m => m.role === "tool").forEach((m, i) => { m.content = sent[i].content; });
      assert.deepEqual(tools(await run(replay)).map(m => m.content), sent.map(m => m.content));
      const changed = structuredClone(body);
      changed.messages[5].content += "y"; changed.messages[8].content += "\n";
      assert.deepEqual(tools(await run(changed)).map(m => m.content), changed.messages.filter(m => m.role === "tool").map(m => m.content));
    }
    for (const stream of [false, true]) {
      const repeated = "synthetic log line\n".repeat(100);
      const source = { model: "synthetic", stream, input: Array.from({ length: 6 }, (_, i) => [
        { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic codec turn ${i}` }] },
        { type: "function_call", call_id: `codec${i}`, name: "exec_command", arguments: '{"cmd":"docker logs synthetic"}' },
        { type: "function_call_output", call_id: `codec${i}`, output: i === 1 ? [{ type: "input_text", text: codexOutput(repeated, "b") }] : codexOutput(i === 0 ? repeated : `distinct${i}`.repeat(200), `${i}`) },
      ]).flat() };
      const sent = await run(source, { sourceFormatOverride: "openai-responses" });
      const outputs = tools(sent);
      assert.equal(outputs[0].content, source.input[2].output);
      assert(JSON.parse(outputs[1].content)[0].text.includes("[9router dedup:v2 "));
      const replay = { ...sent, model: "synthetic", stream };
      const replaySent = await run(replay, { sourceFormatOverride: "openai" });
      assert.deepEqual(tools(replaySent).map(m => m.content), outputs.map(m => m.content));
      console.log(JSON.stringify({ scenario: "Responses single-text v2 codec replay", stream, preservedAnchor: true, replayRaw: true }));
    }
    const beforeRtk=getRtkSnapshot(), beforeDedup=getTokenSaverSnapshot();
    for (const stream of [false,true]) {
      const sent=tools(await run(fixture(stream)));
      assert.equal(sent[0].content,read);
      for(const i of [1,2]) assert.match(sent[i].content,/^\[9router dedup:v1 /);
      for(const i of [3,4,5]) assert.equal(sent[i].content,read);
      assert(Buffer.byteLength(sent[6].content)<Buffer.byteLength(bun));
      for(const token of ['KEEP_WARNING','0 fail','Ran 40 tests','[40 passing test lines omitted]']) assert(sent[6].content.includes(token));
    }
    const activeRtk=getRtkSnapshot(), activeDedup=getTokenSaverSnapshot();
    assert.equal(activeDedup.usage.appliedResults-beforeDedup.usage.appliedResults,4);
    assert.equal(activeRtk.usage.appliedOutputs-beforeRtk.usage.appliedOutputs,2);
    for (const mode of ['off','shadow','opt-out']) {
      const input=fixture(false);
      const sent=tools(await run(input,{sessionDedupMode:mode==='opt-out'?'on':mode,rtkEnabled:mode==='opt-out',...(mode==='opt-out'?{clientRawRequest:{headers:{'x-9router-token-saver':'off'}}}:{})}));
      assert.deepEqual(sent.map(m=>m.content),[...Array(6).fill(read),bun],`${mode} must not mutate results`);
    }
    const after=getTokenSaverSnapshot();
    assert.equal(after.usage.appliedResults,activeDedup.usage.appliedResults);
    assert(after.usage.wouldDedupResults>activeDedup.usage.wouldDedupResults);
    console.log(JSON.stringify({scenario:'local+dedup stream/nonstream',appliedResults:4,bytesSaved:activeDedup.usage.bytesSaved-beforeDedup.usage.bytesSaved,compressedOutputs:2,rtkBytesSaved:(activeRtk.usage.bytesBefore-activeRtk.usage.bytesAfter)-(beforeRtk.usage.bytesBefore-beforeRtk.usage.bytesAfter),off:true,shadow:true,optOut:true}));
    const ambiguousBefore=getTokenSaverSnapshot().usage.skippedPreparations.ambiguous_turn;
    const ambiguous={model:'synthetic',stream:false,messages:[{role:'user',content:'hello'},{role:'assistant',content:[{type:'tool_use',id:'mixed',name:'read_file',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'mixed',content:read},{type:'text',text:'synthetic extra instruction'}]}]};
    const ambiguousSent=await run(ambiguous,{sourceFormatOverride:'claude'});
    assert.equal(tools(ambiguousSent)[0].content,read);
    assert.equal(getTokenSaverSnapshot().usage.skippedPreparations.ambiguous_turn-ambiguousBefore,1);
    console.log(JSON.stringify({scenario:'supported ambiguous-turn',raw:true,skippedPreparations:1}));
    for (const stream of [false, true]) {
      const encrypted = fixture(stream);
      encrypted.messages = encrypted.messages.slice(0, 18);
      for (const message of encrypted.messages) if (message.role === "assistant") message.reasoning = { encrypted_content: "synthetic-encrypted" };
      const before = getTokenSaverSnapshot().usage;
      const sent = await run(encrypted);
      const outputs = tools(sent);
      assert.equal(outputs[0].content, read);
      for (const i of [1, 2]) assert.match(outputs[i].content, /^\[9router dedup:v1 /);
      for (const i of [3, 4, 5]) assert.equal(outputs[i].content, read);
      assert.deepEqual(sent.messages.filter(m => m.role === "assistant"), encrypted.messages.filter(m => m.role === "assistant"));
      const after = getTokenSaverSnapshot().usage;
      const markerBytes = Buffer.byteLength(outputs[1].content);
      assert.equal(after.appliedResults - before.appliedResults, 2);
      assert.equal(after.bytesSaved - before.bytesSaved, 2 * (2048 - markerBytes));
      console.log(JSON.stringify({ scenario: "encrypted old-history", stream, appliedResults: 2, bytesSaved: after.bytesSaved - before.bytesSaved, signedProtocolUnchanged: true }));

      const signedChain = structuredClone(encrypted);
      signedChain.messages = [signedChain.messages[0], ...signedChain.messages.filter(m => m.role !== "user")];
      const chainBefore = getTokenSaverSnapshot().usage.appliedResults;
      assert.deepEqual((await run(signedChain)).messages, signedChain.messages);
      assert.equal(getTokenSaverSnapshot().usage.appliedResults, chainBefore);

      const geminiSource = fixture(stream);
      geminiSource.messages = geminiSource.messages.slice(0, 18).flatMap(m => m.role === "tool" ? [m, { role: "assistant", content: "complete" }] : [m]);
      const baseline = translateRequest("openai", "gemini", "gemini-2.5-pro", structuredClone(geminiSource), stream);
      const geminiBefore = getTokenSaverSnapshot().usage;
      const geminiSent = await run(geminiSource, { modelInfo: { provider: "gemini", model: "gemini-2.5-pro" }, credentials: { apiKey: "synthetic-key", runtimeTransport: { baseUrl: `http://127.0.0.1:${provider.port}/gemini-${stream ? "stream" : "json"}` } } });
      const geminiResults = inspectSource(geminiSent, "gemini").results;
      const baselineResults = inspectSource(baseline, "gemini").results;
      for (const i of [0, 3, 4, 5]) assert.deepEqual(geminiResults[i].resultContainer, baselineResults[i].resultContainer);
      for (const i of [1, 2]) assert.match(geminiResults[i].resultContainer.response.result.result, /^\[9router dedup:v1 /);
      assert.deepEqual(geminiSent.contents.filter(m => m.role === "model"), baseline.contents.filter(m => m.role === "model"));
      assert.equal(getTokenSaverSnapshot().usage.appliedResults - geminiBefore.appliedResults, 2);
      console.log(JSON.stringify({ scenario: "final-only Gemini signatures", stream, appliedResults: 2, signedProtocolUnchanged: true, currentChainUnchanged: true }));
      const signedRtk = structuredClone(encrypted);
      for (const message of signedRtk.messages) {
        if (message.role === "assistant") message.tool_calls[0].function = { name: "Bash", arguments: '{"command":"bun test"}' };
        else if (message.role === "tool") message.content = bun;
      }
      const rtkBefore = getRtkSnapshot().usage;
      const rtkSent = tools(await run(signedRtk, { sessionDedupMode: "off" }));
      for (const i of [0, 1, 2]) {
        assert(Buffer.byteLength(rtkSent[i].content) < Buffer.byteLength(bun));
        assert(rtkSent[i].content.includes("KEEP_WARNING"));
      }
      for (const i of [3, 4, 5]) assert.equal(rtkSent[i].content, bun);
      const rtkAfter = getRtkSnapshot().usage;
      assert.equal(rtkAfter.appliedOutputs - rtkBefore.appliedOutputs, 3);
      assert.equal(rtkAfter.eligibility.rejected.opaque_state - rtkBefore.eligibility.rejected.opaque_state, 3);
      signedRtk.messages = [signedRtk.messages[0], ...signedRtk.messages.filter(m => m.role !== "user")];
      assert.deepEqual((await run(signedRtk, { sessionDedupMode: "off" })).messages, signedRtk.messages);
      assert.equal(getRtkSnapshot().usage.appliedOutputs, rtkAfter.appliedOutputs);
      console.log(JSON.stringify({ scenario: "signed RTK replay", stream, oldCompressedOutputs: 3, currentChainAppliedOutputs: 0, rawSignedChain: true }));
      const responses = { model: "synthetic", stream, input: Array.from({ length: 6 }, (_, i) => [
        { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic turn ${i}` }] },
        { type: "reasoning", encrypted_content: "synthetic-encrypted" },
        { type: "function_call", call_id: `response-${i}`, name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: `response-${i}`, output: read },
      ]).flat() };
      const responseBefore = getTokenSaverSnapshot().usage;
      const responseSent = await run(responses, { sourceFormatOverride: "openai-responses", modelInfo: { provider: "openai-compatible-responses-token-saver-smoke", model: "synthetic" }, credentials: { apiKey: "synthetic-key", providerSpecificData: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiType: "responses" } } });
      const responseOutputs = responseSent.input.filter(item => item.type === "function_call_output");
      assert.equal(responseOutputs[0].output, read);
      for (const i of [1, 2]) assert.match(responseOutputs[i].output, /^\[9router dedup:v1 /);
      for (const i of [3, 4, 5]) assert.equal(responseOutputs[i].output, read);
      assert.deepEqual(responseSent.input.filter(item => item.type !== "function_call_output"), responses.input.filter(item => item.type !== "function_call_output"));
      const responseAfter = getTokenSaverSnapshot().usage;
      assert.equal(responseAfter.appliedResults - responseBefore.appliedResults, 2);
      assert.equal(responseAfter.bytesSaved - responseBefore.bytesSaved, 2 * (2048 - Buffer.byteLength(responseOutputs[1].output)));
      console.log(JSON.stringify({ scenario: "encrypted Responses provider-bound", stream, appliedResults: 2, bytesSaved: responseAfter.bytesSaved - responseBefore.bytesSaved, reasoningAndOrderUnchanged: true }));
    }
    if(sidecar) {
      const diff="diff --git a/src/a.txt b/src/a.txt\nindex 1234567..89abcde 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,80 +1,80 @@\n"+Array.from({length:39},(_,i)=>` context ${i}\n`).join('')+'-OLD_VALUE\n+NEW_VALUE\n'+Array.from({length:40},(_,i)=>` context ${i+40}\n`).join('');
      const pipe = () => ({model:'synthetic',stream:false,messages:[{role:'assistant',tool_calls:[{id:'diff',type:'function',function:{name:'Bash',arguments:'{"command":"git diff"}'}}]},{role:'tool',tool_call_id:'diff',content:diff}]});
      const patchBefore = getRtkSnapshot().usage.http.attempts;
      const healthy=tools(await run(pipe(),{sessionDedupMode:'off'}))[0].content;
      assert.equal(healthy, diff, 'patch must not pass through capped Rust diff filter');
      assert.equal(getRtkSnapshot().usage.http.attempts, patchBefore);
      const jsonText = JSON.stringify({ numTotalTests:40, numPassedTests:40, numFailedTests:0, testResults:[{name:'suite.test.js',assertionResults:Array.from({length:40},(_,i)=>({fullName:`synthetic passing test ${i}`,status:'passed',failureMessages:[]}))}] });
      const jsonBody = {model:'synthetic',stream:false,messages:[{role:'assistant',tool_calls:[{id:'json',type:'function',function:{name:'Bash',arguments:'{"command":"vitest --reporter=json"}'}}]},{role:'tool',tool_call_id:'json',content:jsonText}]};
      const jsonBefore=getRtkSnapshot();
      const jsonOutput=tools(await run(jsonBody,{sessionDedupMode:'off'}))[0].content;
      assert(Buffer.byteLength(jsonOutput)<Buffer.byteLength(jsonText));
      assert.deepEqual((jsonOutput.match(/\d+/g) || []).map(Number), [40, 0], 'pass/failure counts must survive compression');
      assert.equal(getRtkSnapshot().usage.http.attempts-jsonBefore.usage.http.attempts,1);
      for(const field of ['console','coverage','unknown']) {
        const rejected=structuredClone(jsonBody);
        rejected.messages[1].content=JSON.stringify({...JSON.parse(jsonText),[field]:'KEEP_DIAGNOSTIC'});
        assert.equal(tools(await run(rejected,{sessionDedupMode:'off'}))[0].content,rejected.messages[1].content);
      }
      assert.equal(getRtkSnapshot().usage.http.attempts-jsonBefore.usage.http.attempts,1);
      console.log(JSON.stringify({scenario:'strict Vitest JSON',rawBytes:Buffer.byteLength(jsonText),compressedBytes:Buffer.byteLength(jsonOutput),diagnosticFieldsRaw:true}));
      sidecar.stop(true); sidecar=null;
      const outageBefore=getRtkSnapshot();
      assert.equal(tools(await run(jsonBody,{sessionDedupMode:'off'}))[0].content,jsonText);
      assert.equal(tools(await run(jsonBody,{sessionDedupMode:'off'}))[0].content,jsonText);
      const local=tools(await run(fixture(false),{sessionDedupMode:'off'})).at(-1).content;
      assert(local.includes('[40 passing test lines omitted]'));
      const outageAfter=getRtkSnapshot();
      assert.equal(outageAfter.usage.http.failed-outageBefore.usage.http.failed,1);
      assert.equal(outageAfter.usage.skipped.circuit_open-outageBefore.usage.skipped.circuit_open,1);
      console.log(JSON.stringify({scenario:'pinned binary healthy+outage',rawDiffBytes:Buffer.byteLength(diff),preservedDiffBytes:Buffer.byteLength(healthy),outageRaw:true,circuit:true,localAvailable:true}));
    }
  } finally { provider.stop(true); sidecar?.stop(true); }
}
