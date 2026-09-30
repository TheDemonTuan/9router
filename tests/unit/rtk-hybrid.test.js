import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { classifyToolCall } from "../../open-sse/rtk/classifier.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { filterLocalOutput } from "../../open-sse/rtk/local.js";
import { getRtkState } from "../../open-sse/rtk/state.js";

let requests = 0;
const server = createServer((request, response) => {
  requests++;
  response.writeHead(503).end("busy");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.RTK_URL = `http://127.0.0.1:${server.address().port}`;
afterAll(() => new Promise(resolve => server.close(resolve)));

const shell = (command, name = "functions.bash") => ({ name, input: { command } });
const bodyFor = (name, input, content, extra = {}) => ({ messages: [
  { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(input) } }] },
  { role: "tool", tool_call_id: "c", content, ...extra },
] });

const log = Array.from({ length: 5 }, (_, i) =>
  `commit ${String(i + 1).padStart(40, "0")}\nAuthor: Fixture <fixture@example.invalid>\nDate:   Tue Sep 29 00:00:00 2026 +0000\n\n    KEEP_COMMIT_${i + 1}\n${Array.from({ length: 12 }, (_, j) => `    detail ${j}: fixture message for the log formatter`).join("\n")}\n\n`).join("");
const matches = Array.from({ length: 25 }, (_, i) => `src/a.js:${i + 1}:KEEP_MATCH_${i + 1}`).join("\n") + "\n";
const paths = Array.from({ length: 30 }, (_, i) => `./src/dir/KEEP_FILE_${i + 1}.js`).join("\n") + "\n";

async function compress(name, input, text, extra) {
  const body = bodyFor(name, input, text, extra);
  const stats = await compressMessages(body, true);
  return { text: body.messages[1].content, stats };
}

