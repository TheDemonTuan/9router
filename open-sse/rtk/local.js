import { summarizeTestOutput } from "./testOutput.js";
// Command-aware companion to the pinned Rust pipe filters. Unlike a generic
// text fallback, each formatter below validates the output shape it consumes.
const grepLine = /^([^:\r\n]+):([0-9]+):(.*)$/;
const pathLine = /^[^\s:\r\n][^:\r\n]*\/[^:\r\n]+$/;
const failure = /\b(?:FAIL(?:ED)?|ERROR|Error:|Exception:|Traceback|warning:|WARN(?:ING)?|panic:|not ok)\b/i;

export function isGrepOutput(text) {
  return !text.includes("\u001b") && text.replace(/\r?\n$/, "").split(/\r?\n/).every(line => grepLine.test(line) && !/^[A-Za-z]:/.test(line));
}

export function inspectNativeGrepOutput(text) {
  if (typeof text !== "string" || !text.isWellFormed() || /[\0\u001b]|\r(?!\n)/.test(text)) return "unknown";
  if (isGrepOutput(text)) return "flat_numbered";
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  let matches = 0;
  let groups = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^(\d+):(.*)$/.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (!groups || !Number.isSafeInteger(number) || number <= 0) return "unknown";
      matches++;
    } else {
      if (line === "") {
        if (!matches || i === lines.length - 1 || lines[i + 1] === "") return "unknown";
        // A separator must be followed by a new path, not another match row.
        if (/^\d+:/.test(lines[i + 1])) return "unknown";
        continue;
      }
      if (groups && !matches || !line.includes("/") || /^\s/.test(line) || /[:\x00-\x1f\x7f]/.test(line)) return "unknown";
      groups++;
      matches = 0;
    }
  }
  return groups > 0 && matches > 0 ? "heading_numbered" : "unknown";
}

export function isPathOutput(text) {
  return !text.includes("\u001b") && text.replace(/\r?\n$/, "").split(/\r?\n/).every(line => pathLine.test(line));
}

export function exceedsPipeGrepCap(text) {
  const counts = new Map();
  for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const file = grepLine.exec(line)?.[1];
    const count = (counts.get(file) ?? 0) + 1;
    if (count > 10) return true;
    counts.set(file, count);
  }
  return false;
}

function group(text, pattern, groupLabel) {
  let previous;
  const output = [];
  for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) return null;
    if (match[1] !== previous) {
      previous = match[1];
      output.push(`${groupLabel} ${previous}`);
    }
    output.push(match[2]);
  }
  return output.join("\n");
}

function search(text) {
  if (!isGrepOutput(text)) return inspectNativeGrepOutput(text) === "heading_numbered" ? text : null;
  return group(text, /^([^:\r\n]+):([0-9]+:.*)$/, "[file]");
}

function paths(text) {
  if (!isPathOutput(text)) return null;
  // Grouping saves bytes by stripping repeated directory prefixes. If there
  // are no slashes to group, prepending [cwd] only adds bytes and is rejected.
  return group(text, /^(.*\/)([^\r\n]+)$/, "[dir]");
}

function gitLog(text) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const starts = lines.flatMap((line, index) => /^commit [0-9a-f]{40,64}(?: \(.*\))?$/.test(line) ? [index] : []);
  if (!starts.length || starts[0] !== 0) return null;
  const output = [];
  for (let i = 0; i < starts.length; i++) {
    const block = lines.slice(starts[i], starts[i + 1] ?? lines.length);
    let lineIdx = 1;
    let mergeLine = null;
    if (/^Merge: (?:[0-9a-f]{7,64} ){1,}[0-9a-f]{7,64}$/.test(block[lineIdx] ?? "")) {
      mergeLine = block[lineIdx++];
    }
    const author = block[lineIdx++];
    const date = block[lineIdx++];
    if (!author || !/^Author: /.test(author) || !date || !/^Date:\s+/.test(date) || block[lineIdx] !== "") return null;
    const rawBody = block.slice(lineIdx + 1);
    if (rawBody.some(line => line !== "" && !line.startsWith("    "))) return null;
    const message = rawBody.filter(Boolean).map(line => line.slice(4));
    if (!message.length) return null;
    const headers = [block[0]];
    if (mergeLine) headers.push(mergeLine);
    headers.push(author, date);
    output.push(`${headers.join("\n")}\n  ${message[0]}`);
    for (const line of message.slice(1, 4)) output.push(`  ${line}`);
    if (message.length > 4) output.push(`  [+${message.length - 4} message lines omitted]`);
  }
  return output.join("\n");
}

