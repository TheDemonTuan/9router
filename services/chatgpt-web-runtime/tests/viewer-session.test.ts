import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startRuntime } from "../src/server";
import { ViewerTransport, VIEWER_MAX_BUFFER } from "../src/viewer-transport";
import type { Socket } from "node:net";
import type { RuntimeConfig } from "../src/config";

const loginId = "aabbccdd-1234-4567-89ab-0123456789ab";
// DOM types omit Bun's authenticated client options; the runtime is Bun-only.
const BunWebSocket = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
async function fixture(resistTermination = false) {
  const root = mkdtempSync(join(tmpdir(), "cgw-viewer-session-"));
  const config: RuntimeConfig = { dataDir: root, host: "127.0.0.1", port: 0, chromiumExecutable: join(root, "absent-chromium"), runtimeToken: Buffer.from("fixture-data-token-not-a-real-secret"), adminToken: Buffer.from("fixture-admin-token-not-a-real-secret") };
  const runtime = startRuntime(config); await runtime.initialized;
  const passwordFile = join(root, "viewer-password"); writeFileSync(passwordFile, "fixtureVncPassword\n");
  const child = spawn(process.execPath, ["-e", `${resistTermination ? 'process.on("SIGTERM", () => {});' : ""} process.stdout.write("ready\\n"); process.stdin.resume()`], { stdio: ["pipe", "pipe", "ignore"] });
  await once(child, "spawn"); await once(child.stdout!, "data");
  // This fixture seeds a lease without starting its production expiry timer.
  const timer = undefined as unknown as Timer;
  const lease = { loginId, profileId: "personal", expiresAt: Date.now() + 600000, manualLogin: false, child, passwordFile, password: "fixtureVncPassword", timer, transports: new Set<() => void>() };
  // A real child-backed lease isolates lifecycle boundaries from Chromium/login.
  const internals = runtime.profiles as unknown as { viewer: typeof lease };
  internals.viewer = lease;
  const url = `http://127.0.0.1:${runtime.server.port}`;
  const admin = (path: string, body?: unknown, bearer = config.adminToken.toString()) => fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const connect = () => new BunWebSocket(`${url.replace("http:", "ws:")}/admin/login/viewer?loginId=${loginId}`, { headers: { authorization: `Bearer ${config.adminToken}` } });
  return { runtime, lease, config, admin, connect, async close() { await runtime.close(); rmSync(root, { recursive: true, force: true }); } };
}
function opened(ws: WebSocket) { return new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("Viewer failed")), { once: true }); }); }
function closed(ws: WebSocket) { return new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true })); }