describe("hybrid RTK preserves output contracts", () => {
  it("preserves every git log commit, rejects unsupported output modes and unknown log shapes", async () => {
    const start = requests;
    const { text, stats } = await compress("functions.bash", { command: "git log" }, log);
    expect(text).not.toBe(log);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`KEEP_COMMIT_${i}`);
    expect(text).toContain("[+9 message lines omitted]");
    expect(stats.hits[0].engine).toBe("local");
    expect(requests).toBe(start);
    expect(classifyToolCall(shell("git log --patch"), log)).toBeNull();
    expect(classifyToolCall(shell("git log --oneline"), log)).toBeNull();
    const decorated = log.replace("commit 0000000000000000000000000000000000000001", "commit 0000000000000000000000000000000000000001 (HEAD -> master, origin/master)");
    const decoratedResult = filterLocalOutput("git-log", decorated);
    expect(decoratedResult).toContain("(HEAD -> master, origin/master)");
    expect(decoratedResult).toContain("KEEP_COMMIT_1");
    const merged = log.replace("commit 0000000000000000000000000000000000000002\nAuthor:", "commit 0000000000000000000000000000000000000002\nMerge: 1111111 2222222\nAuthor:");
    const mergedResult = filterLocalOutput("git-log", merged);
    expect(mergedResult).toContain("Merge: 1111111 2222222");
    expect(mergedResult).toContain("KEEP_COMMIT_2");
  });

  it("rejects bare filenames in cwd that lack directory prefixes to group", async () => {
    const bareFiles = Array.from({ length: 60 }, (_, i) => `file_${i + 1}.js`).join("\n") + "\n";
    // Bare filenames without slashes cannot be grouped into [dir] blocks,
    // so formatting them would add bytes instead of saving tokens.
    expect(classifyToolCall({ name: "functions.glob", input: { path: "*" } }, bareFiles)).toBeNull();
    const prose = "The quick brown fox jumps over the lazy dog.\n".repeat(20);
    expect(classifyToolCall({ name: "functions.glob", input: { path: "*" } }, prose)).toBeNull();
  });
  it("keeps all matches and paths when Rust pipe would truncate, including native tools", async () => {
    const start = requests;
    for (const [name, input, text, markers] of [
      ["functions.bash", { command: "rg -n KEEP src" }, matches, ["KEEP_MATCH_1", "KEEP_MATCH_25"]],
      ["functions.grep", { path: "src", pattern: "KEEP" }, matches, ["KEEP_MATCH_1", "KEEP_MATCH_25"]],
      ["functions.glob", { path: "./src/**/*.js" }, paths, ["KEEP_FILE_1.js", "KEEP_FILE_30.js"]],
    ]) {
      const result = await compress(name, input, text);
      for (const marker of markers) expect(result.text).toContain(marker);
      expect(result.stats.hits[0].engine).toBe("local");
    }
    expect(requests).toBe(start);
    expect(classifyToolCall(shell("rg -n -C 3 KEEP src"), matches)).toBeNull();
    expect(classifyToolCall({ name: "functions.read", input: { path: "src/a.js" } }, matches)).toBeNull();
    expect(classifyToolCall({ name: "functions.grep", input: { pattern: "KEEP", path: "src" } }, "KEEP_HEADER\n" + matches)).toBeNull();
  });

  it("preserves filename characters including trailing spaces in grouped paths", async () => {
    const text = paths.replace("KEEP_FILE_30.js\n", "KEEP_FILE_30.js \n");
    const result = await compress("functions.glob", { path: "./src/**/*.js" }, text);
    expect(result.stats.hits[0].engine).toBe("local");
    expect(result.text.endsWith("KEEP_FILE_30.js ")).toBe(true);
  });

  it("summarizes passing tests and builds but never suppresses errors or warnings", async () => {
    const tests = Array.from({ length: 35 }, (_, i) => `  ✓ KEEP_TEST_${i + 1} passed (2ms)`).join("\n") + "\nTest Files 1 passed (1)\nTests 35 passed (35)\n";
    const result = await compress("functions.bash", { command: "CI=1 npm test" }, tests);
    expect(result.text).toContain("Tests 35 passed (35)");
    expect(result.text).toContain("[35 passing test lines omitted]");
    expect(result.stats.hits[0].engine).toBe("local");
    const failed = tests + "FAIL KEEP_TEST_8\nError: assertion failed\n";
    expect((await compress("functions.bash", { command: "npm test" }, failed)).text).toBe(failed);
    const build = Array.from({ length: 30 }, (_, i) => `   Compiling fixture-${i} v0.1.0 (example.invalid/pkg)`).join("\n") + "\n    Finished dev [unoptimized + debuginfo] target(s) in 1.00s\n";
    expect((await compress("functions.bash", { command: "cargo build" }, build)).text).toContain("[30 crates compiled or checked]");
    const warning = build + "warning: KEEP_IMPORTANT_WARNING\n";
    expect((await compress("functions.bash", { command: "cargo build" }, warning)).text).toBe(warning);
  });

  it("keeps Docker rows, quoted command spacing, logs and tree paths intact", async () => {
    const widths = [15, 25, 35, 14, 14, 10];
    const render = values => values.map((value, index) => index < widths.length ? value.padEnd(widths[index]) + "  " : value).join("");
    const header = render(["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"]);
    const rows = Array.from({ length: 25 }, (_, i) => render([
      String(i + 1).padStart(12, "0"), "fixture/image:latest", `"sh -c 'echo  KEEP_${i + 1}'"`, "2 hours ago", "Up 2 hours", "", `service-${i + 1}`,
    ]));
    const table = [header, ...rows].join("\n") + "\n";
    const ps = await compress("functions.bash", { command: "docker ps" }, table);
    expect(ps.text).toContain("echo  KEEP_25");
    expect(ps.text).toContain("service-1");
    expect(ps.text).toContain("service-25");
    expect(ps.stats.hits[0].engine).toBe("local");
    const firstRow = ps.text.split("\n")[1].split("\t");
    expect(firstRow[2]).toContain("echo  KEEP_1");
    expect(firstRow[3]).toBe("2 hours ago");
    expect(firstRow[6]).toBe("service-1");
    const unicodeTable = table.replace("echo  KEEP_1", "echo 中文中文中文 KEEP_1");
    expect((await compress("functions.bash", { command: "docker ps" }, unicodeTable)).text).toBe(unicodeTable);
    const logs = "KEEP_LOG_ENTRY\n".repeat(60) + "ERROR KEEP_FAILURE\n";
    const result = await compress("functions.bash", { command: "docker logs fixture" }, logs);
    expect(result.text).toContain("[previous line repeated 59 times]");
    expect(result.text).toContain("ERROR KEEP_FAILURE");
    const tree = "\u001b[34m./src\u001b[0m\n" + "│   ├── KEEP_FILE.js\n".repeat(30);
    expect((await compress("functions.bash", { command: "tree -C" }, tree)).text).toContain("│   ├── KEEP_FILE.js");
  });

  it("falls back only for compatible Rust filters and respects cache breakpoints", async () => {
    const few = Array.from({ length: 8 }, (_, i) => `src/${"a".repeat(45)}.js:${i + 1}:KEEP_${i}_${"x".repeat(55)}`).join("\n") + "\n";
    const fallbackBefore = getRtkState().usage.local.fallbacks;
    const start = requests;
    const { text, stats } = await compress("functions.bash", { command: "rg -n KEEP src" }, few);
    expect(requests).toBe(start + 1);
    for (let i = 0; i < 8; i++) expect(text).toContain(`KEEP_${i}`);
    expect(stats.hits[0].engine).toBe("local");
    expect(getRtkState().usage.local.fallbacks).toBe(fallbackBefore + 1);

    const body = { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "id", name: "functions.bash", input: { command: "git log" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "id", cache_control: { type: "ephemeral" }, content: [{ type: "text", text: log }] }] },
    ] };
    const cached = await compressMessages(body, true);
    expect(body.messages[1].content[0].content[0].text).toBe(log);
    expect(cached.hits).toHaveLength(0);
  });
  it("does not apply local compression after the shared deadline", async () => {
    let clock = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => (clock += 500));
    try {
      const { text, stats } = await compress("functions.bash", { command: "git log" }, log);
      expect(text).toBe(log);
      expect(stats.hits).toHaveLength(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("diagnoses OpenAI Responses grep, enveloped headers, and native read/grep misses accurately", async () => {
    const grepContent = Array.from({ length: 25 }, (_, i) => `src/fixture_module.js:${i + 1}:KEEP_MATCH_${i + 1}`).join("\n") + "\n";
    const stateModule = await import("../../open-sse/rtk/state.js");
    const beforeSnap = stateModule.getRtkSnapshot();
    const beforeRow = beforeSnap.diagnostics.filters.find(r => r.filter === "local:grep" && r.outcome === "applied");
    const beforeIn = beforeRow?.inputBytes ?? 0;
    const beforeOut = beforeRow?.outputBytes ?? 0;
    // OpenAI Responses shape
    const responsesBody = {
      input: [
        { type: "function_call", call_id: "c_grep", name: "functions.grep", arguments: JSON.stringify({ path: "src/fixture_module.js", pattern: "KEEP" }) },
        { type: "function_call_output", call_id: "c_grep", output: grepContent },
      ],
    };
    const stats = await compressMessages(responsesBody, true);
    expect(stats.hits).toHaveLength(1);
    for (let i = 1; i <= 25; i++) expect(responsesBody.input[1].output).toContain(`KEEP_MATCH_${i}`);
    const snap = stateModule.getRtkSnapshot();
    const appliedGrepRow = snap.diagnostics.filters.find(r => r.filter === "local:grep" && r.outcome === "applied");
    expect(appliedGrepRow).toMatchObject({ toolFamily: "grep", engine: "local", fallback: false, outcome: "applied" });
    expect(appliedGrepRow.inputBytes - beforeIn).toBe(Buffer.byteLength(grepContent));
    expect(appliedGrepRow.outputBytes - beforeOut).toBe(Buffer.byteLength(responsesBody.input[1].output));
    // Enveloped header/footer: native grep shape mismatch
    const envelopedGrep = `[Showing selected matches]\n${grepContent}[End of matches]\n`;
    const envelopedBody = {
      input: [
        { type: "function_call", call_id: "c_grep2", name: "functions.grep", arguments: JSON.stringify({ path: "src/fixture_module.js", pattern: "KEEP" }) },
        { type: "function_call_output", call_id: "c_grep2", output: envelopedGrep },
      ],
    };
    const envStats = await compressMessages(envelopedBody, true);
    expect(envStats.hits).toHaveLength(0);
    expect(envelopedBody.input[1].output).toBe(envelopedGrep);
    const snap2 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const mismatchRow = snap2.diagnostics.rejections.find(r => r.toolFamily === "grep" && r.detail === "native_output_mismatch");
    expect(mismatchRow).toBeDefined();

    // Native read > 500 B is omitted from diagnostics rejections to avoid cluttering stats
    const readContent = "export const fixture = true;\n".repeat(30);
    const readBody = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "c_read", type: "function", function: { name: "functions.read", arguments: JSON.stringify({ path: "src/app.js" }) } }] },
        { role: "tool", tool_call_id: "c_read", content: readContent },
      ],
    };
    await compressMessages(readBody, true);
    expect(readBody.messages[1].content).toBe(readContent);
    const snap3 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const readRow = snap3.diagnostics.rejections.find(r => r.toolFamily === "read");
    expect(readRow).toBeUndefined();

    // Native grep missing path
    const missingPathBody = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "c_grep_nopath", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "KEEP" }) } }] },
        { role: "tool", tool_call_id: "c_grep_nopath", content: grepContent },
      ],
    };
    await compressMessages(missingPathBody, true);
    const snap4 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const missingPathRow = snap4.diagnostics.rejections.find(r => r.toolFamily === "grep" && r.detail === "native_metadata_missing");
    expect(missingPathRow).toBeDefined();
  });

  it("distinguishes format_not_accepted, unsupported_mode, and unaccepted mixed listings", async () => {
    // git log with wrapper text
    const wrappedLog = `Wall time: 0.1 seconds\nOutput:\n${log}`;
    const wrappedBody = bodyFor("functions.bash", { command: "git log" }, wrappedLog);
    const wrappedStats = await compressMessages(wrappedBody, true);
    expect(wrappedStats.hits).toHaveLength(0);
    expect(wrappedBody.messages[1].content).toBe(wrappedLog);
    const snap = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const unacceptedLogRow = snap.diagnostics.filters.find(r => r.filter === "local:git-log" && r.outcome === "format_not_accepted");
    expect(unacceptedLogRow).toBeDefined();

    // git log --decorate -5 -> unsupported_mode
    const decorateBody = bodyFor("functions.bash", { command: "git log --decorate -5" }, log);
    await compressMessages(decorateBody, true);
    const snap2 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const decorateRow = snap2.diagnostics.rejections.find(r => r.toolFamily === "shell" && r.reason === "unsupported_mode");
    expect(decorateRow).toBeDefined();

    // Mixed list with bare files + paths with directory
    const mixed = `README.md\nDockerfile\npackage.json\n` + Array.from({ length: 30 }, (_, i) => `src/sub/file_${i}.js`).join("\n") + "\n";
    const mixedBody = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "c_mixed", type: "function", function: { name: "functions.glob", arguments: JSON.stringify({ path: "**/*" }) } }] },
        { role: "tool", tool_call_id: "c_mixed", content: mixed },
      ],
    };
    await compressMessages(mixedBody, true);
    expect(mixedBody.messages[1].content).toBe(mixed);
    const snap3 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const mixedRejection = snap3.diagnostics.rejections.find(r => r.toolFamily === "glob" && r.detail === "native_output_mismatch");
    expect(mixedRejection).toBeDefined();
  });

  it("diagnoses not_smaller, invalid_text, and guard rejections without payload mutations", async () => {
    // ls without ANSI > 500 B
    const lsPlain = Array.from({ length: 60 }, (_, i) => `file_${i + 1}.txt`).join("\n") + "\n";
    expect(Buffer.byteLength(lsPlain)).toBeGreaterThan(500);
    const lsBody = bodyFor("functions.bash", { command: "ls -la" }, lsPlain);
    await compressMessages(lsBody, true);
    expect(lsBody.messages[1].content).toBe(lsPlain);
    const snap = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const lsRow = snap.diagnostics.filters.find(r => r.filter === "local:listing" && r.outcome === "not_smaller");
    expect(lsRow).toBeDefined();

    // npm test summary without passing detail lines
    const npmPassOnly = "Test Files  5 passed (5)\nTests  40 passed (40)\nTime: 1.2s\n".repeat(12);
    expect(Buffer.byteLength(npmPassOnly)).toBeGreaterThan(500);
    const npmBody = bodyFor("functions.bash", { command: "npm test" }, npmPassOnly);
    await compressMessages(npmBody, true);
    expect(npmBody.messages[1].content).toBe(npmPassOnly);

    // cargo success without compile lines
    const cargoPassOnly = "    Finished dev [unoptimized + debuginfo] target(s) in 0.04s\n".repeat(10);
    expect(Buffer.byteLength(cargoPassOnly)).toBeGreaterThan(500);
    const cargoBody = bodyFor("functions.bash", { command: "cargo build" }, cargoPassOnly);
    await compressMessages(cargoBody, true);
    expect(cargoBody.messages[1].content).toBe(cargoPassOnly);
    const snap3 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const cargoRow = snap3.diagnostics.filters.find(r => r.filter === "local:cargo-build" && r.outcome === "not_smaller");
    expect(cargoRow).toBeDefined();

    // Test failure / error text -> format_not_accepted
    const failedNpm = "FAIL src/foo.test.js\n  ✕ test failed\nTests: 1 failed, 40 passed\n".repeat(10);
    const failBody = bodyFor("functions.bash", { command: "npm test" }, failedNpm);
    await compressMessages(failBody, true);
    expect(failBody.messages[1].content).toBe(failedNpm);
    const snap4 = (await import("../../open-sse/rtk/state.js")).getRtkSnapshot();
    const failRow = snap4.diagnostics.filters.find(r => r.filter === "local:test" && r.outcome === "format_not_accepted");
    expect(failRow).toBeDefined();

    // Invalid text with NUL byte
    let invalidOutcome = null;
    filterLocalOutput("git-log", "commit 1234\0invalid", (outcome) => { invalidOutcome = outcome; });
    expect(invalidOutcome).toBe("invalid_text");
  });
});
