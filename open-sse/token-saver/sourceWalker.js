import { FORMATS } from "../translator/formats.js";
import { ROLE, GEMINI_ROLE } from "../translator/schema/roles.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { TOKEN_SAVER_CONFIG as LIMIT } from "../config/tokenSaverConfig.js";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" && value.length > 0;
const failed = value => value?.is_error === true || value?.isError === true || value?.error != null ||
  (value?.status != null && !["success", "completed"].includes(value.status));
const ownKeys = value => object(value) ? Object.keys(value) : [];

export function inspectSource(body, format) {
  const family = format === FORMATS.CLAUDE ? "claude" : format === FORMATS.KIRO ? "kiro"
    : [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format) ? "gemini"
      : [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX].includes(format) ? "openai" : null;
  const formatKnown = family !== null;
  const index = {
    body,
    format,
    formatKnown,
    supported: false,
    blockedReason: null,
    results: [],
    calls: [],
    toolBatches: [],
    diagnostics: null,
    textSegments: [],
    protocolNodes: [],
    currentTurnIndex: -1,
  };
  if (!object(body)) { index.blockedReason = "unsupported_shape"; return index; }
  const shapes = [Array.isArray(body.messages), Array.isArray(body.input), Array.isArray(body.contents),
    Array.isArray(body.request?.contents), object(body.conversationState)].filter(Boolean).length;
  const dialect = family === "openai" ? (Array.isArray(body.input) ? "responses" : "chat") : family;
  if (shapes !== 1 || !family || (family === "openai" && !Array.isArray(body[dialect === "chat" ? "messages" : "input"])) ||
    (family === "claude" && !Array.isArray(body.messages)) ||
    (family === "gemini" && !Array.isArray(format === FORMATS.ANTIGRAVITY ? body.request?.contents : (body.request?.contents ?? body.contents))) ||
    (family === "kiro" && !object(body.conversationState))) {
    index.blockedReason = "unsupported_shape";
    return index;
  }
  const nodes = index.protocolNodes;
  let turn = -1;
  let group = -1;
  const diagnostics = {
    responsesImplicitUserMessages: 0,
    ambiguousTurns: 0,
  };
  let activeBatch = null;
  let activeBatchIndex = null;
  let activeBatchPhase = null;
  function endActiveBatch(pos = nodes.length) {
    if (activeBatch) {
      if (activeBatch.endPosition == null) activeBatch.endPosition = pos;
      activeBatch = null;
      activeBatchIndex = null;
      activeBatchPhase = null;
    }
  }
  function startBatch() {
    endActiveBatch(nodes.length);
    if (index.toolBatches.length >= LIMIT.maxEntries) throw Error("metadata_budget");
    const batch = {
      turnIndex: turn,
      firstCallPosition: null,
      lastCallPosition: null,
      endPosition: null,
      callCount: 0,
      resultCount: 0,
      tainted: false,
      completed: false,
    };
    index.toolBatches.push(batch);
    activeBatchIndex = index.toolBatches.length - 1;
    activeBatch = batch;
    return activeBatchIndex;
  }
  function node(owner, parent, enclosingMessage, kind) {
    if (nodes.length >= LIMIT.maxProtocolNodes) throw Error("metadata_budget");
    const record = { owner, parent, enclosingMessage, position: nodes.length, kind };
    nodes.push(record);
    return record;
  }
  function segment(owner, key, role, message, parent, kind = "text", resultIndex = null) {
    if (typeof owner?.[key] !== "string") return;
    const n = node(owner, parent, message, kind);
    index.textSegments.push({ owner, key, text: owner[key], role, messagePosition: message?.position ?? n.position,
      position: n.position, resultIndex, protectedReason: null });
  }
  function addCall(kind, name, id, owner, parent, batchIdx = null) {
    if (index.calls.length >= LIMIT.maxEntries) throw Error("metadata_budget");
    const n = node(owner, parent, parent?.enclosingMessage || parent, "call");
    if (batchIdx != null) {
      const batch = index.toolBatches[batchIdx];
      if (batch) {
        if (batch.firstCallPosition == null) batch.firstCallPosition = n.position;
        batch.lastCallPosition = n.position;
        batch.callCount++;
      }
    }
    index.calls.push({ kind, name, id, position: n.position, turnIndex: turn, group, ambiguous: false, batchIndex: batchIdx });
    return n;
  }
  function addResult(owner, parent, container, key, representation, kind, id, name, error, mixed = false, occurrenceBatchIndex = null) {
    if (index.results.length >= LIMIT.maxEntries) throw Error("metadata_budget");
    const n = node(owner, parent, parent?.enclosingMessage || parent, "result");
    const result = { format, kind, id, name, owner: container || owner, key, text: null, position: n.position,
      turnIndex: turn, occurrenceTurnIndex: turn, occurrenceBatchIndex, batchIndex: null, isCurrentTurn: false,
      isRecentTurn: false, isRecentToolBatch: false, isError: error, cacheProtected: false,
      resultContainer: owner, ancestors: [parent?.owner, owner].filter(Boolean), callOrdinal: null,
      representation, group, blockedReason: mixed ? "ambiguous_turn" : null };
    const allowed = family === "gemini" ? ["id", "name", "response", "status", "error", "is_error", "isError"] :
      family === "kiro" ? ["toolUseId", "content", "status", "error", "is_error", "isError"] :
        family === "claude" ? ["type", "tool_use_id", "content", "status", "error", "is_error", "isError", "cache_control"] :
          dialect === "responses" ? ["type", "call_id", "output", "id", "status", "error", "is_error", "isError"] :
            ["role", "tool_call_id", "content", "name", "status", "error", "is_error", "isError"];
    if (ownKeys(owner).some(field => !allowed.includes(field))) result.blockedReason ||= "structured_result";
    if (typeof container?.[key] === "string") result.text = container[key];
    else result.blockedReason ||= "structured_result";
    index.results.push(result);
    if (result.text !== null) segment(container, key, "tool", parent?.enclosingMessage || parent, n, "result_text", index.results.length - 1);
    if (result.text === null) {
      const leaves = Array.isArray(owner?.content) ? owner.content : Array.isArray(owner?.output) ? owner.output :
        Array.isArray(owner?.response?.content) ? owner.response.content : [];
      for (const part of leaves) {
        const child = node(part, n, parent?.enclosingMessage || parent, "result_block");
        segment(part, "text", "tool", parent?.enclosingMessage || parent, child, "result_text", index.results.length - 1);
      }
      for (const key of ["result", "output", "content"]) {
        const response = owner?.response;
        if (response && typeof response[key] === "string") segment(response, key, "tool", parent?.enclosingMessage || parent, n, "result_text", index.results.length - 1);
      }
    }
    return result;
  }
  function textResult(owner, parent, value, key, type, representation, kind, id, name, error, mixed, occurrenceBatchIndex = null) {
    if (typeof value?.[key] === "string") return addResult(owner, parent, value, key, representation, kind, id, name, error, mixed, occurrenceBatchIndex);
    const blocks = value?.[key];
    if (Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === type &&
      ownKeys(blocks[0]).every(k => k === "type" || k === "text") && typeof blocks[0].text === "string") {
      return addResult(owner, parent, blocks[0], "text", "single_text", kind, id, name, error, mixed, occurrenceBatchIndex);
    }
    return addResult(owner, parent, null, null, representation, kind, id, name, error, mixed, occurrenceBatchIndex);
  }
  try {
    const setup = Array.isArray(body.request?.contents) ? body.request : body;
    for (const tool of Array.isArray(setup.tools) ? setup.tools : []) node(tool, setup, null, "tool_definition");
    for (const key of ["system", "instructions", "developerInstruction", "systemInstruction"]) {
      if (setup[key] == null) continue;
      const instruction = setup[key];
      const n = node(instruction, setup, null, "instruction");
      const role = key === "developerInstruction" ? ROLE.DEVELOPER : ROLE.SYSTEM;
      segment(setup, key, role, null, n);
      const blocks = Array.isArray(instruction) ? instruction : Array.isArray(instruction?.parts) ? instruction.parts : [];
      for (const block of blocks) {
        const b = node(block, n, null, "instruction_block");
        segment(block, "text", role, null, b);
      }
    }
    if (dialect === "chat") {
      for (const message of body.messages) {
        const n = node(message, body, null, "message");
        n.enclosingMessage = n;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        if (message?.role === ROLE.USER) {
          endActiveBatch(n.position);
          turn++;
          segment(message, "content", message.role, n, n);
          for (const block of blocks) {
            const b = node(block, n, n, "block");
            if (block?.type === OPENAI_BLOCK.TEXT) segment(block, "text", message.role, n, b);
          }
        } else if (message?.role === ROLE.ASSISTANT) {
          const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          if (toolCalls.length > 0) {
            endActiveBatch(n.position);
            group++;
            startBatch();
            for (const call of toolCalls) {
              addCall("function", call?.function?.name, call?.id, call, n, activeBatchIndex);
            }
          } else {
            endActiveBatch(n.position);
          }
          segment(message, "content", message.role, n, n);
          for (const block of blocks) {
            const b = node(block, n, n, "block");
            if (block?.type === OPENAI_BLOCK.TEXT) segment(block, "text", message.role, n, b);
          }
        } else if (message?.role === ROLE.TOOL) {
          textResult(message, n, message, "content", OPENAI_BLOCK.TEXT, "string", "function", message.tool_call_id, null, failed(message), false, activeBatchIndex);
        } else {
          endActiveBatch(n.position);
          segment(message, "content", message.role, n, n);
          for (const block of blocks) {
            const b = node(block, n, n, "block");
            if (block?.type === OPENAI_BLOCK.TEXT) segment(block, "text", message.role, n, b);
          }
        }
      }
    } else if (family === "claude") {
      for (const message of body.messages) {
        const n = node(message, body, null, "message");
        n.enclosingMessage = n;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        if (message?.role === ROLE.USER) {
          const results = blocks.filter(b => b?.type === CLAUDE_BLOCK.TOOL_RESULT);
          if (results.length > 0) {
            const mixed = blocks.some(b => b?.type !== CLAUDE_BLOCK.TOOL_RESULT);
            if (mixed) diagnostics.ambiguousTurns++;
            for (const block of blocks) {
              const b = node(block, n, n, "block");
              if (block?.type === CLAUDE_BLOCK.TOOL_RESULT) {
                textResult(block, b, block, "content", CLAUDE_BLOCK.TEXT, "string", "function", block.tool_use_id, null, failed(block), mixed, activeBatchIndex);
              } else if (block?.type === CLAUDE_BLOCK.TEXT) {
                segment(block, "text", message.role, n, b);
              }
            }
          } else {
            endActiveBatch(n.position);
            turn++;
            segment(message, "content", message.role, n, n);
            for (const block of blocks) {
              const b = node(block, n, n, "block");
              if (block?.type === CLAUDE_BLOCK.TEXT) segment(block, "text", message.role, n, b);
            }
          }
        } else if (message?.role === ROLE.ASSISTANT) {
          const toolUses = blocks.filter(b => b?.type === CLAUDE_BLOCK.TOOL_USE);
          if (toolUses.length > 0) {
            endActiveBatch(n.position);
            group++;
            startBatch();
            for (const block of blocks) {
              if (block?.type === CLAUDE_BLOCK.TOOL_USE) {
                addCall("function", block.name, block.id, block, n, activeBatchIndex);
              } else if (block?.type === CLAUDE_BLOCK.TEXT) {
                const b = node(block, n, n, "block");
                segment(block, "text", message.role, n, b);
              }
            }
          } else {
            endActiveBatch(n.position);
            for (const block of blocks) {
              if (block?.type === CLAUDE_BLOCK.TEXT) {
                const b = node(block, n, n, "block");
                segment(block, "text", message.role, n, b);
              }
            }
          }
        } else {
          endActiveBatch(n.position);
          segment(message, "content", message.role, n, n);
          for (const block of blocks) {
            const b = node(block, n, n, "block");
            if (block?.type === CLAUDE_BLOCK.TEXT) segment(block, "text", message.role, n, b);
          }
        }
      }
    } else if (dialect === "responses") {
      for (const item of body.input) {
        const n = node(item, body, null, "item");
        n.enclosingMessage = n;
        const itemType = item?.type || (item?.role ? RESPONSES_ITEM.MESSAGE : null);
        if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(itemType)) {
          if (activeBatch && activeBatchPhase === "calls") {
            addCall(itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL ? "custom" : "function", item.name, item.call_id, item, n, activeBatchIndex);
          } else {
            endActiveBatch(n.position);
            group++;
            startBatch();
            activeBatchPhase = "calls";
            addCall(itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL ? "custom" : "function", item.name, item.call_id, item, n, activeBatchIndex);
          }
        } else if ([RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(itemType)) {
          if (activeBatch && activeBatchPhase === "calls") {
            activeBatchPhase = "results";
          }
          textResult(item, n, item, "output", RESPONSES_ITEM.INPUT_TEXT, "string",
            itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT ? "custom" : "function",
            item.call_id, null, failed(item), false, activeBatchIndex);
        } else if (itemType === RESPONSES_ITEM.REASONING) {
          if (activeBatch && activeBatchPhase === "results") {
            endActiveBatch(n.position);
          }
        } else {
          endActiveBatch(n.position);
          if (itemType === RESPONSES_ITEM.MESSAGE) {
            if (item.role === ROLE.USER) {
              if (!item?.type) diagnostics.responsesImplicitUserMessages++;
              turn++;
            }
            if (typeof item.content === "string") {
              segment(item, "content", item.role, n, n);
            }
            for (const block of Array.isArray(item?.content) ? item.content : []) {
              const b = node(block, n, n, "block");
              if ([RESPONSES_ITEM.INPUT_TEXT, RESPONSES_ITEM.OUTPUT_TEXT].includes(block?.type)) {
                segment(block, "text", item.role, n, b);
              }
            }
          }
        }
      }
    } else if (family === "gemini") {
      const contents = format === FORMATS.ANTIGRAVITY ? body.request?.contents : (body.request?.contents ?? body.contents);
      for (const message of contents) {
        const n = node(message, body.request ?? body, null, "message");
        n.enclosingMessage = n;
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const hasResults = parts.some(p => p?.functionResponse);
        const hasCalls = parts.some(p => p?.functionCall);
        if (message.role === GEMINI_ROLE.USER) {
          if (hasResults) {
            const mixed = parts.some(p => !p?.functionResponse);
            if (mixed) diagnostics.ambiguousTurns++;
            for (const part of parts) {
              const p = node(part, n, n, "part");
              if (part?.functionResponse) {
                const r = part.functionResponse;
                const response = r.response;
                const keys = ownKeys(response);
                const allowed = keys.length === 1 && ["result", "output", "content"].includes(keys[0]) && typeof response[keys[0]] === "string";
                addResult(r, p, typeof response === "string" ? r : allowed ? response : null,
                  typeof response === "string" ? "response" : allowed ? keys[0] : null,
                  typeof response === "string" ? "gemini_string" : allowed ? `gemini_${keys[0]}` : "structured",
                  "function", r.id, r.name, failed(r) || failed(response), mixed, activeBatchIndex);
              } else {
                segment(part, "text", message.role, n, p);
              }
            }
          } else {
            endActiveBatch(n.position);
            turn++;
            for (const part of parts) {
              const p = node(part, n, n, "part");
              segment(part, "text", message.role, n, p);
            }
          }
        } else if (message.role === GEMINI_ROLE.MODEL) {
          if (hasCalls) {
            endActiveBatch(n.position);
            group++;
            startBatch();
            for (const part of parts) {
              const p = node(part, n, n, "part");
              if (part?.functionCall) {
                addCall("function", part.functionCall.name, part.functionCall.id, part.functionCall, p, activeBatchIndex);
              } else {
                segment(part, "text", message.role, n, p);
              }
            }
          } else {
            endActiveBatch(n.position);
            for (const part of parts) {
              const p = node(part, n, n, "part");
              segment(part, "text", message.role, n, p);
            }
          }
        } else {
          endActiveBatch(n.position);
          for (const part of parts) {
            const p = node(part, n, n, "part");
            segment(part, "text", message.role, n, p);
          }
        }
      }
    } else {
      const state = body.conversationState;
      const history = [...(Array.isArray(state.history) ? state.history : []), ...(state.currentMessage ? [state.currentMessage] : [])];
      for (const message of history) {
        const n = node(message, state, null, "message");
        n.enclosingMessage = n;
        if (message?.assistantResponseMessage) {
          const uses = Array.isArray(message.assistantResponseMessage.toolUses) ? message.assistantResponseMessage.toolUses : [];
          if (uses.length > 0) {
            endActiveBatch(n.position);
            group++;
            startBatch();
            for (const use of uses) {
              addCall("function", use.name, use.toolUseId, use, n, activeBatchIndex);
            }
          } else {
            endActiveBatch(n.position);
          }
        }
        if (message?.userInputMessage) {
          const results = Array.isArray(message.userInputMessage.userInputMessageContext?.toolResults)
            ? message.userInputMessage.userInputMessageContext.toolResults
            : [];
          if (results.length > 0) {
            const content = message.userInputMessage.content;
            let mixed = false;
            if (typeof content === "string" && content.length > 0) mixed = true;
            else if (Array.isArray(content) && content.length > 0) mixed = true;
            if (mixed) diagnostics.ambiguousTurns++;
            for (const result of results) {
              const parts = result?.content;
              const single = Array.isArray(parts) && parts.length === 1 && ownKeys(parts[0]).length === 1 && typeof parts[0].text === "string";
              const r = addResult(result, n, single ? parts[0] : null, single ? "text" : null,
                "kiro_text", "function", result.toolUseId, null, failed(result), mixed, activeBatchIndex);
              if (message === state.currentMessage) r.blockedReason = "current";
            }
          } else {
            endActiveBatch(n.position);
            turn++;
          }
        }
      }
    }
    endActiveBatch(nodes.length);
    for (const batch of index.toolBatches) {
      if (batch.endPosition == null) batch.endPosition = nodes.length;
    }
    const ids = new Map();
    for (const [i, call] of index.calls.entries()) if (validId(call.id)) {
      const key = call.id;
      if (ids.has(key)) {
        call.ambiguous = true;
        const prevCall = index.calls[ids.get(key)];
        prevCall.ambiguous = true;
        if (call.batchIndex != null) index.toolBatches[call.batchIndex].tainted = true;
        if (prevCall.batchIndex != null) index.toolBatches[prevCall.batchIndex].tainted = true;
      } else {
        ids.set(key, i);
      }
    }
    const pendingByGroup = new Map();
    if (family === "gemini") for (const [i, call] of index.calls.entries()) {
      const groupCalls = pendingByGroup.get(call.group) ?? new Map();
      const entry = groupCalls.get(call.name);
      groupCalls.set(call.name, entry ? { ordinal: entry.ordinal, count: entry.count + 1 } : { ordinal: i, count: 1 });
      pendingByGroup.set(call.group, groupCalls);
    }
    const used = new Set();
    for (const result of index.results) {
      let ordinal = validId(result.id) ? ids.get(result.id) : undefined;
      if (ordinal === undefined && result.id == null && family === "gemini") {
        const pending = pendingByGroup.get(result.group)?.get(result.name);
        if (pending?.count === 1 && !used.has(pending.ordinal)) ordinal = pending.ordinal;
        else {
          result.blockedReason ||= "ambiguous_call";
          if (result.occurrenceBatchIndex != null) index.toolBatches[result.occurrenceBatchIndex].tainted = true;
        }
      }
      const call = ordinal != null ? index.calls[ordinal] : undefined;
      if (!call || typeof call.name !== "string" || !call.name) {
        result.blockedReason ||= "unlinked_call";
        if (result.occurrenceBatchIndex != null) index.toolBatches[result.occurrenceBatchIndex].tainted = true;
      } else if (call.ambiguous || call.kind !== result.kind || (result.name && call.name !== result.name)) {
        result.blockedReason ||= "ambiguous_call";
        if (call.batchIndex != null) index.toolBatches[call.batchIndex].tainted = true;
        if (result.occurrenceBatchIndex != null) index.toolBatches[result.occurrenceBatchIndex].tainted = true;
      } else if (used.has(ordinal)) {
        result.blockedReason ||= "ambiguous_call";
        if (call.batchIndex != null) index.toolBatches[call.batchIndex].tainted = true;
        if (result.occurrenceBatchIndex != null) index.toolBatches[result.occurrenceBatchIndex].tainted = true;
      } else {
        result.callOrdinal = ordinal;
        result.toolFamily = `${call.kind}:${call.name}`;
        result.batchIndex = call.batchIndex;
        used.add(ordinal);

        const ownerBatch = call.batchIndex != null ? index.toolBatches[call.batchIndex] : null;
        const sameBatch = call.batchIndex != null && result.occurrenceBatchIndex === call.batchIndex;
        const inInterval = ownerBatch != null &&
          result.position > ownerBatch.lastCallPosition &&
          result.position < ownerBatch.endPosition;
        const sameTurn = ownerBatch != null &&
          result.occurrenceTurnIndex === ownerBatch.turnIndex &&
          call.turnIndex === ownerBatch.turnIndex;

        if (sameBatch && inInterval && sameTurn && result.position > call.position) {
          ownerBatch.resultCount++;
        } else {
          if (ownerBatch) ownerBatch.tainted = true;
          if (result.occurrenceBatchIndex != null) index.toolBatches[result.occurrenceBatchIndex].tainted = true;
        }

        result.turnIndex = Math.max(call.turnIndex, result.turnIndex);
      }
      result.isCurrentTurn = turn >= 0 && result.turnIndex >= 0 && result.turnIndex === turn;
      result.isRecentTurn = turn >= 0 && result.turnIndex >= 0 && result.turnIndex >= turn - LIMIT.protectPreviousTurns;
    }
    for (const batch of index.toolBatches) {
      batch.completed = (
        batch.turnIndex >= 0 &&
        !batch.tainted &&
        batch.callCount > 0 &&
        batch.resultCount === batch.callCount
      );
    }
    if (turn >= 0) {
      const currentCompleted = index.toolBatches.filter(b => b.turnIndex === turn && b.completed);
      const recentWindow = currentCompleted.slice(-LIMIT.protectRecentToolBatches);
      const recentIndices = new Set(recentWindow.map(b => index.toolBatches.indexOf(b)));
      for (const result of index.results) {
        result.isRecentToolBatch = result.batchIndex != null && recentIndices.has(result.batchIndex);
      }
    } else {
      for (const result of index.results) {
        result.isRecentToolBatch = false;
      }
    }
    const currentCompletedCount = turn >= 0 ? index.toolBatches.filter(b => b.turnIndex === turn && b.completed).length : 0;
    const currentIncompleteCount = turn >= 0 ? index.toolBatches.filter(b => b.turnIndex === turn && !b.completed).length : 0;
    index.diagnostics = {
      userTurns: turn >= 0 ? turn + 1 : 0,
      responsesImplicitUserMessages: diagnostics.responsesImplicitUserMessages,
      currentCompletedToolBatches: currentCompletedCount,
      currentIncompleteToolBatches: currentIncompleteCount,
      ambiguousTurns: diagnostics.ambiguousTurns,
    };
    if (diagnostics.ambiguousTurns > 0) {
      index.blockedReason = "ambiguous_turn";
    }
    index.currentTurnIndex = turn;
    index.supported = true;
  } catch (error) {
    index.supported = false;
    index.blockedReason = error?.message === "metadata_budget" ? "metadata_budget" : "unsupported_shape";
    index.calls.length = index.results.length = index.textSegments.length = index.protocolNodes.length = index.toolBatches.length = 0;
    index.diagnostics = null;
  }
  return index;
}
