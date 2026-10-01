import { exceedsPipeGrepCap, isGrepOutput, isPathOutput, inspectNativeGrepOutput } from "./local.js";
import { RTK_COMMAND_FAMILIES } from "../config/rtkConfig.js";
import { isPassingVitestJson } from "./testOutput.js";

const commandFamilies = new Set(RTK_COMMAND_FAMILIES);
const testScripts = new Set(["test", "test:unit", "test:integration", "test:e2e"]);
const isTestScript = argv => argv[1] === "test" || argv[1] === "run" && testScripts.has(argv[2]);
function commandFamily(executable, argv) {
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) return `${executable} ${isTestScript(argv) ? "test" : "other"}`;
  if (executable === "node") return `node ${argv.includes("--test") ? "test" : "other"}`;
  const subcommands = { git: ["diff", "status", "log"], cargo: ["test", "build"], go: ["test", "build"], docker: ["ps", "logs"], ruff: ["check", "format"], sqlfluff: ["lint"] };
  if (subcommands[executable]) {
    let i = 1;
    if (executable === "git") while (i < argv.length) {
      if (["--no-pager", "--no-optional-locks"].includes(argv[i])) i++;
      else if (["-C", "-c"].includes(argv[i]) && argv[i + 1]) i += 2;
      else break;
    }
    return `${executable} ${subcommands[executable].includes(argv[i]) ? argv[i] : "other"}`;
  }
  return commandFamilies.has(executable) ? executable : "other";
}

const shellTools = new Set(["bash", "shell", "terminal", "run_terminal_cmd", "exec_command", "execute_bash", "run_command"]);
const direct = new Map(Object.entries({ pytest: "pytest", ctest: "ctest", tsc: "tsc", vitest: "vitest", mypy: "mypy", prettier: "prettier", phpunit: "phpunit", pest: "pest", paratest: "paratest", ecs: "ecs", phpstan: "phpstan", pint: "pint" }));
const grepFlags = new Set(["-n", "-H", "-r", "-R", "-i", "-w", "-F", "-E", "--line-number", "--with-filename", "--recursive", "--ignore-case", "--word-regexp", "--fixed-strings", "--extended-regexp", "--no-heading", "--hidden", "--no-ignore", "--color=never"]);
const grepValues = new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type"]);
const findValues = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth"]);
const fdFlags = new Set(["--hidden", "--no-ignore", "--absolute-path", "--full-path", "--glob", "--fixed-strings", "--case-sensitive", "--ignore-case"]);
const fdValues = new Set(["-e", "--extension", "-t", "--type", "-d", "--max-depth"]);

