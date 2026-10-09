import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeProfiles } from "../src/profiles";
import { RuntimeState, RuntimeStateError } from "../src/runtime-state";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ProfileTunnel } from "../src/tunnel";
import { startRuntime } from "../src/server";
import { AgentTurnBroker, submitAgentToolCalls } from "../src/agent-turns";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-harness-lifecycle-"));
  const state = new RuntimeState(root);
  const profiles = new RuntimeProfiles({ dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: join(root, "absent-chromium"), runtimeToken: Buffer.from("fixture-data"), adminToken: Buffer.from("fixture-admin") }, state);
  return { root, state, profiles, async close() { await profiles.close(); state.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Full connector failures are deferred to selected preparation and do not prepare other profiles", async () => {
  const f = fixture();
  const first = f.state.createProfile("full-profile");
  f.state.patchProfile(first.profileId, first.revision, { ...first.settings, mode: "full" });
  f.state.createProfile("text-profile");
  const browser = spyOn(f.profiles, "ensureProfileBrowser").mockImplementation(async id => f.profiles.manager(id));
  const smoke = spyOn(f.profiles, "harnessSmoke").mockRejectedValue(new ChatGptWebAdapterError("Missing installed connector", { code: "connector_not_found", status: 503, errorType: "runtime_error", retryable: false }));
  const probe = spyOn(f.profiles, "probe").mockRejectedValue(new RuntimeStateError("login_required", "Text fixture has not authenticated", 503));
  try {
    await f.profiles.initialize();
    expect(browser).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(f.profiles.status("full-profile")).toMatchObject({ state: "session_unverified", browser_state: "sleeping", catalog_verified: false });
    await expect(f.profiles.prepareForRequest("full-profile")).rejects.toMatchObject({ code: "connector_not_found", status: 503 });
    expect(browser.mock.calls.map(([profileId]) => profileId)).toEqual(["full-profile"]);
    expect(smoke.mock.calls[0]?.slice(0, 2)).toEqual(["full-profile", true]);
    expect(probe).not.toHaveBeenCalled();
    expect(f.profiles.status("text-profile")).toMatchObject({ state: "session_unverified", models: [] });
    smoke.mockRejectedValue(new Error("Unexpected connector programming failure"));
    await expect(f.profiles.prepareForRequest("full-profile")).rejects.toThrow("Unexpected connector programming failure");
    await expect(f.profiles.prepareForRequest("text-profile")).rejects.toMatchObject({ code: "login_required" });
    expect(probe.mock.calls.map(([profileId]) => profileId)).toEqual(["text-profile"]);
    expect(f.profiles.ready("full-profile")).toBe(false);
    expect(f.profiles.ready("text-profile")).toBe(false);
  } finally { probe.mockRestore(); smoke.mockRestore(); browser.mockRestore(); await f.close(); }
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
    expect(snapshot.profiles.find((profile: { profileId: string }) => profile.profileId === "unrelated")).toMatchObject({ state: "session_unverified", browser_state: "sleeping", catalog_verified: false, connectorReady: false, lastError: null });
    const diagnostic = await fetch(`http://127.0.0.1:${runtime.server.port}/admin/harness/status?profileId=broken`, { headers: { authorization: "Bearer fixture-admin" } });
    expect((await diagnostic.json()).error.code).toBe("harness_storage_invalid");
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test("detected tunnel loss revokes an accepted generic batch before completion", async () => {
  const f = fixture();
  try {
    const profile = f.state.createProfile("lost-tunnel");
    f.state.patchProfile(profile.profileId, profile.revision, { ...profile.settings, mode: "full" });
    // A tracked but stopped tunnel represents a previously owned process that lost health;
    // merely configuring a cold Full profile must not count as a detected tunnel loss.
    const tunnel = new ProfileTunnel({ binaryPath: join(f.root, "absent-tunnel"), profileDir: join(f.root, "tunnel"),
      profileName: profile.profileId, tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: join(f.root, "fixture-key"), mcpEntrypoint: join(f.root, "fixture-mcp"), healthAddress: "127.0.0.1:1" });
    // Fixture-only access seeds the real tunnel object without launching a process.
    const internals = f.profiles as unknown as { tunnels: Map<string, ProfileTunnel> };
    internals.tunnels.set(profile.profileId, tunnel);
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
