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
});
