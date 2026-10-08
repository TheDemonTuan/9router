import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeProfiles } from "../src/profiles";
import { RuntimeState } from "../src/runtime-state";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserContext } from "playwright-core";
import { startRuntime } from "../src/server";
import { AgentTurnBroker, submitAgentToolCalls } from "../src/agent-turns";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-harness-lifecycle-"));
  const state = new RuntimeState(root);
  const profiles = new RuntimeProfiles({ dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: join(root, "absent-chromium"), runtimeToken: Buffer.from("fixture-data"), adminToken: Buffer.from("fixture-admin") }, state);
  return { root, state, profiles, async close() { await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("missing connector on a Full profile does not prevent another profile from initializing", async () => {
  const f = fixture();
  const first = f.state.createProfile("full-profile");
  f.state.patchProfile(first.profileId, first.revision, { ...first.settings, mode: "full" });
  f.state.createProfile("text-profile");
  const manager = f.profiles.manager("full-profile");
  const other = f.profiles.manager("text-profile");
  const browser = spyOn(f.profiles, "ensureProfileBrowser").mockImplementation(async id => f.profiles.manager(id));
  const context = spyOn(manager, "ensureContext").mockResolvedValue({} as BrowserContext);
  const otherContext = spyOn(other, "ensureContext").mockResolvedValue({} as BrowserContext);
  const smoke = spyOn(f.profiles, "harnessSmoke").mockRejectedValue(new ChatGptWebAdapterError("Missing installed connector", { code: "connector_not_found", status: 503, errorType: "runtime_error", retryable: false }));
  let initializedText = false;
  const probe = spyOn(f.profiles, "probe").mockImplementation(async id => { initializedText = id === "text-profile"; return {} as Awaited<ReturnType<RuntimeProfiles["probe"]>>; });
  try {
    await f.profiles.initialize();
    expect(initializedText).toBe(true);
    expect(f.profiles.status("full-profile")).toMatchObject({ state: "error", lastError: "connector_unavailable" });
    smoke.mockRejectedValue(new Error("Unexpected connector programming failure"));
    await expect(f.profiles.initialize()).rejects.toThrow("Unexpected connector programming failure");
  } finally { probe.mockRestore(); smoke.mockRestore(); otherContext.mockRestore(); context.mockRestore(); browser.mockRestore(); await f.close(); }
});

test("browser-only preference saves preserve a prepared tunnel key and configuration", async () => {
  const f = fixture();
  try {
    const profile = f.state.createProfile("one");
    f.profiles.harnessConfig.configure("one", 0, { tunnelId: "tunnel_0123456789abcdef0123456789abcdef", runtimeApiKey: "sk-runtime-fixture-01234567890123456789" });
    const config = await f.profiles.harnessConfig.processConfig("one");
    await f.profiles.patch("one", profile.revision, { autoApproveToolCalls: true });
    expect(f.state.profile("one").settings.autoApproveToolCalls).toBe(true);
    expect(existsSync(config.runtimeKeyFile)).toBe(true);
    expect(await f.profiles.harnessConfig.processConfig("one")).toBe(config);
  } finally { await f.close(); }
});

test("malformed managed secrets fail closed without rejecting unrelated profile snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-harness-status-"));
  const runtime = startRuntime({ dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: "/nonexistent", runtimeToken: Buffer.from("fixture-data"), adminToken: Buffer.from("fixture-admin") });
  try {
    await runtime.initialized;
    const broken = runtime.state.createProfile("broken");
    runtime.state.patchProfile("broken", broken.revision, { ...broken.settings, mode: "full" });
    runtime.state.createProfile("unrelated");
    const directory = join(root, "profiles", "broken", "secrets");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "harness.json"), "{", { mode: 0o600 });
    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/admin/profiles`, { headers: { authorization: "Bearer fixture-admin" } });
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.profiles.find((profile: { profileId: string }) => profile.profileId === "broken").connectorReady).toBe(false);
    expect(snapshot.profiles.find((profile: { profileId: string }) => profile.profileId === "unrelated")).toMatchObject({ state: "login_required", connectorReady: false, lastError: null });
    const diagnostic = await fetch(`http://127.0.0.1:${runtime.server.port}/admin/harness/status?profileId=broken`, { headers: { authorization: "Bearer fixture-admin" } });
    expect((await diagnostic.json()).error.code).toBe("harness_storage_invalid");
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("detected tunnel loss revokes an accepted generic batch before completion", async () => {
  const f = fixture();
  try {
    const profile = f.state.createProfile("lost-tunnel");
    f.state.patchProfile(profile.profileId, profile.revision, { ...profile.settings, mode: "full" });
    const broker = AgentTurnBroker.forSocket(join(f.root, "profiles", profile.profileId, "run", "agent-turns.sock"));
    await broker.listen();
    const handle = broker.register({ profileId: profile.profileId, profileEpoch: profile.epoch, requestId: "request", model: "gpt-5.6-sol",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }] });
    await submitAgentToolCalls(broker.socketPath, handle.token, [{ name: "read_file", arguments: {} }]);
    await f.profiles.refreshReadiness(profile.profileId);
    expect(handle.signal.aborted).toBe(true);
    expect(() => handle.finish()).toThrow(expect.objectContaining({ code: "agent_request_expired" }));
    expect(() => broker.submit(handle.token, [{ name: "read_file", arguments: {} }])).toThrow(expect.objectContaining({ code: "agent_request_expired" }));
  } finally { await f.close(); }
});
