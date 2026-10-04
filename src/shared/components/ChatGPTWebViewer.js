"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

const BASE = "/api/providers/chatgpt-web/runtime";

export default function ChatGPTWebViewer({ loginId, profileId, expiresAt, onEnded }) {
  const viewport = useRef(null);
  const ended = useRef(onEnded);
  const [status, setStatus] = useState("Opening private browser…");
  const [failed, setFailed] = useState(false);
  useEffect(() => { ended.current = onEnded; }, [onEnded]);
  useEffect(() => {
    const controller = new AbortController();
    let rfb;
    let timer;
    const finish = state => {
      if (controller.signal.aborted) return;
      controller.abort();
      rfb?.disconnect();
      ended.current(state);
    };
    async function connect() {
      try {
        const response = await fetch(`${BASE}/login/session?loginId=${encodeURIComponent(loginId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) {
          if ([404, 410].includes(response.status)) {
            const statusResponse = await fetch(`${BASE}/login/status?loginId=${encodeURIComponent(loginId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
            const terminal = statusResponse.ok ? await statusResponse.json() : null;
            finish(terminal?.loginId === loginId && terminal.profileId === profileId && ["completed", "expired", "closed", "error"].includes(terminal.state) ? terminal.state : "closed");
            return;
          }
          throw new Error("Private browser unavailable. Close the viewer and try View Browser again.");
        }
        const session = await response.json();
        if (controller.signal.aborted) return;
        if (session.loginId !== loginId || session.profileId !== profileId || session.state !== "waiting" || typeof session.password !== "string" || !session.password || !Number.isFinite(Date.parse(session.expiresAt))) throw new Error("Invalid private browser session.");
        const remaining = Math.min(Date.parse(expiresAt), Date.parse(session.expiresAt)) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) { finish("expired"); return; }
        timer = setTimeout(() => finish("expired"), remaining);
        const { default: RFB } = await import("@novnc/novnc");
        if (controller.signal.aborted) return;
        const url = new URL(`${BASE}/login/viewer`, window.location.origin);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("loginId", loginId);
        rfb = new RFB(viewport.current, url.href, { credentials: { password: session.password } });
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        rfb.viewOnly = false;
        rfb.addEventListener("connect", () => { if (!controller.signal.aborted) setStatus("Connected. Sign in to ChatGPT in the browser below. Verification runs automatically."); });
        rfb.addEventListener("disconnect", () => {
          if (!controller.signal.aborted) { setFailed(true); setStatus("Browser disconnected. Close the viewer and use View Browser to resume an active session."); }
        });
        rfb.addEventListener("securityfailure", () => {
          if (!controller.signal.aborted) { setFailed(true); setStatus("Private browser authentication failed. End this login and start a new one."); rfb.disconnect(); }
        });
      } catch (cause) {
        if (!controller.signal.aborted) { setFailed(true); setStatus(cause.message || "Private browser unavailable."); }
      }
    }
    void connect();
    return () => { controller.abort(); clearTimeout(timer); rfb?.disconnect(); };
  }, [loginId, profileId, expiresAt]);

  return <div className="space-y-2">
    <p role={failed ? "alert" : "status"} className={`text-sm ${failed ? "text-red-400" : "text-text-muted"}`}>{status}</p>
    <div ref={viewport} aria-label="Interactive private ChatGPT browser" className="h-[480px] w-full overflow-hidden rounded-lg border border-border bg-black" />
    <p className="text-xs text-text-muted">Keyboard and pointer input stay in this private browser. Clipboard is not automatically shared. Closing the viewer disconnects it; the login lease expires automatically.</p>
  </div>;
}

ChatGPTWebViewer.propTypes = { loginId: PropTypes.string.isRequired, profileId: PropTypes.string.isRequired, expiresAt: PropTypes.string.isRequired, onEnded: PropTypes.func.isRequired };
