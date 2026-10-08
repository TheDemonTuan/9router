import { createHash } from "node:crypto";
import {
  AgentTurnBroker,
  AgentTurnError,
  type AgentFunctionTool,
  type AgentToolChoice,
  type AgentTurnHandle,
  type AgentTurnRegistration,
} from "./agent-turns";
import type { IncomingMeta, ProviderAdapter } from "./adapters/base";
import {
  ChatGptBrowserWorker,
  type BrowserTurn,
} from "./adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt, type AgentToolHandoffOptions } from "./adapters/chatgpt-web/prompt";
import { estimateChatGptWebUsage } from "./adapters/chatgpt-web/usage";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";
import type {
  AdapterEvent,
  CodexParsedRequest,
  CodexProviderConfig,
  CodexUsage,
} from "./types";
import type { ChatGptWebCapabilities } from "./adapters/chatgpt-web/model";

export interface ChatGptWebAgentAdapterDependencies {
  requestId: string;
  profileId: string;
  profileEpoch: string;
  model: string;
  effort?: string;
  socketPath: string;
}

interface BufferedTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

function resolveAgentTools(parsed: CodexParsedRequest): AgentFunctionTool[] {
  const raw = parsed._rawBody;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "tools" in raw && Array.isArray(raw.tools)) {
    const result: AgentFunctionTool[] = [];
    for (const t of raw.tools) {
      if (!t || typeof t !== "object" || !("type" in t) || t.type !== "function") continue;
      if ("function" in t && t.function && typeof t.function === "object" && "name" in t.function && typeof t.function.name === "string") {
        const fn = t.function;
        const description = "description" in fn && typeof fn.description === "string" ? fn.description : undefined;
        const parameters = "parameters" in fn && fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? (fn.parameters as Record<string, unknown>)
          : { type: "object", properties: {} };
        const strict = "strict" in fn && typeof fn.strict === "boolean" ? fn.strict : undefined;
        result.push({
          type: "function",
          name: fn.name,
          ...(description !== undefined ? { description } : {}),
          parameters,
          ...(strict !== undefined ? { strict } : {}),
        });
      } else if ("name" in t && typeof t.name === "string") {
        const description = "description" in t && typeof t.description === "string" ? t.description : undefined;
        const parameters = "parameters" in t && t.parameters && typeof t.parameters === "object" && !Array.isArray(t.parameters)
          ? (t.parameters as Record<string, unknown>)
          : { type: "object", properties: {} };
        const strict = "strict" in t && typeof t.strict === "boolean" ? t.strict : undefined;
        result.push({
          type: "function",
          name: t.name,
          ...(description !== undefined ? { description } : {}),
          parameters,
          ...(strict !== undefined ? { strict } : {}),
        });
      }
    }
    return result;
  }

  if (Array.isArray(parsed.context.tools)) {
    return parsed.context.tools.map(tool => ({
      type: "function" as const,
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: "object", properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    }));
  }

  return [];
}

function resolveAgentToolChoice(parsed: CodexParsedRequest): AgentToolChoice {
  const raw = parsed._rawBody;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "tool_choice" in raw) {
    const rawChoice = raw.tool_choice;
    if (rawChoice === "auto" || rawChoice === "none" || rawChoice === "required") {
      return rawChoice;
    }
    if (rawChoice && typeof rawChoice === "object" && !Array.isArray(rawChoice) && "type" in rawChoice && rawChoice.type === "function") {
      if ("name" in rawChoice && typeof rawChoice.name === "string") {
        return { type: "function", name: rawChoice.name };
      }
      if ("function" in rawChoice && rawChoice.function && typeof rawChoice.function === "object" && "name" in rawChoice.function && typeof rawChoice.function.name === "string") {
        return { type: "function", name: rawChoice.function.name };
      }
    }
  }

  const choice = parsed.options.toolChoice;
  if (!choice || choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  if (typeof choice === "object" && "name" in choice && typeof choice.name === "string") {
    return { type: "function", name: choice.name };
  }
  return "auto";
}


