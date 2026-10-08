import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BrowserManager, closeBrowserManagers } from "../src/browser/manager";
import { defaultBrokerEndpoint } from "../src/config";
import { AgentTurnBroker, closeAgentTurnBrokers, type AgentFunctionTool, AgentTurnError } from "../src/agent-turns";
import { createChatGptWebAgentAdapter } from "../src/agent-adapter";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isToolCallStart(event: AdapterEvent): event is Extract<AdapterEvent, { type: "tool_call_start" }> {
  return event.type === "tool_call_start";
}

function isToolCallDelta(event: AdapterEvent): event is Extract<AdapterEvent, { type: "tool_call_delta" }> {
  return event.type === "tool_call_delta";
}

function isDoneEvent(event: AdapterEvent): event is Extract<AdapterEvent, { type: "done" }> {
  return event.type === "done";
}

function isTextDelta(event: AdapterEvent): event is Extract<AdapterEvent, { type: "text_delta" }> {
  return event.type === "text_delta";
}

export interface GenericAgentOfflineOptions {
  chromeExecutable?: string;
  headed?: boolean;
  profileId?: string;
  profileEpoch?: string;
}

export interface GenericAgentOfflineFixture {
  root: string;
  scope: {
    profileId: string;
    profileEpoch: string;
    clientId: string;
    pathFlavor: "posix";
  };
  brokerSocket: string;
  agentBrokerSocket: string;
  manager: BrowserManager;
  client: Client;
  agentBroker: AgentTurnBroker;
  provider: CodexProviderConfig;
  close: () => Promise<void>;
}

export const syntheticHtml = readFileSync(new URL("../tests/fixtures/chatgpt-runtime.html", import.meta.url), "utf8")
  .split("form.addEventListener('submit',event=>{")[0] + `</script><script>
window.fixture.results = [];

form.addEventListener('submit', async event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (typeof window.syntheticMcpCall !== 'function') return;

  const prompt = composer.innerText;
  if (!prompt.trim()) return;
  window.fixture.sends++;
  window.fixture.prompts.push(prompt);
  composer.innerHTML = '';

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.setAttribute('data-testid', 'stop-button');
  stop.textContent = 'Stop';
  form.append(stop);

  const key = 'agent-turn-' + (++sends);
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-turn-key', key);
  const user = document.createElement('div');
  user.setAttribute('data-user-message-bubble', '');
  const source = document.createElement('div');
  source.setAttribute('data-search-result-target', '');
  source.style.whiteSpace = 'pre-wrap';
  source.textContent = prompt;
  user.append(source);
  wrapper.append(user);

  const answer = document.createElement('div');
  answer.setAttribute('data-content-search-unit-key', key + ':assistant');
  answer.innerHTML = '<div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>Processing...</p></div>';
  wrapper.append(answer);
  document.querySelector('#turns').append(wrapper);

  const tokenMatch = /request_token["':\\s]+([A-Za-z0-9_-]{32,64})/.exec(prompt) || /turn_[A-Za-z0-9_-]{32}/.exec(prompt);
  const token = tokenMatch ? tokenMatch[1] || tokenMatch[0] : '';

  try {
    if (window.__cgwAgentBatch) {
      const batch = window.__cgwAgentBatch;
      if (batch.delayMs) { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, batch.delayMs); await promise; }
      if (batch.calls.length) window.fixture.results.push(await window.syntheticMcpCall({ name: 'router_submit_tool_calls', arguments: { request_token: token, calls: batch.calls } }));
      answer.querySelector('[data-markdown-text-style]').textContent = batch.answer;
    } else
    if (prompt.includes('input.txt') && !prompt.includes('CGW_AGENT_FIXTURE_INPUT')) {
      const receipt = await window.syntheticMcpCall({
        name: 'router_submit_tool_calls',
        arguments: {
          request_token: token,
          calls: [{ name: 'read_file', arguments: { path: 'input.txt' } }],
        },
      });
      window.fixture.results.push(receipt);
      answer.querySelector('[data-markdown-text-style]').innerHTML = '<p>Reading input.txt</p>';
    } else if (prompt.includes('CGW_AGENT_FIXTURE_INPUT') && !prompt.includes('WRITE_SUCCESS')) {
      const receipt = await window.syntheticMcpCall({
        name: 'router_submit_tool_calls',
        arguments: {
          request_token: token,
          calls: [{ name: 'write_file', arguments: { path: 'output.txt', content: 'CGW_AGENT_FIXTURE_INPUT\\nVERIFIED\\n' } }],
        },
      });
      window.fixture.results.push(receipt);
      answer.querySelector('[data-markdown-text-style]').innerHTML = '<p>Writing output.txt</p>';
    } else if (prompt.includes('WRITE_SUCCESS') && !prompt.includes('READ_BACK_SUCCESS')) {
      const receipt = await window.syntheticMcpCall({
        name: 'router_submit_tool_calls',
        arguments: {
          request_token: token,
          calls: [{ name: 'read_file', arguments: { path: 'output.txt' } }],
        },
      });
      window.fixture.results.push(receipt);
      answer.querySelector('[data-markdown-text-style]').innerHTML = '<p>Verifying output.txt</p>';
    } else {
      answer.querySelector('[data-markdown-text-style]').innerHTML = '<p>Verification complete: output.txt contains CGW_AGENT_FIXTURE_INPUT and VERIFIED.</p>';
    }
  } catch (error) {
    answer.querySelector('[data-markdown-text-style]').innerHTML = '<p>Synthetic MCP error: ' + String(error) + '</p>';
    window.fixture.error = String(error);
  } finally {
    stop.remove();
    const controls = document.createElement('div');
    controls.className = 'turn-action-controls';
    controls.innerHTML = '<button type="button" data-testid="copy-turn-action-button">Copy</button>';
    wrapper.append(controls);
  }
}, true);
</script>
</body>
</html>`;

