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
  const index = { format, supported: false, blockedReason: null, results: [], calls: [], textSegments: [], protocolNodes: [], currentTurnIndex: -1 };
  if (!object(body)) { index.blockedReason = "unsupported_shape"; return index; }
  const shapes = [Array.isArray(body.messages), Array.isArray(body.input), Array.isArray(body.contents),
    Array.isArray(body.request?.contents), object(body.conversationState)].filter(Boolean).length;
  const family = format === FORMATS.CLAUDE ? "claude" : format === FORMATS.KIRO ? "kiro"
    : [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format) ? "gemini"
      : [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX].includes(format) ? "openai" : null;
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
  function addCall(kind, name, id, owner, parent) {
    if (index.calls.length >= LIMIT.maxEntries) throw Error("metadata_budget");
    const n = node(owner, parent, parent?.enclosingMessage || parent, "call");
    index.calls.push({ kind, name, id, position: n.position, turnIndex: turn, group, ambiguous: false });
  }
  function addResult(owner, parent, container, key, representation, kind, id, name, error, mixed = false) {
    if (index.results.length >= LIMIT.maxEntries) throw Error("metadata_budget");
    const n = node(owner, parent, parent?.enclosingMessage || parent, "result");
    const result = { format, kind, id, name, owner: container || owner, key, text: null, position: n.position,
      turnIndex: turn, isCurrentTurn: false, isRecentTurn: false, isError: error, cacheProtected: false,
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
  function textResult(owner, parent, value, key, type, representation, kind, id, name, error, mixed) {
    if (typeof value?.[key] === "string") return addResult(owner, parent, value, key, representation, kind, id, name, error, mixed);
    const blocks = value?.[key];
    if (Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === type &&
      ownKeys(blocks[0]).every(k => k === "type" || k === "text") && typeof blocks[0].text === "string") {
      return addResult(owner, parent, blocks[0], "text", "single_text", kind, id, name, error, mixed);
    }
    return addResult(owner, parent, null, null, representation, kind, id, name, error, mixed);
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
    if (dialect === "chat" || family === "claude") {
      for (const message of body.messages) {
        const n = node(message, body, null, "message");
        n.enclosingMessage = n;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        const results = family === "claude" ? blocks.filter(b => b?.type === CLAUDE_BLOCK.TOOL_RESULT) : [];
        const mixed = message?.role === ROLE.USER && results.length > 0 && (blocks.length !== results.length);
        if (message?.role === ROLE.USER && (family !== "claude" ? true : !results.length)) turn++;
        if (message?.role === ROLE.ASSISTANT) {
          group++;
          if (family === "claude") for (const block of blocks) if (block?.type === CLAUDE_BLOCK.TOOL_USE) addCall("function", block.name, block.id, block, n);
          if (family !== "claude") for (const call of message.tool_calls ?? []) addCall("function", call?.function?.name, call?.id, call, n);
        }
        if (family === "claude") {
          for (const block of blocks) {
            const b = node(block, n, n, "block");
            if (block?.type === CLAUDE_BLOCK.TOOL_RESULT)
              textResult(block, b, block, "content", CLAUDE_BLOCK.TEXT, "string", "function", block.tool_use_id, null, failed(block), mixed);
            else if (block?.type === CLAUDE_BLOCK.TEXT) segment(block, "text", message.role, n, b);
          }
        } else if (message?.role === ROLE.TOOL) {
          textResult(message, n, message, "content", OPENAI_BLOCK.TEXT, "string", "function", message.tool_call_id, null, failed(message));
        } else {
          segment(message, "content", message.role, n, n);
          for (const block of blocks) { const b = node(block, n, n, "block"); if (block?.type === OPENAI_BLOCK.TEXT) segment(block, "text", message.role, n, b); }
        }
      }
    } else if (dialect === "responses") {
      for (const item of body.input) {
        const n = node(item, body, null, "item"); n.enclosingMessage = n;
        if (item?.type === RESPONSES_ITEM.MESSAGE && item.role === ROLE.USER) turn++;
        if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type)) {
          group++;
          addCall(item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL ? "custom" : "function", item.name, item.call_id, item, n);
        }
        if ([RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(item?.type))
          textResult(item, n, item, "output", RESPONSES_ITEM.INPUT_TEXT, "string", item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT ? "custom" : "function", item.call_id, null, failed(item));
        else for (const block of Array.isArray(item?.content) ? item.content : []) {
          const b = node(block, n, n, "block");
          if ([RESPONSES_ITEM.INPUT_TEXT, RESPONSES_ITEM.OUTPUT_TEXT].includes(block?.type)) segment(block, "text", item.role, n, b);
        }
      }
    } else if (family === "gemini") {
      for (const message of body.request?.contents ?? body.contents) {
        const n = node(message, body.request ?? body, null, "message"); n.enclosingMessage = n;
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const hasResults = parts.some(p => p?.functionResponse);
        const mixed = hasResults && parts.some(p => !p?.functionResponse);
        if (message.role === GEMINI_ROLE.USER && !hasResults) turn++;
        if (message.role === GEMINI_ROLE.MODEL) group++;
        for (const part of parts) {
          const p = node(part, n, n, "part");
          if (part?.functionCall) addCall("function", part.functionCall.name, part.functionCall.id, part.functionCall, p);
          if (part?.functionResponse) {
            const r = part.functionResponse;
            const response = r.response;
            const keys = ownKeys(response);
            const allowed = keys.length === 1 && ["result", "output", "content"].includes(keys[0]) && typeof response[keys[0]] === "string";
            addResult(r, p, typeof response === "string" ? r : allowed ? response : null,
              typeof response === "string" ? "response" : allowed ? keys[0] : null,
              typeof response === "string" ? "gemini_string" : allowed ? `gemini_${keys[0]}` : "structured",
              "function", r.id, r.name, failed(r) || failed(response), mixed);
          } else segment(part, "text", message.role, n, p);
        }
      }
    } else {
      const state = body.conversationState;
      const history = [...(Array.isArray(state.history) ? state.history : []), ...(state.currentMessage ? [state.currentMessage] : [])];
      for (const message of history) {
        const n = node(message, state, null, "message"); n.enclosingMessage = n;
        const uses = message?.assistantResponseMessage?.toolUses ?? [];
        const results = message?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
        if (message?.userInputMessage && !results.length) turn++;
        if (uses.length) group++;
        for (const use of uses) addCall("function", use.name, use.toolUseId, use, n);
        for (const result of results) {
          const parts = result?.content;
          const single = Array.isArray(parts) && parts.length === 1 && ownKeys(parts[0]).length === 1 && typeof parts[0].text === "string";
          const r = addResult(result, n, single ? parts[0] : null, single ? "text" : null,
            "kiro_text", "function", result.toolUseId, null, failed(result), false);
          if (message === state.currentMessage) r.blockedReason = "current";
        }
      }
    }
    const ids = new Map();
    for (const [i, call] of index.calls.entries()) if (validId(call.id)) {
      const key = call.id;
      if (ids.has(key)) { call.ambiguous = true; index.calls[ids.get(key)].ambiguous = true; }
      else ids.set(key, i);
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
        else result.blockedReason ||= "ambiguous_call";
      }
      const call = index.calls[ordinal];
      if (!call || typeof call.name !== "string" || !call.name) result.blockedReason ||= "unlinked_call";
      else if (call.ambiguous || call.kind !== result.kind || used.has(ordinal) || (result.name && call.name !== result.name)) result.blockedReason ||= "ambiguous_call";
      else { result.callOrdinal = ordinal; result.toolFamily = `${call.kind}:${call.name}`; result.turnIndex = Math.max(call.turnIndex, result.turnIndex); used.add(ordinal); }
      result.isCurrentTurn = result.turnIndex === turn;
      result.isRecentTurn = result.turnIndex >= turn - LIMIT.protectPreviousTurns;
    }
    index.currentTurnIndex = turn;
    index.supported = true;
  } catch (error) {
    index.supported = false;
    index.blockedReason = error?.message === "metadata_budget" ? "metadata_budget" : "unsupported_shape";
    index.calls.length = index.results.length = index.textSegments.length = index.protocolNodes.length = 0;
  }
  return index;
}
