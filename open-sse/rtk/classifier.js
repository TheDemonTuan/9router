const shellTools = new Set(["bash", "shell", "terminal", "run_terminal_cmd", "exec_command", "execute_bash", "run_command"]);
const direct = new Map(Object.entries({ pytest: "pytest", ctest: "ctest", tsc: "tsc", vitest: "vitest", mypy: "mypy", prettier: "prettier", phpunit: "phpunit", pest: "pest", paratest: "paratest", ecs: "ecs", phpstan: "phpstan", pint: "pint" }));
const grepFlags = new Set(["-n", "-H", "-r", "-R", "-i", "-w", "-F", "-E", "--line-number", "--with-filename", "--recursive", "--ignore-case", "--word-regexp", "--fixed-strings", "--extended-regexp", "--no-heading", "--hidden", "--no-ignore", "--color=never"]);
const grepValues = new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type"]);
const findValues = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth"]);
const fdFlags = new Set(["--hidden", "--no-ignore", "--absolute-path", "--full-path", "--glob", "--fixed-strings", "--case-sensitive", "--ignore-case"]);
const fdValues = new Set(["-e", "--extension", "-t", "--type", "-d", "--max-depth"]);

function tokenize(command) {
  if (/[\0\r\n;|&<>`$()]/.test(command)) return null;
  const argv = [];
  let word = "", quote = "", started = false;
  for (const char of command) {
    if (char === "'" || char === '"') {
      if (quote === char) quote = "";
      else if (!quote) quote = char;
      else word += char;
      started = true;
    } else if (/\s/.test(char) && !quote) {
      if (started) argv.push(word);
      word = ""; started = false;
    } else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) argv.push(word);
  return argv;
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

function reject(onReject, reason) { onReject?.(reason); return null; }

export function classifyToolCall(call, content, onReject) {
  if (!call) return reject(onReject, "unlinked_call");
  if (typeof call.name !== "string" || typeof content !== "string") return reject(onReject, "invalid_command_metadata");
  const tool = call.name.split(".").at(-1).toLowerCase();
  let input = call.input;
  if (typeof input === "string" && shellTools.has(tool)) {
    if (input.trimStart().startsWith("{")) {
      if (Buffer.byteLength(input) > 8192) return reject(onReject, "metadata_limit");
      try { input = JSON.parse(input); } catch { return reject(onReject, "invalid_command_metadata"); }
    } else input = { command: input };
  } else if (typeof input === "string") {
    if (Buffer.byteLength(input) > 8192) return reject(onReject, "metadata_limit");
    try { input = JSON.parse(input); } catch { return reject(onReject, "invalid_command_metadata"); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(onReject, "invalid_command_metadata");
  if (typeof input.command === "string" && typeof input.cmd === "string" && input.command !== input.cmd) return reject(onReject, "invalid_command_metadata");
  const command = input.command ?? input.cmd;
  if (typeof command !== "string") return reject(onReject, "missing_command");
  if (Buffer.byteLength(command) > 8192) return reject(onReject, "metadata_limit");
  let argv = tokenize(command);
  if (!argv?.length) return reject(onReject, "unsupported_shell_syntax");
  const base = token => token.replaceAll("\\", "/").split("/").at(-1).replace(/\.exe$/i, "").toLowerCase();
  let executable = base(argv[0]);
  if (executable === "rtk") return reject(onReject, "already_rtk");
  if (["python", "python3"].includes(executable) && argv[1] === "-m" && argv[2]) argv = argv.slice(2);
  else if (["npx", "bunx"].includes(executable) && argv[1]) argv = argv.slice(1);
  else if (executable === "pnpm" && argv[1] === "exec" && argv[2]) argv = argv.slice(2);
  else if (executable === "uv" && argv[1] === "run" && argv[2]) argv = argv.slice(2);
  executable = base(argv[0]);
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
    if (sub !== "diff" && sub !== "status") return reject(onReject, "unsupported_mode");
    if (argv.slice(i).some(arg => /^(--raw|--numstat|--name-only|--name-status|--format|--pretty|--word-diff|--word-diff-regex|--no-patch|--stat|--shortstat|--dirstat|--summary)(=|$)/.test(arg))) return reject(onReject, "unsupported_output_format");
    return `git-${sub}`;
  }
  if (["rg", "grep"].includes(executable)) {
    if (!options(argv.slice(1), grepFlags, grepValues, "nHrRiwFE")) return reject(onReject, "unsupported_mode");
    if (content.includes("\u001b") || !content.split(/\r?\n/).filter(Boolean).every(line => /^[^:\r\n]+:[0-9]+:.*$/.test(line) && !/^[A-Za-z]:/.test(line))) return reject(onReject, "unsupported_output_format");
    return "grep";
  }
  if (executable === "find" || executable === "fd") {
    if (executable === "find") {
      if (!options(argv.slice(1), new Set(["-print"]), findValues)) return reject(onReject, "unsupported_mode");
    } else if (!options(argv.slice(1), fdFlags, fdValues)) return reject(onReject, "unsupported_mode");
    if (!content.split(/\r?\n/).filter(Boolean).every(line => line.includes("/") && !line.includes(":") && !/^\s/.test(line))) return reject(onReject, "unsupported_output_format");
    return "find";
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
  if (executable === "cargo") return argv[1] === "test" ? "cargo-test" : reject(onReject, "unsupported_mode");
  if (executable === "ruff") {
    if (argv[1] === "format") return "ruff-format";
    if (argv[1] !== "check" || !formatFlag(argv.slice(2), "--output-format", "json")) return reject(onReject, "unsupported_mode");
    return jsonArray(content) ? "ruff-check" : reject(onReject, "unsupported_output_format");
  }
  if (executable === "sqlfluff") {
    if (argv[1] !== "lint" || !formatFlag(argv.slice(2), "--format", "json")) return reject(onReject, "unsupported_mode");
    return jsonArray(content) ? "sqlfluff-lint" : reject(onReject, "unsupported_output_format");
  }
  return direct.get(executable) ?? reject(onReject, "unsupported_command");
}
