import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// This helper drives the real CLI. It never executes its proposed tools itself.
export async function runOmpSmoke({ binary, version, root, project, env, apiKey, gatewayBase, control, catalogRow, buildConfig, children, logFiles, signal }) {
  const model = `cgw/${catalogRow.id}`, effort = "high";
  const input = "CGW_AGENT_FIXTURE_INPUT\n", expected = input + "VERIFIED\n";
  const inputPath = join(project, "input.txt"), outputPath = join(project, "output.txt");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(inputPath, input, { mode: 0o600 });
  const agentDir = join(root, "omp-agent"), modelsFile = join(agentDir, "models.yml");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const fields = new Set(), calls = [], callIds = new Set(), completed = new Set();
  let requests = 0, approvals = 0, failure, cli, pendingTool, finalText = "", terminal = false, promptSettled = false;
  let sendStart, sendEnd;
  const completion = Promise.withResolvers();
  const fail = error => { failure ||= error; completion.reject(error); };
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const url = new URL(request.url);
      assert(request.method === "POST" && url.pathname === "/v1/chat/completions", "omp issued an unexpected endpoint or side request");
      assert(request.headers.get("authorization") === `Bearer ${apiKey}`, "omp did not resolve its environment API key");
      const body = await request.clone().json(); Object.keys(body).forEach(key => fields.add(key));
      assert(body.model === model && body.reasoning_effort === effort && body.store === false, "omp lost model, effort or store:false");
      assert(!["temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "max_output_tokens", "previous_response_id"].some(key => Object.hasOwn(body, key)), "omp emitted unsupported sampling, output limits or continuation controls");
      assert(requests < 4 && body.stream === true, "omp repeated a turn or lost streaming");
      const tools = body.tools;
      assert(Array.isArray(tools) && tools.length === 2 && tools.every(tool => tool.type === "function"), "omp must expose only two function tools");
      // Derive argument keys from the actual emitted schemas, not another client's inventory.
      const read = tools.find(tool => tool.function?.name === "read")?.function;
      const write = tools.find(tool => tool.function?.name === "write")?.function;
      assert(read && write, "omp selected read/write inventory missing");
      for (const tool of [read, write]) {
        assert(tool.parameters?.type === "object" && tool.parameters.properties?.path?.type === "string", "omp path schema changed");
        assert((tool.parameters.required || []).every(key => ["path", "i", ...(tool === write ? ["content"] : [])].includes(key)), "omp tool has unsupported required arguments");
      }
      assert(write.parameters.properties.content?.type === "string", "omp content schema changed");
      const withIntent = (tool, args, intent) => ({ ...args, ...(tool.parameters.properties.i ? { i: intent } : {}) });
      if (requests === 0) {
        calls.push(
          { name: read.name, arguments: withIntent(read, { path: inputPath }, "Reading fixture input") },
          { name: write.name, arguments: withIntent(write, { path: outputPath, content: expected }, "Writing fixture output") },
          { name: read.name, arguments: withIntent(read, { path: outputPath }, "Reading fixture output") },
        );
      }
      assert(body.messages?.some(message => message.role === "user"), "omp user history missing");
      const results = body.messages.filter(message => message.role === "tool");
      const proposals = body.messages.filter(message => message.role === "assistant").flatMap(message => message.tool_calls || []);
      assert(results.length === requests && proposals.length === requests, "omp did not preserve complete stateless history");
      for (let index = 0; index < requests; index++) {
        const proposal = proposals[index];
        assert(proposal.function.name === calls[index].name && results[index].tool_call_id === proposal.id, "omp tool identities or result order changed");
        assert.deepEqual(JSON.parse(proposal.function.arguments), calls[index].arguments, "omp altered proposed tool arguments in history");
        const content = typeof results[index].content === "string" ? results[index].content : JSON.stringify(results[index].content);
        if (index === 0) assert(content.includes(input.trim()), "omp did not read the input fixture");
        if (index === 2) assert(content.includes(input.trim()) && content.includes("VERIFIED"), "omp did not read back the written fixture");
      }
      const next = calls[requests];
      await control("/agent-cli", "POST", { calls: next ? [next] : [], answer: next ? "Client operation queued." : "Verification complete: output.txt was read back." });
      requests++;
      const response = await fetch(gatewayBase + url.pathname, { method: "POST", headers: request.headers, body: request.body, redirect: "error", signal: request.signal });
      assert(response.ok, "omp gateway request failed");
      return response;
    } catch (error) {
      fail(error);
      return Response.json({ error: { message: "Offline omp fixture assertion failed" } }, { status: 500 });
    }
  } });
  let timeout;
  const onAbort = () => fail(new assert.AssertionError({ message: "Owned omp smoke interrupted" }));
  try {
    const snippet = buildConfig(catalogRow, `http://127.0.0.1:${proxy.port}`, effort);
    assert(typeof snippet.ompConfig === "string", "Generated omp YAML is unavailable");
    const downloaded = Bun.YAML.parse(snippet.ompConfig);
    const unrelated = { baseUrl: `http://127.0.0.1:${proxy.port}/unrelated`, api: "openai-completions", apiKey: "UNRELATED_FIXTURE_KEY", models: [{ id: "unrelated-model", name: "Unrelated fixture", input: ["text"], contextWindow: 4096, maxTokens: 256 }] };
    const existing = { providers: { "unrelated-fixture": unrelated, "9router-cgw": { models: [{ id: "retained-fixture-model", name: "Retained fixture", input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } };
    // Follow the setup's merge-by-id instructions, retaining unrelated providers/models.
    writeFileSync(modelsFile, Bun.YAML.stringify(existing), { mode: 0o600 });
    const merged = Bun.YAML.parse(readFileSync(modelsFile, "utf8"));
    for (const [id, provider] of Object.entries(downloaded.providers)) {
      const prior = merged.providers[id] || {};
      const models = new Map((prior.models || []).map(row => [row.id, row]));
      for (const row of provider.models || []) models.set(row.id, row);
      merged.providers[id] = { ...prior, ...provider, models: [...models.values()] };
    }
    assert.deepEqual(JSON.parse(JSON.stringify(merged.providers["unrelated-fixture"])), unrelated, "omp config merge overwrote an unrelated provider");
    writeFileSync(modelsFile, Bun.YAML.stringify(merged), { mode: 0o600 });
    const fd = openSync(join(root, "omp.private.log"), "w", 0o600); logFiles.push(fd);
    sendStart = (await control()).physicalSends;
    cli = spawn(binary, ["--mode", "rpc", "--model", `9router-cgw/${model}`, "--thinking", effort, "--tools", "read,write", "--approval-mode", "always-ask", "--no-lsp", "--no-pty", "--no-extensions", "--no-skills", "--no-rules", "--no-session", "--no-title"], {
      cwd: project, env: { ...env, PWD: project, PI_CODING_AGENT_DIR: agentDir, NINE_ROUTER_API_KEY: apiKey, OMP_SKIP_VERSION_CHECK: "1" },
      stdio: ["pipe", "pipe", fd], detached: process.platform !== "win32",
    });
    children.push(cli);
    cli.on("error", () => fail(new assert.AssertionError({ message: "omp executable failed to start" })));
    const send = frame => { if (!cli.stdin.destroyed) cli.stdin.write(JSON.stringify(frame) + "\n"); };
    let buffer = "";
    cli.stdout.on("data", chunk => {
      try {
        buffer += chunk.toString(); assert(buffer.length <= 1048576, "omp RPC frame exceeded fixture limit");
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.type === "ready") {
            send({ id: "models", type: "get_available_models" });
          } else if (frame.type === "response") {
            assert(frame.success === true, "omp RPC command failed");
            if (frame.id === "models") {
              const available = frame.data?.models;
              assert(Array.isArray(available) && available.some(row => row.provider === "unrelated-fixture" && row.id === "unrelated-model") && available.some(row => row.provider === "9router-cgw" && row.id === "retained-fixture-model"), "omp did not load preserved model providers");
              send({ id: "warming", type: "set_cache_warming", mode: "off" });
            } else if (frame.id === "warming") send({ id: "retry", type: "set_auto_retry", enabled: false });
            else if (frame.id === "retry") send({ id: "fixture", type: "prompt", message: "Read input.txt, write output.txt with the same text followed by VERIFIED and a newline, then read output.txt back." });
          } else if (frame.type === "tool_execution_start") {
            const next = calls[callIds.size];
            assert(next && frame.toolName === next.name && !callIds.has(frame.toolCallId), "omp executed an unexpected or duplicate tool");
            const { i: _intent, ...args } = next.arguments;
            assert.deepEqual(frame.args, args, "omp executed arguments outside the approved fixture");
            callIds.add(frame.toolCallId); pendingTool = frame;
          } else if (frame.type === "extension_ui_request" && ["select", "confirm", "input", "editor", "ask"].includes(frame.method)) {
            // Only the exact queued workspace write is approved; no global grant is issued.
            const approve = frame.method === "select" && pendingTool?.toolName === "write" && pendingTool.args.path === outputPath && pendingTool.args.content === expected
              && frame.title === `Allow tool: write\nPath: ${outputPath}\nContent:\n${expected}` && JSON.stringify(frame.options) === JSON.stringify(["Approve", "Deny"]) && approvals === 0;
            send(approve ? { type: "extension_ui_response", id: frame.id, value: "Approve" } : { type: "extension_ui_response", id: frame.id, cancelled: true });
            assert(approve, "omp requested an unexpected approval or dialog"); approvals++;
          } else if (frame.type === "tool_execution_end") {
            assert(frame.isError !== true && callIds.has(frame.toolCallId) && !completed.has(frame.toolCallId), "omp tool failed or completed twice");
            completed.add(frame.toolCallId); pendingTool = null;
          } else if (frame.type === "message_end" && frame.message?.role === "assistant") {
            if (frame.message.stopReason === "stop") {
              terminal = true; finalText = (frame.message.content || []).filter(part => part.type === "text").map(part => part.text).join("");
            } else assert(frame.message.stopReason === "toolUse", "omp assistant ended unsuccessfully");
          } else if (frame.type === "prompt_result") {
            assert(frame.id === "fixture" && frame.status === "completed" && frame.sessionSettled === true, "omp prompt failed or did not settle");
            promptSettled = true; cli.stdin.end();
          } else if (["rpc_frame_error", "extension_error", "auto_retry_start"].includes(frame.type)) {
            assert.fail("omp emitted a failed frame or attempted an automatic retry");
          }
        }
      } catch (error) { fail(error); }
    });
    cli.once("exit", code => completion.resolve(code));
    timeout = setTimeout(() => fail(new assert.AssertionError({ message: "omp CLI offline deadline" })), 180000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const code = await completion.promise;
    assert(!failure && code === 0 && requests === 4 && completed.size === 3 && approvals === 1 && terminal && promptSettled && finalText.includes("Verification complete"), "Actual omp tool loop did not complete");
    assert(existsSync(outputPath) && readFileSync(outputPath, "utf8") === expected, "Actual omp physical write/read-back output differs");
    sendEnd = (await control()).physicalSends;
    assert(sendEnd - sendStart === 4, "omp did not produce exactly one browser Send per stateless round");
    return { version, nativeClientTools: true, toolInventory: ["read", "write"], explicitWriteApprovals: approvals, approvalMode: "always-ask", readWriteReadBack: true, completeHistory: true, unsupportedControlsAbsent: true, storeFalse: true, preservedUnrelatedProvider: true, statelessBrowserSends: sendEnd - sendStart, wireFieldNames: [...fields].sort() };
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); proxy.stop(true);
    // The wrapper owns the process group and closes any unfinished CLI during cleanup.
    if (cli && !cli.stdin.destroyed) cli.stdin.end();
  }
}
