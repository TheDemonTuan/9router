// open-sse/rtk/headroomInvariants.js
// Guard body invariants across Headroom gateway operations.
// Only text fields may be altered by compression.
// Any breach in structure, IDs, order, tool pairing, reasoning or arguments syntax
// invalidates the compression result and triggers an immediate fail-open bypass.

function isValidJson(str) {
  if (typeof str !== "string") return false;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

export function validateBodyInvariants(original, compressed, format) {
  if (!original || !compressed || typeof compressed !== "object") {
    return { valid: false, reason: "missing_compressed_body" };
  }

  // 1. OpenAI Chat completions format
  if (Array.isArray(original.messages)) {
    if (!Array.isArray(compressed.messages)) {
      return { valid: false, reason: "missing_messages_array" };
    }
    if (compressed.messages.length !== original.messages.length) {
      return { valid: false, reason: "messages_count_mismatch" };
    }

    for (let i = 0; i < original.messages.length; i++) {
      const origMsg = original.messages[i];
      const compMsg = compressed.messages[i];
      if (!compMsg || compMsg.role !== origMsg.role) {
        return { valid: false, reason: `message_role_or_order_mismatch_at_${i}` };
      }

      // Preserve tool_call_id
      if (origMsg.tool_call_id && compMsg.tool_call_id !== origMsg.tool_call_id) {
        return { valid: false, reason: `tool_call_id_mismatch_at_${i}` };
      }

      // Preserve tool_calls structure
      if (Array.isArray(origMsg.tool_calls)) {
        if (!Array.isArray(compMsg.tool_calls) || compMsg.tool_calls.length !== origMsg.tool_calls.length) {
          return { valid: false, reason: `tool_calls_count_mismatch_at_${i}` };
        }
        for (let t = 0; t < origMsg.tool_calls.length; t++) {
          const origCall = origMsg.tool_calls[t];
          const compCall = compMsg.tool_calls[t];
          if (compCall.id !== origCall.id) {
            return { valid: false, reason: `tool_call_id_mismatch_at_${i}_${t}` };
          }
          if (compCall.function?.name !== origCall.function?.name) {
            return { valid: false, reason: `tool_call_name_mismatch_at_${i}_${t}` };
          }
          // Arguments must remain valid JSON if original was valid JSON
          if (origCall.function?.arguments && isValidJson(origCall.function.arguments)) {
            if (!isValidJson(compCall.function?.arguments)) {
              return { valid: false, reason: `tool_call_arguments_invalid_json_at_${i}_${t}` };
            }
          }
        }
      }

      // Preserve reasoning/thinking if present
      if (origMsg.reasoning_content && !compMsg.reasoning_content) {
        return { valid: false, reason: `reasoning_content_dropped_at_${i}` };
      }
    }
  }

  // 2. OpenAI Responses format (Codex input[])
  if (Array.isArray(original.input)) {
    if (!Array.isArray(compressed.input)) {
      return { valid: false, reason: "missing_responses_input_array" };
    }
    if (compressed.input.length !== original.input.length) {
      return { valid: false, reason: "responses_input_count_mismatch" };
    }

    for (let i = 0; i < original.input.length; i++) {
      const origItem = original.input[i];
      const compItem = compressed.input[i];
      if (!compItem || compItem.type !== origItem.type) {
        return { valid: false, reason: `responses_item_type_mismatch_at_${i}` };
      }

      if (origItem.type === "reasoning") {
        if (origItem.encrypted_content && compItem.encrypted_content !== origItem.encrypted_content) {
          return { valid: false, reason: `reasoning_encrypted_content_altered_at_${i}` };
        }
      }

      if (origItem.type === "function_call" || origItem.type === "custom_tool_call") {
        if (compItem.call_id !== origItem.call_id) {
          return { valid: false, reason: `responses_tool_call_id_mismatch_at_${i}` };
        }
        if (compItem.name !== origItem.name) {
          return { valid: false, reason: `responses_tool_call_name_mismatch_at_${i}` };
        }
        if (origItem.arguments && isValidJson(origItem.arguments)) {
          if (!isValidJson(compItem.arguments)) {
            return { valid: false, reason: `responses_tool_call_arguments_invalid_json_at_${i}` };
          }
        }
      }

      if (origItem.type === "function_call_output" || origItem.type === "custom_tool_call_output") {
        if (compItem.call_id !== origItem.call_id) {
          return { valid: false, reason: `responses_tool_output_call_id_mismatch_at_${i}` };
        }
      }
    }
  }

  // 3. Claude format
  if (format === "claude" && Array.isArray(original.messages)) {
    for (let i = 0; i < original.messages.length; i++) {
      const origMsg = original.messages[i];
      const compMsg = compressed.messages?.[i];
      if (Array.isArray(origMsg.content) && Array.isArray(compMsg?.content)) {
        for (let c = 0; c < origMsg.content.length; c++) {
          const origPart = origMsg.content[c];
          const compPart = compMsg.content[c];
          if (origPart?.type === "tool_result") {
            if (compPart?.type !== "tool_result") {
              return { valid: false, reason: `claude_tool_result_dropped_at_${i}_${c}` };
            }
            if (compPart.tool_use_id !== origPart.tool_use_id) {
              return { valid: false, reason: `claude_tool_use_id_mismatch_at_${i}_${c}` };
            }
            if (Boolean(origPart.is_error) !== Boolean(compPart.is_error)) {
              return { valid: false, reason: `claude_tool_is_error_altered_at_${i}_${c}` };
            }
          }
          if (origPart?.type === "tool_use") {
            if (compPart?.type !== "tool_use" || compPart.id !== origPart.id) {
              return { valid: false, reason: `claude_tool_use_altered_at_${i}_${c}` };
            }
          }
          if (origPart?.type === "thinking") {
            if (compPart?.type !== "thinking") {
              return { valid: false, reason: `claude_thinking_dropped_at_${i}_${c}` };
            }
            if (origPart.signature && compPart.signature !== origPart.signature) {
              return { valid: false, reason: `claude_thinking_signature_altered_at_${i}_${c}` };
            }
            if (origPart.thinking && compPart.thinking !== origPart.thinking) {
              return { valid: false, reason: `claude_thinking_content_altered_at_${i}_${c}` };
            }
          }
          if (origPart?.type === "redacted_thinking") {
            if (compPart?.type !== "redacted_thinking" || compPart.data !== origPart.data) {
              return { valid: false, reason: `claude_redacted_thinking_altered_at_${i}_${c}` };
            }
          }
        }
      }
    }
  }

  return { valid: true };
}