export async function setupGenericAgentOfflineFixture(
  options: GenericAgentOfflineOptions = {},
): Promise<GenericAgentOfflineFixture> {
  const browser = options.chromeExecutable ?? process.env.CGW_CHROMIUM_EXECUTABLE;
  if (!browser) throw new Error("CGW_CHROMIUM_EXECUTABLE is required");

  const root = mkdtempSync(join(tmpdir(), "cgw-agent-offline-"));
  process.env.CGW_DATA_DIR = root;

  const scope = {
    profileId: options.profileId ?? "fixture-agent",
    profileEpoch: options.profileEpoch ?? "epoch-agent-1",
    clientId: "agent-client-1",
    pathFlavor: "posix" as const,
  };

  const brokerSocket = defaultBrokerEndpoint(join(root, "profile"));
  const agentBrokerSocket = join(root, "profile", "agent-turns.sock");

  const manager = BrowserManager.forProfile({
    profileId: scope.profileId,
    profileEpoch: scope.profileEpoch,
    browserProfilePath: join(root, "browser"),
    chromeExecutablePath: browser,
    headed: options.headed ?? false,
  });

  const client = new Client({ name: "synthetic-agent-connector", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(import.meta.dir, "../src/adapters/chatgpt-web/mcp-main.ts"),
      "--broker-socket", brokerSocket,
      "--agent-broker-socket", agentBrokerSocket,
      "--contract", "native",
    ],
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  });

  const agentBroker = AgentTurnBroker.forSocket(agentBrokerSocket);
  await agentBroker.listen();
  await client.connect(transport);

  const context = await manager.ensureContext();
  await context.exposeBinding("syntheticMcpCall", async (_source, input) => {
    if (input && typeof input === "object" && "name" in input && typeof input.name === "string") {
      const toolName = input.name;
      const toolArgs = "arguments" in input && input.arguments && typeof input.arguments === "object"
        ? (input.arguments as Record<string, unknown>)
        : undefined;
      return client.callTool({ name: toolName, ...(toolArgs ? { arguments: toolArgs } : {}) });
    }
    throw new Error("Invalid MCP call payload");
  });

  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://chatgpt.com") return route.abort();
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({
        json: {
          expires: new Date(Date.now() + 600_000).toISOString(),
          user: { id: "synthetic-agent-account" },
        },
      });
    }
    return route.fulfill({ body: syntheticHtml, contentType: "text/html" });
  });

  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      ...scope,
      browserProfilePath: join(root, "browser"),
      headed: options.headed ?? false,
      brokerSocketPath: brokerSocket,
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: false,
      extraHighAvailable: false,
    },
  };

  const close = async () => {
    await client.close();
    await closeBrowserManagers();
    await closeAgentTurnBrokers();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    scope,
    brokerSocket,
    agentBrokerSocket,
    manager,
    client,
    agentBroker,
    provider,
    close,
  };
}