const testSummary = summarizeTestOutput;

function cargoBuild(text) {
  if (failure.test(text)) return null;
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (!lines.some(line => /^\s*Finished\s+(?:dev|release|test|bench)\s+\[/.test(line))) return null;
  let compiled = 0;
  const output = lines.filter(line => {
    if (/^\s*(?:Compiling|Checking|Building)\s+\S+/.test(line)) { compiled++; return false; }
    return true;
  });
  if (!compiled) return text;
  output.unshift(`[${compiled} crates compiled or checked]`);
  return output.join("\n");
}

function dockerPs(text) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) return null;
  const columns = [...(lines[0] ?? "").matchAll(/\S(?:.*?\S)?(?= {2,}|$)/g)];
  if (columns.map(column => column[0]).join("|") !== "CONTAINER ID|IMAGE|COMMAND|CREATED|STATUS|PORTS|NAMES" || lines.length < 2) return null;
  // Slicing by header offsets is safe only for Docker's default aligned
  // table. Reject ambiguous widths rather than reassigning column values.
  const rows = lines.map(line => columns.map((column, index) =>
    line.slice(column.index, columns[index + 1]?.index).trim()));
  if (rows.slice(1).some(row => !/^[a-f0-9]{12,64}$/.test(row[0]) || !/^\S+$/.test(row[1]) ||
      !/^".*"$/.test(row[2]) || !/^\d+ (?:second|minute|hour|day|week|month|year)s? ago$/.test(row[3]) ||
      !/^(?:Up|Exited|Created|Restarting|Paused|Dead)(?:\b|$)/.test(row[4]) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row[6]))) return null;
  return rows.map(row => row.join("\t")).join("\n");
}

function repeatedLogs(text) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (end < lines.length && lines[end] === lines[i]) end++;
    output.push(lines[i]);
    if (end - i > 1) output.push(`[previous line repeated ${end - i - 1} times]`);
    i = end;
  }
  return output.join("\n");
}

function listing(text) {
  // Never collapse tree indentation or path characters. SGR only encodes
  // terminal color; all file names and directory boundaries remain intact.
  if (text.includes("\u001b]")) return null;
  return text.includes("\u001b[")
    ? text.replace(/\u001b\[[0-9;]*m/g, "")
    : text;
}

function status(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).join("\n");
}

const formatters = {
  "git-log": gitLog,
  grep: search,
  find: paths,
  test: testSummary,
  "cargo-build": cargoBuild,
  "docker-ps": dockerPs,
  "docker-logs": repeatedLogs,
  listing,
  "git-status": status,
};

export function filterLocalOutput(filter, content, onOutcome) {
  if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0")) {
    onOutcome?.("invalid_text", 0, "none");
    return null;
  }
  const format = formatters[filter];
  if (!format) {
    onOutcome?.("format_not_accepted", 0, "none");
    return null;
  }
  let output;
  let detail = "none";
  try {
    output = filter === "test" ? format(content, value => { detail = value; }) : format(content);
  } catch {
    onOutcome?.("failed", 0, detail);
    return null;
  }
  if (output === null || output === undefined) {
    onOutcome?.("format_not_accepted", 0, detail);
    return null;
  }
  if (output === "") {
    onOutcome?.("empty_output", 0, detail);
    return null;
  }
  const inputBytes = Buffer.byteLength(content);
  const outputBytes = Buffer.byteLength(output);
  if (outputBytes >= inputBytes) {
    onOutcome?.("not_smaller", outputBytes, detail);
    return null;
  }
  onOutcome?.("candidate", outputBytes, detail);
  return output;
}