function tokenize(command) {
  const segments = [], argv = [];
  let word = "", quote = "", started = false;
  const flush = () => { if (started) argv.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (/[\0\r\n]/.test(char)) return null;
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
    } else {
      if (char === "\\" && (/[\s'"\\;|&<>`$()]/.test(command[i + 1] ?? "") || i + 1 === command.length)) return null;
      if (quote === '"') {
        if (char === '"') quote = "";
        else if (char === "$" || char === "`") return null;
        else word += char;
      } else if (char === "'" || char === '"') { quote = char; started = true; }
      else if (char === "&" && command[i + 1] === "&" && segments.length === 0) {
        flush();
        if (!argv.length) return null;
        segments.push(argv.splice(0));
        i++;
      } else if (/[;|&<>`$()]/.test(char) || (char === "#" && !started)) return null;
      else if (/\s/.test(char)) flush();
      else { word += char; started = true; }
    }
  }
  if (quote) return null;
  flush();
  if (!argv.length) return null;
  segments.push(argv);
  return segments;
}

function options(argv, flags, values, combined = "") {
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positional || !arg.startsWith("-") || arg === "-") continue;
    if (arg === "--") { positional = true; continue; }
    if (flags.has(arg) || (combined && /^-[^-]+$/.test(arg) && [...arg.slice(1)].every(c => combined.includes(c)))) continue;
    if (values.has(arg)) { if (!argv[++i] || argv[i].startsWith("-")) return false; continue; }
    if ([...values].some(v => v.startsWith("--") && arg.startsWith(v + "=") && arg.length > v.length + 1)) continue;
    return false;
  }
  return true;
}

function jsonLines(text) {
  try { return text.trim().split(/\r?\n/).every(line => { const value = JSON.parse(line); return !Array.isArray(value) && value && typeof value.Action === "string"; }); }
  catch { return false; }
}
function jsonArray(text) {
  try { return Array.isArray(JSON.parse(text)); } catch { return false; }
}
function formatFlag(argv, name, value) {
  const positions = argv.flatMap((arg, i) => arg === name || arg.startsWith(name + "=") ? [i] : []);
  if (positions.length !== 1 || argv.slice(0, positions[0]).includes("--")) return false;
  return argv[positions[0]] === name
    ? argv[positions[0] + 1] === value
    : argv[positions[0]] === `${name}=${value}`;
}

function reject(onReject, reason, detail = "none") { onReject?.(reason, detail); return null; }

export function getRtkToolFamily(call) {
  if (!call || call.ambiguous) return "unlinked";
  if (typeof call.name !== "string" || call.name.length > 128) return "other";
  const name = call.name.split(".").at(-1).toLowerCase();
  if (shellTools.has(name)) return "shell";
  if (name === "grep") return "grep";
  if (name === "glob") return "glob";
  if (name === "read" || name === "read_file" || name === "readfile") return "read";
  if (name === "edit" || name === "edit_file" || name === "apply_patch") return "edit";
  if (name === "write" || name === "write_file" || name === "write_to_file") return "write";
  return "other";
}

export function classifyToolCall(call, content, onReject, onCommand, onNativeShape) {
  if (!call) return reject(onReject, "unlinked_call");
  if (typeof call.name !== "string" || typeof content !== "string") return reject(onReject, "invalid_command_metadata");
  const family = getRtkToolFamily(call);
  if (family === "unlinked") return reject(onReject, "unlinked_call");
  if (["read", "edit", "write", "other"].includes(family)) return reject(onReject, "not_applicable_tool");
  const tool = call.name.split(".").at(-1).toLowerCase();
  let input = call.input;
  if (typeof input === "string" && shellTools.has(tool)) {
    if (input.trimStart().startsWith("{")) {
      if (Buffer.byteLength(input) > 8192) return reject(onReject, "metadata_limit", "serialized_metadata_limit");
      try { input = JSON.parse(input); } catch { return reject(onReject, "invalid_command_metadata"); }
    } else input = { command: input };
  } else if (typeof input === "string") {
    if (Buffer.byteLength(input) > 8192) return reject(onReject, "metadata_limit", "serialized_metadata_limit");
    try { input = JSON.parse(input); } catch { return reject(onReject, "invalid_command_metadata"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(onReject, family === "grep" || family === "glob" ? "native_metadata_missing" : "invalid_command_metadata");
  if (typeof input.command === "string" && typeof input.cmd === "string" && input.command !== input.cmd) return reject(onReject, "invalid_command_metadata");
  const command = input.command ?? input.cmd;
  if (typeof command !== "string") {
    if (tool === "grep") {
      const hasMetadata = typeof input.path === "string" && typeof input.pattern === "string" && !input.command && !input.cmd;
      if (!hasMetadata) return reject(onReject, "native_metadata_missing", "native_metadata_missing");
      const shape = inspectNativeGrepOutput(content);
      onNativeShape?.(shape);
      return shape !== "unknown" ? "local:grep" : reject(onReject, "unsupported_output_format", "native_output_mismatch");
    }
    if (tool === "glob") {
      const hasMetadata = typeof input.path === "string" && !input.command && !input.cmd;
      if (!hasMetadata) return reject(onReject, "native_metadata_missing", "native_metadata_missing");
      return isPathOutput(content) ? "local:find" : reject(onReject, "unsupported_output_format", "native_output_mismatch");
    }
    return reject(onReject, "missing_command", "no_command");
  }
  if (!shellTools.has(tool)) return reject(onReject, "unsupported_command");
  if (Buffer.byteLength(command) > 8192) return reject(onReject, "metadata_limit", "command_length_limit");
  const segments = tokenize(command);
  if (!segments) return reject(onReject, "unsupported_shell_syntax");
  if (segments.length === 2) {
    const cd = segments[0];
    const path = cd[1] === "--" ? cd[2] : cd[1];
    if (cd[0] !== "cd" || cd.length !== (cd[1] === "--" ? 3 : 2) || !/^(\/|\.\.?\/)/.test(path ?? "")) return reject(onReject, "unsupported_shell_syntax");
  }
  let argv = segments.at(-1);
  let prefix = 0;
  while (prefix < argv.length - 1 && /^[A-Za-z_][A-Za-z_0-9]*=.+$/.test(argv[prefix])) prefix++;
  if (prefix) argv = argv.slice(prefix);
  const base = token => token.replaceAll("\\", "/").split("/").at(-1).replace(/\.exe$/i, "").toLowerCase();
  let executable = base(argv[0]);
  if (["python", "python3"].includes(executable) && argv[1] === "-m" && argv[2]) argv = argv.slice(2);
  else if (["npx", "bunx"].includes(executable) && argv[1]) argv = argv.slice(1);
  else if (executable === "pnpm" && argv[1] === "exec" && argv[2]) argv = argv.slice(2);
  else if (executable === "uv" && argv[1] === "run" && argv[2]) argv = argv.slice(2);
  executable = base(argv[0]);
  onCommand?.(commandFamily(executable, argv));
  if (executable === "rtk") return reject(onReject, "already_rtk");
  if (argv.some(arg => ["-z", "--null", "--null-data", "--print0", "-print0"].includes(arg))) return reject(onReject, "unsupported_output_format");
  if (executable === "git") {
    let i = 1;
    while (i < argv.length) {
      if (["--no-pager", "--no-optional-locks"].includes(argv[i])) i++;
      else if (["-C", "-c"].includes(argv[i]) && argv[i + 1]) i += 2;
      else break;
    }
    const sub = argv[i++];
    if (sub === "log") {
      const args = argv.slice(i);
      return args.every((arg, index) => /^-[1-9][0-9]*$/.test(arg) || /^--max-count=[1-9][0-9]*$/.test(arg) || arg === "-n" && /^[1-9][0-9]*$/.test(args[index + 1]) || index > 0 && args[index - 1] === "-n" && /^[1-9][0-9]*$/.test(arg))
        ? "local:git-log" : reject(onReject, "unsupported_mode");
    }
    if (sub !== "diff" && sub !== "status") return reject(onReject, "unsupported_mode");
    if (argv.slice(i).some(arg => /^(--raw|--numstat|--name-only|--name-status|--format|--pretty|--word-diff|--word-diff-regex|--no-patch|--stat|--shortstat|--dirstat|--summary)(=|$)/.test(arg))) return reject(onReject, "unsupported_output_format");
    return `git-${sub}`;
  }
  if (["rg", "grep"].includes(executable)) {
    if (!options(argv.slice(1), grepFlags, grepValues, "nHrRiwFE")) return reject(onReject, "unsupported_mode");
    if (!isGrepOutput(content)) return reject(onReject, "unsupported_output_format");
    return exceedsPipeGrepCap(content) ? "local:grep" : "grep";
  }
  if (executable === "find" || executable === "fd") {
    if (executable === "find") {
      if (!options(argv.slice(1), new Set(["-print"]), findValues)) return reject(onReject, "unsupported_mode");
    } else if (!options(argv.slice(1), fdFlags, fdValues)) return reject(onReject, "unsupported_mode");
    if (!isPathOutput(content)) return reject(onReject, "unsupported_output_format");
    return "local:find";
  }
  if (executable === "go") {
    if (argv[1] === "build") return "go-build";
    const mode = argv.slice(2);
    const separator = mode.indexOf("--");
    const jsonFlags = mode.filter(a => a === "-json" || a.startsWith("-json="));
    if (argv[1] !== "test") return reject(onReject, "unsupported_mode");
    if (jsonFlags.length !== 1 || !["-json", "-json=true"].includes(jsonFlags[0]) || (separator >= 0 && mode.indexOf(jsonFlags[0]) >= separator)) return reject(onReject, "unsupported_mode");
    return jsonLines(content) ? "go-test" : reject(onReject, "unsupported_output_format");
  }
  if (executable === "cargo") return argv[1] === "test" ? "cargo-test" : argv[1] === "build" ? "local:cargo-build" : reject(onReject, "unsupported_mode");
  if (executable === "ruff") {
    if (argv[1] === "format") return "ruff-format";
    if (argv[1] !== "check" || !formatFlag(argv.slice(2), "--output-format", "json")) return reject(onReject, "unsupported_mode");
    return jsonArray(content) ? "ruff-check" : reject(onReject, "unsupported_output_format");
  }
  if (executable === "sqlfluff") {
    if (argv[1] !== "lint" || !formatFlag(argv.slice(2), "--format", "json")) return reject(onReject, "unsupported_mode");
    return jsonArray(content) ? "sqlfluff-lint" : reject(onReject, "unsupported_output_format");
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable) && isTestScript(argv)) return "local:test";
  if (executable === "node" && argv.includes("--test")) return "local:test";
  if (executable === "vitest") {
    if (content.trimStart().startsWith("{")) return isPassingVitestJson(content) ? "vitest" : reject(onReject, "unsupported_output_format");
    return "local:test";
  }
  if (executable === "jest") return "local:test";
  if (executable === "docker" && ["ps", "logs"].includes(argv[1])) return `local:docker-${argv[1]}`;
  if (["ls", "tree"].includes(executable)) return "local:listing";
  return direct.get(executable) ?? reject(onReject, "unsupported_command");
}