export function createChatGptWebAgentAdapter(
  provider: CodexProviderConfig,
  dependencies: ChatGptWebAgentAdapterDependencies,
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = AgentTurnBroker.forSocket(dependencies.socketPath);

  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: false,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };

  return {
    name: "chatgpt-web-agent",
    async runTurn(
      parsed: CodexParsedRequest,
      incoming: IncomingMeta,
      emit: (event: AdapterEvent) => void,
    ): Promise<void> {
      const tools = resolveAgentTools(parsed);
      const toolChoice = resolveAgentToolChoice(parsed);
      const rawBody = parsed._rawBody;
      const parallelToolCalls = (
        rawBody &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody) &&
        "parallel_tool_calls" in rawBody &&
        typeof rawBody.parallel_tool_calls === "boolean"
      )
        ? rawBody.parallel_tool_calls
        : (typeof parsed.options.parallelToolCalls === "boolean" ? parsed.options.parallelToolCalls : true);
      const hasActiveTools = tools.length > 0 && toolChoice !== "none";

      let handle: AgentTurnHandle | undefined;
      if (hasActiveTools) {
        const registration: AgentTurnRegistration = {
          profileId: dependencies.profileId,
          profileEpoch: dependencies.profileEpoch,
          requestId: dependencies.requestId,
          model: dependencies.model,
          effort: dependencies.effort,
          tools,
          toolChoice,
          parallelToolCalls,
        };
        handle = broker.register(registration);
      }

      const browserAbort = new AbortController();
      const onCapabilityExpired = () => browserAbort.abort(handle?.signal.reason);
      handle?.signal.addEventListener("abort", onCapabilityExpired, { once: true });
      let onIncomingAbort: (() => void) | undefined;
      if (incoming.abortSignal) {
        if (incoming.abortSignal.aborted) {
          handle?.revoke();
          throw incoming.abortSignal.reason instanceof Error
            ? incoming.abortSignal.reason
            : new DOMException("The operation was aborted", "AbortError");
        }
        onIncomingAbort = () => {
          handle?.revoke();
          browserAbort.abort(incoming.abortSignal?.reason);
        };
        incoming.abortSignal.addEventListener("abort", onIncomingAbort, { once: true });
      }

      const traceId = createHash("sha256")
        .update(JSON.stringify([dependencies.profileId, dependencies.profileEpoch, dependencies.requestId, Date.now()]))
        .digest("hex")
        .slice(0, 12);

      const bufferedText: string[] = [];
      const bufferedTrace: BufferedTraceEvent[] = [];
      const submission: { phase: "prepared" | "send_activated" | "submitted" } = { phase: "prepared" };

      const heartbeatTimer = setInterval(() => {
        emit({ type: "heartbeat" });
      }, 10_000);
      heartbeatTimer.unref?.();

      const prepareTurn = async () => {
        const handoffOptions: AgentToolHandoffOptions | undefined = hasActiveTools && handle
          ? {
            requestToken: handle.token,
            tools,
            toolChoice,
            parallelToolCalls,
          }
          : (tools.length === 0 || toolChoice === "none"
            ? {
              requestToken: "",
              tools: [],
              toolChoice: "none",
              parallelToolCalls: false,
            }
            : undefined);

        const compiled = compileChatGptWebPrompt(
          parsed,
          configuredCapabilities,
          undefined,
          {
            preserveCompleteHistory: true,
            agentToolHandoff: handoffOptions,
          },
        );
        return { ...compiled, release: () => {} };
      };

      const browserTurn: BrowserTurn = {
        traceId,
        modelId: parsed.modelId,
        modelFamily: parsed._chatgptModelFamily,
        reasoning: parsed.options.reasoning,
        capabilities: configuredCapabilities,
        nativeConnector: hasActiveTools,
        prepare: prepareTurn,
        abortSignal: browserAbort.signal,
        externalProgress: handle?.externalProgress,
        completionFence: handle?.completionFence,
        onHeartbeat: () => emit({ type: "heartbeat" }),
        onSendActivated: () => { submission.phase = "send_activated"; },
        onSubmitted: () => { submission.phase = "submitted"; },
        onReasoningSummary: (text, continuation) => {
          if (hasActiveTools) {
            bufferedTrace.push({ kind: "reasoning", text, continuation });
          } else {
            if (!continuation) emit({ type: "assistant_boundary" });
            emit({ type: "thinking_delta", thinking: text });
          }
        },
        onCommentary: (text, continuation) => {
          if (hasActiveTools) {
            bufferedTrace.push({ kind: "commentary", text, continuation });
          } else {
            if (!continuation) emit({ type: "assistant_boundary" });
            emit({ type: "text_delta", text, phase: "commentary" });
          }
        },
        onTextDelta: delta => {
          if (hasActiveTools) {
            bufferedText.push(delta);
          } else {
            emit({ type: "text_delta", text: delta, phase: "final_answer" });
          }
        },
      };

      const physicalRun = worker.run(browserTurn);
      const physicalSettlement = physicalRun.then(() => undefined, () => undefined);

      try {
        const answer = await physicalRun;

        if (hasActiveTools && handle) {
          const toolRequests = handle.finish();

          if (toolRequests.length > 0) {
            for (const t of bufferedTrace) {
              if (!t.continuation) emit({ type: "assistant_boundary" });
              if (t.kind === "reasoning") {
                emit({ type: "thinking_delta", thinking: t.text });
              }
            }

            for (const request of toolRequests) {
              emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
              emit({
                type: "tool_call_delta",
                arguments: typeof request.arguments === "string"
                  ? request.arguments
                  : JSON.stringify(request.arguments ?? {}),
              });
              emit({ type: "tool_call_end" });
            }

            const usage: CodexUsage = estimateChatGptWebUsage(
              parsed,
              { toolRequests, reasoning: bufferedTrace.map(t => t.text) },
              configuredCapabilities,
            );
            emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
            return;
          }

          for (const t of bufferedTrace) {
            if (!t.continuation) emit({ type: "assistant_boundary" });
            if (t.kind === "commentary") {
              emit({ type: "text_delta", text: t.text, phase: "commentary" });
            } else {
              emit({ type: "thinking_delta", thinking: t.text });
            }
          }

          if (bufferedText.length > 0) {
            for (const delta of bufferedText) {
              emit({ type: "text_delta", text: delta, phase: "final_answer" });
            }
          } else if (answer) {
            emit({ type: "text_delta", text: answer, phase: "final_answer" });
          }

          const usage: CodexUsage = estimateChatGptWebUsage(
            parsed,
            { answer, reasoning: bufferedTrace.map(t => t.text) },
            configuredCapabilities,
          );
          emit({ type: "done", stopReason: "stop", endTurn: true, usage });
          return;
        }

        const usage: CodexUsage = estimateChatGptWebUsage(
          parsed,
          { answer },
          configuredCapabilities,
        );
        emit({ type: "done", stopReason: "stop", endTurn: true, usage });
      } catch (error) {
        const capabilityError = handle?.signal.aborted ? handle.signal.reason : undefined;
        handle?.revoke();
        await physicalSettlement;

        if (incoming.abortSignal?.aborted) {
          throw incoming.abortSignal.reason instanceof Error
            ? incoming.abortSignal.reason
            : new DOMException("The operation was aborted", "AbortError");
        }
        if (capabilityError instanceof AgentTurnError) error = capabilityError;

        if (error instanceof AgentTurnError) {
          emit({
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: false,
          });
          return;
        }

        if (submission.phase === "send_activated") {
          const ambiguousError = new ChatGptWebAdapterError(
            "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing.",
            {
              status: 502,
              errorType: "server_error",
              code: "chatgpt_submission_ambiguous",
              retryable: false,
              cause: error instanceof Error ? error : new Error(String(error)),
            },
          );
          emit({
            type: "error",
            message: ambiguousError.message,
            status: ambiguousError.status,
            errorType: ambiguousError.errorType,
            code: ambiguousError.code,
            retryable: false,
          });
          return;
        }

        if (error instanceof ChatGptWebAdapterError) {
          emit({
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: false,
          });
          return;
        }

        emit({
          type: "error",
          message: "ChatGPT turn failed. Inspect runtime diagnostics before continuing.",
          status: 500,
          errorType: "server_error",
          code: "chatgpt_turn_failed",
          retryable: false,
        });
      } finally {
        clearInterval(heartbeatTimer);
        handle?.signal.removeEventListener("abort", onCapabilityExpired);
        if (incoming.abortSignal && onIncomingAbort) {
          incoming.abortSignal.removeEventListener("abort", onIncomingAbort);
        }
      }
    },
  };
}
