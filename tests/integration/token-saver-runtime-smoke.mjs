import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

if (!process.argv.includes("--child")) {
  const home = await mkdtemp(join(tmpdir(), "router-token-saver-runtime-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, DATA_DIR: join(home,"data"), ENABLE_REQUEST_LOGS: "false", ENABLE_TRANSLATOR: "false" };
  for (const k of Object.keys(env)) if (/proxy/i.test(k) || k === "RTK_URL" || k === "RUN_REAL") delete env[k];
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
  const capturedHeaders = [];
  let enrichTerminal = false;
  const provider = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const body = await request.json(); captured.push(body); capturedHeaders.push(Object.fromEntries(request.headers));
    if (body.input) {
      const response = { id: "resp-synthetic", object: "response", status: "completed", model: "synthetic", output: [{ id: "msg-synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      if (!body.stream) return Response.json(response);
      const tool = { type: "function_call", id: "fc-synthetic", call_id: "synthetic-output-call", name: "synthetic_tool", arguments: "{}", status: "completed" };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.synthetic_unknown", synthetic: "keep-unknown-event" },
        { type: "response.output_text.delta", item_id: "msg-synthetic", output_index: 0, content_index: 0, delta: "ok" },
        ...(enrichTerminal ? [{ type: "response.output_item.done", output_index: 0, item: response.output[0] }, { type: "response.output_item.done", output_index: 1, item: tool }] : []),
        { type: "response.completed", response: enrichTerminal ? { ...response, output: [] } : response },
      ];
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
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const { CAVEMAN_PROMPTS } = await import("../../open-sse/rtk/cavemanPrompts.js");
    const { PONYTAIL_PROMPTS } = await import("../../open-sse/rtk/ponytailPrompt.js");
    const codex = getExecutor("codex");
    const originalConfig = codex.config;
    const loopbackUrl = `http://127.0.0.1:${provider.port}/v1/responses`;
    codex.config = { ...originalConfig, baseUrl: loopbackUrl, baseUrls: [loopbackUrl] };
    const labels = new Set();
    const responsesFixture = stream => ({
      model: "gpt-5.5", stream, reasoning: { effort: "high", summary: "detailed", mode: "pro", context: "current_turn" },
      input: Array.from({ length: 6 }, (_, i) => [
        { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic turn ${i}` }] },
        { type: "reasoning", encrypted_content: `synthetic-opaque-${i}+/==`, summary: [] },
        { type: "function_call", call_id: `codex-${i}`, name: "read_file", arguments: '{"path":"synthetic"}' },
        { type: "function_call_output", call_id: `codex-${i}`, output: read },
      ]).flat(),
    });
    const outputs = body => body.input.filter(item => item.type === "function_call_output").map(item => item.output);
    async function runCodex(body, extra = {}, expectedLabel = "SAME-WIRE") {
      assert.equal(codex.config.baseUrl, loopbackUrl);
      assert.deepEqual(codex.config.baseUrls, [loopbackUrl]);
      const original = structuredClone(body), start = captured.length;
      const debug = [], lines = [];
      const result = await handleChatCore({
        body, modelInfo: { provider: "codex", model: body.model },
        credentials: { accessToken: "synthetic-token", connectionId: "synthetic-connection", providerSpecificData: {} },
        connectionId: "synthetic-connection", sourceFormatOverride: "openai-responses",
        rtkEnabled: false, sessionDedupMode: "off", cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
        clientRawRequest: { body, endpoint: "/v1/responses", headers: { "user-agent": "omp-test" } },
        ...extra,
        log: { debug(tag, message) { if (tag === "FORMAT") debug.push(message); }, line(...args) { lines.push(args.at(-1)); }, warn() {}, info() {} },
      });
      const text = await result.response.text();
      assert.equal(result.response.status, 200, text);
      assert.equal(captured.length - start, 1);
      assert.deepEqual(body, original, "Codex canonicalizer must not mutate caller");
      const fmt = debug[0].split(" | stream=")[0];
      assert(fmt.endsWith(` · ${expectedLabel}`), fmt);
      assert(lines.some(line => line.includes(fmt)), "summary and debug format must agree");
      labels.add(expectedLabel);
      if (body.stream) assert(text.includes("response.completed") || expectedLabel === "TRANSLATE" && text.includes("[DONE]"));
      else {
        const json = JSON.parse(text);
        if (expectedLabel === "TRANSLATE") assert.equal(json.choices[0].message.content, "ok");
        else {
          assert.equal(json.object, "response"); assert(!("choices" in json));
          assert.equal(json.output[0].content[0].text, "ok");
          // The generic provider control exercises logging, not Codex's forced-SSE usage contract.
          if (expectedLabel !== "NORMALIZE") assert.deepEqual(json.usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
        }
      }
      return { sent: captured.at(-1), headers: capturedHeaders.at(-1), text };
    }
    try {
      for (const stream of [false, true]) {
        const body = responsesFixture(stream);
        Object.assign(body, { text: { format: { type: "json_schema", name: "synthetic", schema: { type: "object", properties: {}, additionalProperties: false }, strict: true } }, include: ["message.output_text.logprobs"], client_metadata: { synthetic: "keep" }, prompt_cache_key: "synthetic-explicit", tools: [{ type: "custom", name: "synthetic_custom", format: { type: "text" } }, { type: "namespace", name: "synthetic_namespace", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }] }] });
        const { sent } = await runCodex(body);
        for (const key of ["input", "reasoning", "text", "tools", "client_metadata", "prompt_cache_key"]) assert.deepEqual(sent[key], body[key]);
        assert.deepEqual(sent.include, [...body.include, "reasoning.encrypted_content"]);
        assert.equal(sent.stream, true); assert.equal(sent.store, false);
        const lite = await runCodex({ ...body, model: "gpt-6-luna", instructions: "base" });
        assert.equal(lite.sent.reasoning.context, "all_turns");
        assert.equal(lite.sent.reasoning.summary, "detailed");
        assert.deepEqual(lite.sent.input[0], { type: "additional_tools", role: "developer", tools: body.tools });
        assert.equal(lite.sent.tools, null); assert.equal(lite.sent.instructions, ""); assert.equal(lite.sent.parallel_tool_calls, false);
        assert.deepEqual(lite.sent.input.slice(2), body.input);

        const active = responsesFixture(stream), before = getTokenSaverSnapshot().usage;
        const dedup = (await runCodex(active, { sessionDedupMode: "on" })).sent;
        const saved = outputs(dedup);
        assert.equal(saved[0], read);
        for (const i of [1, 2]) assert.match(saved[i], /^\[9router dedup:v1 /);
        for (const i of [3, 4, 5]) assert.equal(saved[i], read);
        assert.deepEqual(dedup.input.filter(item => item.type !== "function_call_output"), active.input.filter(item => item.type !== "function_call_output"));
        assert.equal(getTokenSaverSnapshot().usage.appliedResults - before.appliedResults, 2);
        assert.equal(getTokenSaverSnapshot().usage.bytesSaved - before.bytesSaved, 2 * (Buffer.byteLength(read) - Buffer.byteLength(saved[1])));
        for (const mode of ["off", "shadow", "opt-out", "native"]) {
          const baseline = getTokenSaverSnapshot().usage.appliedResults;
          const headers = { "user-agent": mode === "native" ? "codex-cli/0.144.1" : "omp-test", ...(mode === "opt-out" ? { "x-9router-token-saver": "off" } : {}) };
          const raw = await runCodex(responsesFixture(stream), { sessionDedupMode: mode === "off" || mode === "shadow" ? mode : "on", rtkEnabled: true, clientRawRequest: { headers } }, mode === "native" ? "NATIVE" : "SAME-WIRE");
          assert.deepEqual(outputs(raw.sent), Array(6).fill(read));
          assert.equal(getTokenSaverSnapshot().usage.appliedResults, baseline);
          if (mode === "native" && stream) assert(raw.text.includes("keep-unknown-event"));
        }
        const marked = structuredClone(dedup); marked.stream = stream;
        const markerBefore = getTokenSaverSnapshot().usage.appliedResults;
        assert.deepEqual(outputs((await runCodex(marked, { sessionDedupMode: "on", rtkEnabled: true })).sent), saved);
        assert.equal(getTokenSaverSnapshot().usage.appliedResults, markerBefore);

        const rtk = responsesFixture(stream);
        for (const item of rtk.input) {
          if (item.type === "function_call") { item.name = "Bash"; item.arguments = '{"command":"bun test"}'; }
          if (item.type === "function_call_output") item.output = bun;
        }
        const rtkBefore = getRtkSnapshot().usage.appliedOutputs;
        const compressed = outputs((await runCodex(rtk, { rtkEnabled: true })).sent);
        for (const i of [0, 1, 2]) {
          assert(Buffer.byteLength(compressed[i]) < Buffer.byteLength(bun));
          for (const token of ["KEEP_WARNING", "0 fail", "Ran 40 tests", "[40 passing test lines omitted]"]) assert(compressed[i].includes(token));
        }
        for (const i of [3, 4, 5]) assert.equal(compressed[i], bun);
        assert.equal(getRtkSnapshot().usage.appliedOutputs - rtkBefore, 3);
        for (const kind of ["structured", "signed-chain", "unscopable", "breakpoint"]) {
          const guarded = responsesFixture(stream);
          if (kind === "structured") guarded.text = body.text;
          if (kind === "signed-chain") guarded.input = [guarded.input[0], ...guarded.input.filter(item => item.role !== "user")];
          if (kind === "unscopable") guarded.input[3].encrypted_content = "synthetic";
          if (kind === "breakpoint") guarded.input[20].prompt_cache_breakpoint = { mode: "explicit" };
          const guardedBefore = getTokenSaverSnapshot().usage.appliedResults;
          const guardedRtkBefore = getRtkSnapshot().usage.appliedOutputs;
          assert.deepEqual(outputs((await runCodex(guarded, { sessionDedupMode: "on", rtkEnabled: true })).sent), Array(6).fill(read));
          assert.equal(getTokenSaverSnapshot().usage.appliedResults, guardedBefore);
          assert.equal(getRtkSnapshot().usage.appliedOutputs, guardedRtkBefore);
        }
        console.log(JSON.stringify({ scenario: "Codex same-wire HTTP", stream, dedupApplied: 2, rtkApplied: 3, lite: true, fences: true, callerUnchanged: true }));
      }
      enrichTerminal = true;
      const enriched = await runCodex({ model: "gpt-5.5", stream: true, input: "hello" });
      const terminal = enriched.text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
      assert.equal(terminal.response.output[0].content[0].text, "ok");
      assert.equal(terminal.response.output[1].call_id, "synthetic-output-call");
      enrichTerminal = false;
      for (let i = 0; i < 2; i++) {
        const session = await runCodex({ model: "gpt-5.5", stream: false, input: "hello" }, { clientRawRequest: { headers: { "user-agent": "omp-test", "x-client-request-id": "synthetic-session" } } });
        assert.equal(session.sent.prompt_cache_key, "synthetic-session"); assert.equal(session.headers.session_id, "synthetic-session");
      }
      const explicit = await runCodex({ model: "gpt-5.5", stream: false, input: "hello", prompt_cache_key: "synthetic-explicit" });
      assert.equal(explicit.sent.prompt_cache_key, "synthetic-explicit"); assert.equal(explicit.headers.session_id, "synthetic-explicit");
      for (const mode of ["on", "native", "opt-out"]) {
        const promptBody = { model: "gpt-5.5", stream: false, instructions: "base", input: [{ role: "user", content: "hello" }] };
        const prompted = await runCodex(promptBody, { cavemanEnabled: true, cavemanLevel: "full", ponytailEnabled: true, ponytailLevel: "full", clientRawRequest: { headers: { "user-agent": mode === "native" ? "codex-cli/0.144.1" : "omp-test", ...(mode === "opt-out" ? { "x-9router-token-saver": "off" } : {}) } } }, mode === "native" ? "NATIVE" : "SAME-WIRE");
        assert.equal(prompted.sent.instructions, mode === "on" ? ["base", CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full].join("\n\n") : "base");
      }
      await runCodex({ model: "gpt-5.5", stream: false, messages: [{ role: "user", content: "hello" }] }, { sourceFormatOverride: "openai" }, "TRANSLATE");
      await runCodex({ model: "synthetic", stream: false, input: "hello" }, { modelInfo: { provider: "openai-compatible-responses-codex-log-smoke", model: "synthetic" }, credentials: { apiKey: "synthetic", providerSpecificData: { baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiType: "responses" } } }, "NORMALIZE");
      assert.deepEqual([...labels].sort(), ["NATIVE", "NORMALIZE", "SAME-WIRE", "TRANSLATE"]);
      const controller = new AbortController(), reason = new Error("synthetic-client-abort"); controller.abort(reason);
      const abortBefore = captured.length;
      await assert.rejects(() => handleChatCore({ body: responsesFixture(false), modelInfo: { provider: "codex", model: "gpt-5.5" }, credentials: { accessToken: "synthetic" }, sourceFormatOverride: "openai-responses", clientSignal: controller.signal }), error => error === reason);
      assert.equal(captured.length, abortBefore);
      console.log(JSON.stringify({ scenario: "Codex response compatibility and logs", terminalEnriched: true, nativeUnknownPreserved: true, sessionHeaders: true, promptSavers: true, abortReasonPreserved: true, labels: [...labels].sort() }));
    } finally { codex.config = originalConfig; enrichTerminal = false; }
    if(sidecar) {
      const diff="diff --git a/src/a.txt b/src/a.txt\nindex 1234567..89abcde 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,80 +1,80 @@\n"+Array.from({length:39},(_,i)=>` context ${i}\n`).join('')+'-OLD_VALUE\n+NEW_VALUE\n'+Array.from({length:40},(_,i)=>` context ${i+40}\n`).join('');
      const pipe = () => ({model:'synthetic',stream:false,messages:[{role:'assistant',tool_calls:[{id:'diff',type:'function',function:{name:'Bash',arguments:'{"command":"git diff"}'}}]},{role:'tool',tool_call_id:'diff',content:diff}]});
      const healthy=tools(await run(pipe(),{sessionDedupMode:'off'}))[0].content;
      assert(Buffer.byteLength(healthy)<Buffer.byteLength(diff));
      for(const token of ['src/a.txt','OLD_VALUE','NEW_VALUE']) assert(healthy.includes(token));
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
      assert.equal(tools(await run(pipe(),{sessionDedupMode:'off'}))[0].content,diff);
      assert.equal(tools(await run(pipe(),{sessionDedupMode:'off'}))[0].content,diff);
      const local=tools(await run(fixture(false),{sessionDedupMode:'off'})).at(-1).content;
      assert(local.includes('[40 passing test lines omitted]'));
      const outageAfter=getRtkSnapshot();
      assert.equal(outageAfter.usage.http.failed-outageBefore.usage.http.failed,1);
      assert.equal(outageAfter.usage.skipped.circuit_open-outageBefore.usage.skipped.circuit_open,1);
      console.log(JSON.stringify({scenario:'pinned binary healthy+outage',rawDiffBytes:Buffer.byteLength(diff),compressedDiffBytes:Buffer.byteLength(healthy),outageRaw:true,circuit:true,localAvailable:true}));
    }
  } finally { provider.stop(true); sidecar?.stop(true); }
}