describe("authenticated ephemeral runtime viewer leases", () => {
  test("session credentials require admin bearer and exact live lease; status never returns credentials", async () => {
    const f = await fixture();
    try {
      const path = `/admin/login/session?loginId=${loginId}`;
      expect((await f.admin(path, undefined, f.config.runtimeToken.toString())).status).toBe(401);
      expect((await f.admin(path, undefined, "wrong-bearer")).status).toBe(401);
      const response = await f.admin(path);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ loginId, profileId: "personal", expiresAt: new Date(f.lease.expiresAt).toISOString(), manualLogin: false, state: "waiting", password: "fixtureVncPassword" });
      expect(await (await f.admin(`/admin/login/status?loginId=${loginId}`)).json()).not.toHaveProperty("password");
      for (const suffix of ["bad", `${loginId}&loginId=${loginId}`, `${loginId}&target=evil`]) expect((await f.admin(`/admin/login/session?loginId=${suffix}`)).status).toBe(400);
      expect((await f.admin("/admin/login/session?loginId=00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await f.admin("/admin/login/close", { loginId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
      expect((await f.admin(path)).status).toBe(200);
      const resumed = await f.runtime.profiles.startViewer("personal", false);
      expect(resumed).toMatchObject({ loginId, profileId: "personal", state: "waiting" });
      await expect(f.runtime.profiles.startViewer("other", false)).rejects.toThrow("already exists");
      const close = await f.admin("/admin/login/close", { loginId });
      expect(await close.json()).toMatchObject({ loginId, state: "closed" });
      expect((await f.admin(path)).status).toBe(404);
      expect(f.lease.password).toBe("");
    } finally { await f.close(); }
  });
  test("complete requires admin auth, a canonical exact ID, and a human rather than approval lease", async () => {
    const f = await fixture();
    try {
      expect((await f.admin("/admin/login/complete", { loginId }, f.config.runtimeToken.toString())).status).toBe(401);
      for (const body of [{ loginId: "invalid" }, { loginId, profileId: "other" }, {}]) expect((await f.admin("/admin/login/complete", body)).status).toBe(400);
      expect((await f.admin("/admin/login/complete", { loginId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
      const response = await f.admin("/admin/login/complete", { loginId });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(f.runtime.profiles.viewerStatus(loginId)).toMatchObject({ manualLogin: false, state: "waiting" });
      expect(f.lease.child.exitCode).toBeNull();
      expect(f.lease.password).toBe("fixtureVncPassword");
    } finally { await f.close(); }
  });

  test.skipIf(process.platform !== "linux")("closing a resistant viewer revokes credentials before forcibly settling its child", async () => {
    const f = await fixture(true);
    try {
      const closing = f.runtime.profiles.closeViewer();
      expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(404);
      expect(f.lease.password).toBe("");
      await closing;
      expect(f.lease.child.signalCode).toBe("SIGKILL");
      expect(f.runtime.profiles.viewerStatus(loginId).state).toBe("closed");
    } finally { await f.close(); }
  });

  test("expired or draining lease rejects session and revokes transports before child settlement", async () => {
    for (const terminal of ["expired", "drained"] as const) {
      const f = await fixture();
      try {
        let revoked = false;
        f.runtime.profiles.attachViewerTransport(loginId, () => { revoked = true; });
        if (terminal === "expired") f.lease.expiresAt = Date.now() - 1;
        else f.runtime.state.drain("fixture-maintenance");
        expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(404);
        expect(revoked).toBe(true);
        expect(f.lease.password).toBe("");
      } finally { await f.close(); }
    }
  });

  test("runtime websocket forwards real TCP RFB greeting and negotiation, then exact close destroys transport", async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const tcp = createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.write("RFB 003.008\n");
      socket.once("data", data => { expect(data.toString()).toBe("RFB 003.008\n"); socket.write(Buffer.from([1, 1])); });
    });
    try {
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(5900, "127.0.0.1", resolve); });
      for (const payload of ["text is not RFB", Buffer.alloc(1024 * 1024 + 1)]) {
        const rejected = f.connect();
        await opened(rejected);
        const ended = closed(rejected); rejected.send(payload); await ended;
        expect((await f.admin(`/admin/login/session?loginId=${loginId}`)).status).toBe(200);
      }
      const ws = f.connect(); ws.binaryType = "arraybuffer";
      let finish!: () => void;
      const negotiated = new Promise<void>(resolve => { finish = resolve; }); let phase = 0;
      ws.addEventListener("message", event => {
        const data = Buffer.from(event.data);
        if (phase++ === 0) { expect(data.toString()).toBe("RFB 003.008\n"); ws.send(Buffer.from("RFB 003.008\n")); }
        else { expect(data).toEqual(Buffer.from([1, 1])); finish(); }
      });
      await opened(ws); await negotiated;
      const ended = closed(ws);
      await f.admin("/admin/login/close", { loginId }); await ended;
      expect(f.lease.transports.size).toBe(0);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => tcp.close(() => resolve())); await f.close(); }
  });

  test("TCP-to-viewer buffering refuses queued bytes beyond the hard bound", async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const tcp = createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.write("RFB 003.008\n");
    });
    let closedCode!: number;
    let finish!: () => void;
    const rejected = new Promise<void>(resolve => { finish = resolve; });
    try {
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(5900, "127.0.0.1", resolve); });
      // The websocket send sink is deliberately full; the TCP greeting must not
      // allocate another queued message or be silently dropped.
      new ViewerTransport({ getBufferedAmount: () => VIEWER_MAX_BUFFER, send: () => { throw new Error("Must not queue beyond limit"); }, close: code => { closedCode = code!; finish(); } }, f.runtime.profiles, loginId);
      await rejected;
      expect(closedCode).toBe(1009);
      expect(f.lease.transports.size).toBe(0);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => tcp.close(() => resolve())); await f.close(); }
  });
});
