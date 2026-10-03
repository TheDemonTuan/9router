import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeState } from "../src/runtime-state";
import type { AuthorityClaims } from "../src/authority";
import { runtimeExecutionScope } from "../src/runtime-scope";
import { expandPreviousResponseInput, closeResponseState, rememberResponseState } from "../src/responses/state";
const claim = (jti: string, clientId = "client-a"): AuthorityClaims => ({ v: 1, aud: "9router-cgw", purpose: "responses", clientId, jti,
  iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60, method: "POST", path: "/v1/responses", bodySha256: "a".repeat(64), threadId: "thread", turnId: "turn" });
describe("durable runtime admission", () => {
  test("binding survives reversed blue/green candidates and denies explicit repin and replay", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-binding-")); const state = new RuntimeState(root);
    try {
      const one = state.createProfile("one"), two = state.createProfile("two");
      const first = state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["one", "two"], ready: () => true });
      expect(first).toEqual({ profileId: "one", profileEpoch: one.epoch, status: "active" });
      expect(state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["two", "one"], ready: () => true })).toEqual(first);
      expect(() => state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["two", "one"], requestedProfileId: "two", ready: () => true })).toThrow("Explicit profile");
      state.admit(claim("jti"), "one", one.epoch, "model-a", false);
      expect(() => state.admit(claim("jti"), "one", one.epoch, "model-a", true)).toThrow("already been consumed");
      expect(() => state.admit(claim("jti-new"), "one", one.epoch, "model-b", true)).toThrow("model identity changed");
      state.resolveBinding({ clientId: "client-b", threadId: "thread", candidateProfileIds: ["two"], ready: () => true });
      state.admit(claim("jti", "client-b"), "two", two.epoch, "model-a", false);
      expect(state.binding("client-b", "thread")?.profileId).toBe("two");
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });
  test("fence persists across restart, allows accepted continuation only, and requires matching resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-fence-")); let state = new RuntimeState(root);
    try {
      const profile = state.createProfile("one");
      state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["one"], ready: () => true });
      state.admit(claim("first"), "one", profile.epoch, "model", false);
      state.drain("operation-one");
      state.admit(claim("continuation"), "one", profile.epoch, "model", true);
      expect(() => state.admit({ ...claim("new"), turnId: "another-turn" }, "one", profile.epoch, "model", false)).toThrow("denied while drained");
      expect(() => state.createProfile("new")).toThrow("denied while drained");
      await expect(state.resume("different-operation", async () => {})).rejects.toThrow("Matching operation");
      state.close(); state = new RuntimeState(root);
      expect(state.fence()).toEqual({ operationId: "operation-one", state: "draining" });
      expect(() => state.admit(claim("after-crash"), "one", profile.epoch, "model", true)).toThrow("ambiguous effects");
      state.quiesce("operation-one");
      expect(state.listProfiles()[0]?.profileId).toBe("one");
      await state.resume("operation-one", async () => {}); expect(state.fence()).toBeNull();
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });
  test("account switch changes epoch without repinning existing thread", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-epoch-")); const state = new RuntimeState(root);
    try {
      const profile = state.createProfile("one"); state.observeAccount("one", "first-salted-account");
      state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["one"], ready: () => true });
      const changed = state.observeAccount("one", "second-salted-account");
      expect(changed.epoch).not.toBe(profile.epoch);
      expect(state.binding("client-a", "thread")).toEqual({ profileId: "one", profileEpoch: profile.epoch, status: "interrupted" });
      expect(() => state.resolveBinding({ clientId: "client-a", threadId: "thread", candidateProfileIds: ["one"], ready: () => true })).toThrow("no longer active");
    } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
test("identical response IDs cannot cross profile/client/epoch continuation scope", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-continuation-")); const previous = process.env.CGW_DATA_DIR; process.env.CGW_DATA_DIR = root;
  try {
    const scope = { profileId: "one", profileEpoch: "epoch", clientId: "client-a" };
    const request = { input: [{ role: "user", content: "canonical task" }], store: false };
    runtimeExecutionScope.run(scope, () => rememberResponseState(request, { id: "same-id", output: [{ role: "assistant", content: "completed" }], status: "completed" }, { force: true }));
    const next = { previous_response_id: "same-id", input: [{ role: "user", content: "next" }] };
    expect(runtimeExecutionScope.run({ ...scope, clientId: "client-b" }, () => expandPreviousResponseInput(next))).toBe(next);
    expect(runtimeExecutionScope.run({ ...scope, profileEpoch: "new-epoch" }, () => expandPreviousResponseInput(next))).toBe(next);
    expect(runtimeExecutionScope.run(scope, () => expandPreviousResponseInput(next))).toEqual({ ...next, input: [...request.input, { role: "assistant", content: "completed" }, ...next.input] });
  } finally { closeResponseState(); if (previous === undefined) delete process.env.CGW_DATA_DIR; else process.env.CGW_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});
