// Content-block "type" discriminators — fixed per format. Pure data (no logic).

// OpenAI chat content blocks + tool_call wrapper.
export const OPENAI_BLOCK = {
  TEXT: "text",
  IMAGE_URL: "image_url",
  IMAGE: "image",
  INPUT_AUDIO: "input_audio",
  AUDIO_URL: "audio_url",
  FILE: "file",
  FUNCTION: "function",
};

// Claude content blocks.
export const CLAUDE_BLOCK = {
  TEXT: "text",
  IMAGE: "image",
  DOCUMENT: "document",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
  THINKING: "thinking",
  REDACTED_THINKING: "redacted_thinking",
  SERVER_TOOL_USE: "server_tool_use",
  WEB_SEARCH_TOOL_RESULT: "web_search_tool_result",
};

// OpenAI Responses API item types.
export const RESPONSES_ITEM = {
  MESSAGE: "message",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL: "custom_tool_call",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
  ADDITIONAL_TOOLS: "additional_tools",
  REASONING: "reasoning",
  OUTPUT_TEXT: "output_text",
  INPUT_TEXT: "input_text",
  INPUT_IMAGE: "input_image",
  SUMMARY_TEXT: "summary_text",
  LOCAL_SHELL_CALL: "local_shell_call",
  TOOL_SEARCH_CALL: "tool_search_call",
  TOOL_SEARCH_CALL_OUTPUT: "tool_search_call_output",
  WEB_SEARCH_CALL: "web_search_call",
  IMAGE_GENERATION_CALL: "image_generation_call",
  COMPACTION: "compaction",
  COMPACTION_TRIGGER: "compaction_trigger",
  CONFIGURATION_UPDATE: "configuration_update",
  INPUT_FILE: "input_file",
};

// Valid OpenAI block types (used by filterToOpenAIFormat).
export const VALID_OPENAI_CONTENT_TYPES = [
  OPENAI_BLOCK.TEXT, OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.IMAGE, OPENAI_BLOCK.INPUT_AUDIO, OPENAI_BLOCK.AUDIO_URL, OPENAI_BLOCK.FILE,
];
export const VALID_OPENAI_MESSAGE_TYPES = [
  OPENAI_BLOCK.TEXT, OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.IMAGE, "tool_calls", CLAUDE_BLOCK.TOOL_RESULT,
];
