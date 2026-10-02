import { describe, it, expect } from "vitest";
import { inspectToolOutput, replaceToolOutputBody, preservesToolOutput } from "../../open-sse/token-saver/toolOutput.js";
import { codexCall, codexOutput, grokStructured, zcodePersisted, zcodeContext } from "../fixtures/compression-coverage.js";

describe("strict linked Codex body descriptor", () => {
  it.each(["\n", "\r\n"])("preserves the exact envelope and body with %j", eol => {
    const body = ` é${eol}body  ${eol}`;
    const raw = codexOutput(body, "synthetic", "0.123", eol);
    const descriptor = inspectToolOutput(raw, codexCall);
    expect(raw.slice(descriptor.bodyStart, descriptor.bodyEnd)).toBe(body);
    expect(replaceToolOutputBody(raw, descriptor, "replacement")).toBe(raw.slice(0, descriptor.bodyStart) + "replacement");
    expect(inspectToolOutput(raw.replace(/Original token count: 999\r?\n/, ""), codexCall)).not.toBeNull();
  });
  it.each([0, 1023, 1024])("does not conflate descriptor parsing and byte eligibility at %i bytes", size => {
    const raw = codexOutput("x".repeat(size));
    const descriptor = inspectToolOutput(raw, codexCall);
    expect(Buffer.byteLength(raw.slice(descriptor.bodyStart))).toBe(size);
  });
  it("requires proven tool and cmd metadata, never arbitrary prose or JSON unwrap", () => {
    for (const call of [null, { name: "Bash", input: { cmd: "bun test" } }, { name: "exec_command", input: { command: "bun test" } }, { ...codexCall, ambiguous: true }]) expect(inspectToolOutput(codexOutput("body"), call)).toBeNull();
    expect(inspectToolOutput(grokStructured, codexCall)).toBeNull();
    expect(inspectToolOutput("some prose\n" + codexOutput("body"), codexCall)).toBeNull();
  });
  it("rejects running, failed, duplicate, reordered, truncated and unknown envelope variants", () => {
    const raw = codexOutput("body");
    const invalid = [raw.replace("Process exited with code 0", "Process running with session ID 1"), raw.replace("code 0", "code 1"), raw.replace("Output:", "Final output:"), raw.replace("Output:\n", "Wall time: 1 seconds\nOutput:\n"), raw.replace("Wall time: 0.123 seconds\nProcess exited with code 0", "Process exited with code 0\nWall time: 0.123 seconds"), raw.replace("seconds\n", "seconds\r\n"), ...["Warning: truncated output", "… 10 lines omitted", "Output truncated", "Process running with session ID 1", "Final output:", "Hook context: private", "\ud800"].map(body => codexOutput(body))];
    for (const value of invalid) expect(inspectToolOutput(value, codexCall)).toBeNull();
  });
  it("preserves artifact identity, structured carriers, stderr and lifecycle context", () => {
    for (const text of [grokStructured, zcodeContext, zcodePersisted("/synthetic/a"), zcodePersisted("/synthetic/b")]) {
      expect(preservesToolOutput(text)).toBe(true);
      expect(inspectToolOutput(text, codexCall)).toBeNull();
    }
  });
});
