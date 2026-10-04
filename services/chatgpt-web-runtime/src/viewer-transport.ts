import { connect } from "node:net";
import type { Socket } from "node:net";
import type { RuntimeProfiles } from "./profiles";

export const VIEWER_MAX_MESSAGE = 1024 * 1024;
export const VIEWER_MAX_BUFFER = 4 * 1024 * 1024;
export const LOGIN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface ViewerSocket {
  send(data: Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

// Only the runtime-owned VNC listener is reachable. Lease revocation destroys TCP
// before a later profile can reuse this port; no caller controls the destination.
export class ViewerTransport {
  private tcp?: Socket;
  private detach?: () => void;
  private closed = false;
  constructor(private readonly ws: ViewerSocket, profiles: RuntimeProfiles, loginId: string) {
    this.detach = profiles.attachViewerTransport(loginId, () => this.close());
    this.tcp = connect({ host: "127.0.0.1", port: 5900 });
    this.tcp.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      if (ws.getBufferedAmount() + chunk.length > VIEWER_MAX_BUFFER) return this.close(1009);
      const sent = ws.send(chunk);
      if (sent === 0) this.close(1011);
      else if (sent === -1) this.tcp?.pause();
    });
    this.tcp.on("error", () => this.close(1011));
    this.tcp.on("close", () => this.close());
  }
  message(data: string | Uint8Array) {
    if (this.closed) return;
    if (typeof data === "string") return this.close(1003);
    if (data.byteLength > VIEWER_MAX_MESSAGE || !this.tcp || this.tcp.writableLength + data.byteLength > VIEWER_MAX_BUFFER) return this.close(1009);
    this.tcp.write(data);
  }
  drain() { if (!this.closed) this.tcp?.resume(); }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.tcp?.destroy();
    this.ws.close(code, "Viewer ended");
  }
}
