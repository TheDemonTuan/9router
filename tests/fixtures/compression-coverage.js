// Synthetic model-facing grammars; no captured requests or production content.
// Codex context.rs @ 3483294596ea86edd1fdc30bf360b8951b9d7022
// https://github.com/openai/codex/blob/3483294596ea86edd1fdc30bf360b8951b9d7022/codex-rs/core/src/tools/context.rs
export const codexCall = { name: "exec_command", input: { cmd: "bun --cwd tests run test --config vitest.config.js" } };
export function codexOutput(body, id = "synthetic", time = "0.123", eol = "\n") {
  return [`Chunk ID: ${id}`, `Wall time: ${time} seconds`, "Process exited with code 0", "Original token count: 999", "Output:", ""].join(eol) + body;
}
// OMP match-line-format.ts @ 0d6dbd32fcd76bfb3bee0e6e01a26afda62628a8
export const ompGrep = "# src/\n[example.js#A1B2]\n*1:const synthetic = true;\n 2:context\n*3|synthetic();\n";
export const ompGlob = "src/\n  example.js\n  nested/\n    fixture.js\n… 2 more\n";
// OpenCode grep.ts @ e63996919b6267d00a5ea224ab03b0f58fbd15d8
export const openCodeGrep = "Found 3 matches\n\n/src/example.js:\n  Line 1: synthetic\n  Line 1: synthetic\n  Line 2: other\n";
// Grok types/output.rs @ 07e35a3dfeed2f200d319ef6c893b5ea286d9a51
export const grokStructured = JSON.stringify({ type: "code_execution_result", stdout: "synthetic", stderr: "KEEP_STDERR", exit_code: 0, command_timed_out: false });
// ZCode @ 29628c9acdb81b703bbd4080c207a0e7ce5e276e
// apps/zcode-cli/packages/core/src/tool/{handlers/bash-model-content,result-persistence-format}.ts
export const zcodePersisted = path => `<persisted-output>\nOutput saved to: ${path}\n\nPreview:\n${"synthetic preview\n".repeat(100)}\n</persisted-output>`;
export const zcodeContext = "synthetic stdout\nKEEP_STDERR\nExit code 1\nInterrupted by user\nBackground task synthetic\nHook context: KEEP_HOOK\n";
export const largePatch = "diff --git a/synthetic.js b/synthetic.js\n--- a/synthetic.js\n+++ b/synthetic.js\n@@ -0,0 +1,250 @@\n" + Array.from({ length: 250 }, (_, i) => `+synthetic line ${i + 1}\n`).join("");
export const mixedBun = "bun test v1.4.2 (synthetic)\nsuite.test.js:\n" + Array.from({ length: 40 }, (_, i) => `(pass) synthetic ${i} [1.00ms]\n`).join("") + "(fail) KEEP_FAILURE [1.00ms]\nerror: KEEP_ERROR\n    at KEEP_STACK (suite.test.js:1:1)\nwarning: KEEP_WARNING\n40 pass\n1 fail\nRan 41 tests across 1 file. [41ms]\n";
