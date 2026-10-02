import { TOKEN_SAVER_CONFIG as LIMIT } from "../config/tokenSaverConfig.js";
// Offsets are JS string offsets. Never normalize the body or wire envelope.
const headerLF = /^(?:Chunk ID: [^\r\n]+\n)?Wall time: (?:\d+(?:\.\d+)?) seconds\nProcess exited with code 0\n(?:Original token count: \d+\n)?Output:\n/;
const headerCRLF = /^(?:Chunk ID: [^\r\n]+\r\n)?Wall time: (?:\d+(?:\.\d+)?) seconds\r\nProcess exited with code 0\r\n(?:Original token count: \d+\r\n)?Output:\r\n/;
const unsafeBody = /(?:truncat(?:ed|ion)|\b(?:omitted|omission)\b|<persisted-output>|Process running with session ID|^Wall time:|^Chunk ID:|^Process exited with code|^Original token count:|^Output:|^Final output:|^Hook context:|^Background task|^Interrupted by user)/im;

export function preservesToolOutput(text) {
  return typeof text === "string" && (text.includes("<persisted-output>") || /^(?:Hook context:|Background task|Interrupted by user|Exit code [1-9])/m.test(text) || /^\s*\{[\s\S]*"(?:structuredContent|code_execution_result)"/.test(text));
}

export function inspectToolOutput(text, call, onReject) {
  if (typeof text !== "string" || call?.ambiguous || call?.name?.split(".").at(-1) !== "exec_command") return null;
  let input = call.input;
  if (typeof input === "string") {
    if (input.length > LIMIT.maxToolMetadataBytes || Buffer.byteLength(input) > LIMIT.maxToolMetadataBytes) { onReject?.("metadata"); return null; }
    try { input = JSON.parse(input); } catch { onReject?.("metadata"); return null; }
  }
  if (!input || Array.isArray(input) || typeof input.cmd !== "string" || (input.command != null && input.command !== input.cmd)) {
    onReject?.("metadata"); return null;
  }
  // Plain exec output remains raw; only an actual envelope attempt is rejected.
  if (!/^(?:Chunk ID:|Wall time:|Process (?:exited|running)|Original token count:|Output:|Final output:)/.test(text)) return null;
  const prefix = text.slice(0, LIMIT.maxToolEnvelopeChars);
  const header = headerLF.exec(prefix) ?? headerCRLF.exec(prefix);
  if (!header) { onReject?.("grammar"); return null; }
  const bodyStart = header[0].length;
  if (!text.isWellFormed() || unsafeBody.test(text.slice(bodyStart)) || /^Warning:/m.test(text.slice(bodyStart))) { onReject?.("unsafe_body"); return null; }
  return { kind: "codex_exec", bodyStart, bodyEnd: text.length, completed: true, truncated: false };
}

export function replaceToolOutputBody(text, descriptor, body) {
  return text.slice(0, descriptor.bodyStart) + body + text.slice(descriptor.bodyEnd);
}