export async function runGenericAgentOfflineSmoke(): Promise<Record<string, unknown>> {
  const fixture = await setupGenericAgentOfflineFixture();

  try {
    const inventory = await fixture.client.listTools();
    assert(
      inventory.tools.some(tool => tool.name === "router_submit_tool_calls"),
      "router_submit_tool_calls must be available on connector when agent broker is configured",
    );

    const tools: AgentFunctionTool[] = [
      {
        type: "function",
        name: "read_file",
        description: "Read a local file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        type: "function",
        name: "write_file",
        description: "Write content to a local file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    ];

    const clientDir = mkdtempSync(join(fixture.root, "client-workspace-"));
    const inputFile = join(clientDir, "input.txt");
    const outputFile = join(clientDir, "output.txt");
    writeFileSync(inputFile, "CGW_AGENT_FIXTURE_INPUT\n");

    const prepare = (body: unknown): CodexParsedRequest => {
      const parsed = parseRequest(body);
      parsed.modelId = "gpt-5.6-sol";
      parsed.options.reasoning = "high";
      parsed._chatgptModelFamily = "5.6";
      parsed._chatgptEffectiveModelIdentity = {
        routeId: "chatgpt-web/gpt-5.6-sol",
        browserFamily: "5.6",
        reasoning: "high",
      };
      return parsed;
    };

    // Round 1: Client sends initial user prompt requesting tool loop.
    const round1Body = {
      model: "chatgpt-web/gpt-5.6-sol",
      stream: true,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: [
        {
          type: "message",
          role: "user",
          content: "Read input.txt, create output.txt containing the same text plus VERIFIED, then read it back.",
        },
      ],
    };

    const adapter1 = createChatGptWebAgentAdapter(fixture.provider, {
      requestId: "turn-round-1",
      profileId: fixture.scope.profileId,
      profileEpoch: fixture.scope.profileEpoch,
      model: "chatgpt-web/gpt-5.6-sol",
      effort: "high",
      socketPath: fixture.agentBrokerSocket,
    });

    const eventsRound1: AdapterEvent[] = [];
    await adapter1.runTurn(prepare(round1Body), { headers: new Headers() }, event => eventsRound1.push(event));

    const toolCallsRound1 = eventsRound1.filter(isToolCallStart);
    assert(toolCallsRound1.length === 1, "Round 1 must propose exactly 1 tool call");
    const callIdRound1 = toolCallsRound1[0].id;
    const toolDeltaRound1 = eventsRound1.find(isToolCallDelta);
    assert(toolDeltaRound1 && toolDeltaRound1.arguments.includes("input.txt"), "Round 1 tool call must target input.txt");

    const terminalRound1 = eventsRound1.find(isDoneEvent);
    assert(terminalRound1?.stopReason === "tool_use" && terminalRound1?.endTurn === false, "Round 1 must end with stopReason tool_use and endTurn false");

    const readContent = readFileSync(inputFile, "utf8");
    assert(readContent.trim() === "CGW_AGENT_FIXTURE_INPUT", "Input file content mismatch");

    // Round 2: Client supplies complete history + tool result, model proposes write_file.
    const round2Body = {
      model: "chatgpt-web/gpt-5.6-sol",
      stream: true,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: [
        ...round1Body.input,
        {
          type: "function_call",
          call_id: callIdRound1,
          name: "read_file",
          arguments: JSON.stringify({ path: "input.txt" }),
        },
        {
          type: "function_call_output",
          call_id: callIdRound1,
          output: readContent,
        },
      ],
    };

    const adapter2 = createChatGptWebAgentAdapter(fixture.provider, {
      requestId: "turn-round-2",
      profileId: fixture.scope.profileId,
      profileEpoch: fixture.scope.profileEpoch,
      model: "chatgpt-web/gpt-5.6-sol",
      effort: "high",
      socketPath: fixture.agentBrokerSocket,
    });

    const eventsRound2: AdapterEvent[] = [];
    await adapter2.runTurn(prepare(round2Body), { headers: new Headers() }, event => eventsRound2.push(event));

    const toolCallsRound2 = eventsRound2.filter(isToolCallStart);
    assert(toolCallsRound2.length === 1, "Round 2 must propose write_file");
    const callIdRound2 = toolCallsRound2[0].id;
    const toolDeltaRound2 = eventsRound2.find(isToolCallDelta);
    assert(toolDeltaRound2, "Round 2 must emit tool_call_delta");
    const rawParsedWrite = JSON.parse(toolDeltaRound2.arguments);
    assert(
      rawParsedWrite && typeof rawParsedWrite === "object" &&
      "path" in rawParsedWrite && typeof rawParsedWrite.path === "string" &&
      "content" in rawParsedWrite && typeof rawParsedWrite.content === "string",
      "Write arguments must include path and content",
    );
    const writeArgs = { path: rawParsedWrite.path, content: rawParsedWrite.content };
    assert(writeArgs.path === "output.txt", "Round 2 must write to output.txt");
    assert(writeArgs.content.includes("VERIFIED"), "Round 2 write must include VERIFIED");

    // Outer client performs write on disk:
    writeFileSync(outputFile, writeArgs.content);
    const writeResult = "WRITE_SUCCESS";

    // Round 3: Client supplies complete history + write result, model proposes read-back.
    const round3Body = {
      model: "chatgpt-web/gpt-5.6-sol",
      stream: true,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: [
        ...round2Body.input,
        {
          type: "function_call",
          call_id: callIdRound2,
          name: "write_file",
          arguments: JSON.stringify(writeArgs),
        },
        {
          type: "function_call_output",
          call_id: callIdRound2,
          output: writeResult,
        },
      ],
    };

    const adapter3 = createChatGptWebAgentAdapter(fixture.provider, {
      requestId: "turn-round-3",
      profileId: fixture.scope.profileId,
      profileEpoch: fixture.scope.profileEpoch,
      model: "chatgpt-web/gpt-5.6-sol",
      effort: "high",
      socketPath: fixture.agentBrokerSocket,
    });

    const eventsRound3: AdapterEvent[] = [];
    await adapter3.runTurn(prepare(round3Body), { headers: new Headers() }, event => eventsRound3.push(event));

    const toolCallsRound3 = eventsRound3.filter(isToolCallStart);
    assert(toolCallsRound3.length === 1, "Round 3 must propose read_file for verification");
    const callIdRound3 = toolCallsRound3[0].id;
    const verifiedOutput = readFileSync(outputFile, "utf8");
    assert(verifiedOutput === "CGW_AGENT_FIXTURE_INPUT\nVERIFIED\n", "Physical file verification on disk");

    // Round 4: Client supplies complete history + read-back result, model concludes.
    const round4Body = {
      model: "chatgpt-web/gpt-5.6-sol",
      stream: false,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: [
        ...round3Body.input,
        {
          type: "function_call",
          call_id: callIdRound3,
          name: "read_file",
          arguments: JSON.stringify({ path: "output.txt" }),
        },
        {
          type: "function_call_output",
          call_id: callIdRound3,
          output: `READ_BACK_SUCCESS: ${verifiedOutput}`,
        },
      ],
    };

    const adapter4 = createChatGptWebAgentAdapter(fixture.provider, {
      requestId: "turn-round-4",
      profileId: fixture.scope.profileId,
      profileEpoch: fixture.scope.profileEpoch,
      model: "chatgpt-web/gpt-5.6-sol",
      effort: "high",
      socketPath: fixture.agentBrokerSocket,
    });

    const eventsRound4: AdapterEvent[] = [];
    await adapter4.runTurn(prepare(round4Body), { headers: new Headers() }, event => eventsRound4.push(event));

    const textDeltasRound4 = eventsRound4.filter(isTextDelta);
    const finalAnswerText = textDeltasRound4.map(d => d.text).join("");
    assert(
      finalAnswerText.includes("Verification complete"),
      "Final turn must deliver final answer text",
    );
    const terminalRound4 = eventsRound4.find(isDoneEvent);
    assert(terminalRound4?.stopReason === "stop" && terminalRound4?.endTurn === true, "Final turn must end with stop and endTurn true");

    // Token isolation test: submit with expired or foreign token must be rejected.
    const crossedCall = await fixture.client.callTool({
      name: "router_submit_tool_calls",
      arguments: {
        request_token: "non_existent_token_12345678901234567890",
        calls: [{ name: "read_file", arguments: { path: "forbidden.txt" } }],
      },
    });
    assert(crossedCall.isError === true, "Crossed / invalid request token must fail");

    // Required choice unsatisfied test:
    const unsatisfiedHandle = fixture.agentBroker.register({
      profileId: fixture.scope.profileId,
      profileEpoch: fixture.scope.profileEpoch,
      requestId: "req-unsatisfied",
      model: "chatgpt-web/gpt-5.6-sol",
      tools,
      toolChoice: "required",
    });
    let unsatisfiedThrew = false;
    try {
      unsatisfiedHandle.finish();
    } catch (err) {
      unsatisfiedThrew = true;
      assert(err instanceof AgentTurnError && err.code === "agent_tool_choice_unsatisfied", "Finish without submission must throw agent_tool_choice_unsatisfied");
    }
    assert(unsatisfiedThrew, "Required choice with no submissions must throw");

    const result = {
      gate: "offline-agent-browser-mcp-loop",
      actualChromium: true,
      actualMcpStdio: true,
      rounds: 4,
      readVerified: true,
      writeVerified: true,
      readBackVerified: true,
      tokenIsolation: true,
      toolChoiceEnforced: true,
      realCodex: false,
      outboundOpenAiTunnel: false,
      liveChatGpt: false,
    };
    console.info(JSON.stringify(result));
    return result;
  } finally {
    await fixture.close();
  }
}

if (import.meta.main) {
  await runGenericAgentOfflineSmoke();
}
