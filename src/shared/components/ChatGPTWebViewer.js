"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import Button from "./Button";

const BASE = "/api/providers/chatgpt-web/runtime";
const TERMINAL_STATES = new Set(["completed", "expired", "closed", "error"]);
function configureViewport(rfb, fit, pan) {
  rfb.scaleViewport = fit;
  rfb.clipViewport = !fit && pan;
  rfb.dragViewport = !fit && pan;
}

export default function ChatGPTWebViewer({ connectionName, loginId, profileId, expiresAt, manualLogin, verifying, error, onFinish, onClose, onEnded }) {
  const workspace = useRef(null);
  const viewport = useRef(null);
  const rfbRef = useRef(null);
  const ended = useRef(onEnded);
  const returnFocus = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const titleId = useId();
  const helpId = useId();
  const [status, setStatus] = useState("Opening private browser…");
  const [failed, setFailed] = useState(false);
  const [fit, setFit] = useState(true);
  const [panning, setPanning] = useState(false);
  const viewMode = useRef({ fit: true, panning: false });
  useEffect(() => { ended.current = onEnded; }, [onEnded]);

  useEffect(() => {
    viewMode.current = { fit, panning };
    if (rfbRef.current) configureViewport(rfbRef.current, fit, panning);
  }, [fit, panning]);

  useEffect(() => {
    const previousFocus = returnFocus.current;
    // The workspace is portaled beside the page, not inside the narrow connection modal.
    const background = Array.from(document.body.children)
      .filter(element => element instanceof HTMLElement && element !== workspace.current)
      .map(element => ({ element, inert: element.inert, hidden: element.getAttribute("aria-hidden") }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    workspace.current?.focus({ preventScroll: true });
    return () => {
      for (const { element, inert, hidden } of background) {
        element.inert = inert;
        if (hidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", hidden);
      }
      // React unsuspends the connection dialog in the same update. Restore after that update.
      queueMicrotask(() => {
        if (previousFocus?.isConnected && !previousFocus.closest("[inert]")) previousFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { ended.current("expired"); return; }
    const timer = setTimeout(() => ended.current("expired"), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (verifying) return;
    const controller = new AbortController();
    let rfb;
    const finish = state => {
      if (controller.signal.aborted) return;
      controller.abort();
      rfb?.disconnect();
      ended.current(state);
    };
    async function readTerminal() {
      const response = await fetch(`${BASE}/login/status?loginId=${encodeURIComponent(loginId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if ([404, 410].includes(response.status)) return "closed";
      if (!response.ok) return null;
      const session = await response.json();
      return session.loginId === loginId && session.profileId === profileId && typeof session.manualLogin === "boolean" && TERMINAL_STATES.has(session.state) ? session.state : null;
    }
    async function connect() {
      try {
        const response = await fetch(`${BASE}/login/session?loginId=${encodeURIComponent(loginId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) {
          if ([404, 410].includes(response.status)) { finish(await readTerminal() || "closed"); return; }
          throw new Error("Private browser unavailable. Back to Connection, then Open Browser to try again.");
        }
        const session = await response.json();
        if (controller.signal.aborted) return;
        setFailed(false);
        setStatus("Opening private browser…");
        if (session.loginId !== loginId || session.profileId !== profileId || session.state !== "waiting" || typeof session.manualLogin !== "boolean" || session.manualLogin !== manualLogin || typeof session.password !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(session.password) || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) !== Date.parse(expiresAt)) throw new Error("Invalid private browser session.");
        if (Math.min(Date.parse(expiresAt), Date.parse(session.expiresAt)) <= Date.now()) { finish("expired"); return; }
        const { default: RFB } = await import("@novnc/novnc");
        if (controller.signal.aborted) return;
        const url = new URL(`${BASE}/login/viewer`, window.location.origin);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("loginId", loginId);
        // The ephemeral password exists only in this fetch and the live transport, never in URLs/storage.
        rfb = new RFB(viewport.current, url.href, { credentials: { password: session.password } });
        rfbRef.current = rfb;
        configureViewport(rfb, viewMode.current.fit, viewMode.current.panning);
        rfb.resizeSession = true;
        rfb.viewOnly = false;
        rfb.addEventListener("connect", () => {
          if (!controller.signal.aborted) setStatus(manualLogin ? "Browser connected. Sign in, then choose Finish Sign In." : "Browser connected.");
        });
        rfb.addEventListener("disconnect", async () => {
          if (controller.signal.aborted) return;
          try {
            const terminal = await readTerminal();
            if (controller.signal.aborted) return;
            if (terminal) { finish(terminal); return; }
          } catch {
            if (controller.signal.aborted) return;
          }
          setFailed(true);
          setStatus("Browser disconnected. Back to Connection, then Open Browser to resume.");
        });
        rfb.addEventListener("securityfailure", () => {
          if (controller.signal.aborted) return;
          setFailed(true);
          setStatus("Private browser authentication failed. Back to Connection and end this session in Advanced.");
          controller.abort();
          rfb.disconnect();
        });
      } catch (cause) {
        if (!controller.signal.aborted) { setFailed(true); setStatus(cause.message || "Private browser unavailable."); }
      }
    }
    void connect();
    return () => { controller.abort(); rfb?.disconnect(); rfbRef.current = null; };
  }, [loginId, profileId, expiresAt, manualLogin, verifying]);

  const toolbarKeys = event => {
    // noVNC owns all keys inside the framebuffer, including Escape, Tab and browser shortcuts.
    if (event.key !== "Tab" || viewport.current?.contains(event.target)) return;
    const controls = Array.from(workspace.current.querySelectorAll("button:not(:disabled), [data-browser-viewport]"));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === workspace.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus();
    }
  };

  if (typeof document === "undefined") return null;
  const currentStatus = verifying ? "Checking your sign-in…" : panning && !failed ? "Drag to pan. Turn off Pan to interact." : status;
  return createPortal(
    <div ref={workspace} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={helpId} tabIndex={-1} onKeyDown={toolbarKeys} className="fixed inset-0 z-[100] flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-surface text-text-main">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:flex-nowrap sm:px-4">
        <div className="min-w-0 flex-1 basis-40">
          <h2 id={titleId} className="truncate text-sm font-semibold">{connectionName} — Browser</h2>
          <p role={!verifying && failed ? "alert" : "status"} className={`text-xs ${!verifying && failed ? "text-red-400" : "text-text-muted"}`}>{currentStatus}</p>
          {!verifying && error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
        {manualLogin && <Button aria-label="Finish Sign In" loading={verifying} onClick={onFinish}>Finish Sign In</Button>}
        <Button size="sm" variant="secondary" aria-label={fit ? "Actual Size" : "Fit to Window"} disabled={verifying} onClick={() => { setFit(value => !value); setPanning(false); }}>{fit ? "Actual size" : "Fit to window"}</Button>
        {!fit && <Button size="sm" variant="secondary" aria-label="Pan Browser" aria-pressed={panning} disabled={verifying} onClick={() => setPanning(value => !value)}>Pan</Button>}
        <Button variant="secondary" aria-label="Back to Connection" onClick={onClose}>Back to Connection</Button>
      </header>
      <div ref={viewport} data-browser-viewport tabIndex={0} role="region" aria-label="Interactive private ChatGPT browser" aria-describedby={helpId} onFocus={() => rfbRef.current?.focus()} onPointerDown={() => rfbRef.current?.focus()} className="min-h-0 w-full flex-1 overflow-hidden bg-black" />
      {verifying && <div className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-white">Checking your sign-in…</div>}
      <p id={helpId} className="sr-only">Keyboard and pointer input stay in this private browser. Clipboard is not automatically shared. Use Back to Connection to close this workspace without ending the session. Browser Escape does not close this workspace. Actual Size shows readable full-size text with scrollbars; use Pan on touch screens to move around, then turn Pan off to interact.</p>
    </div>,
    document.body,
  );
}

ChatGPTWebViewer.propTypes = { connectionName: PropTypes.string.isRequired, loginId: PropTypes.string.isRequired, profileId: PropTypes.string.isRequired, expiresAt: PropTypes.string.isRequired, manualLogin: PropTypes.bool.isRequired, verifying: PropTypes.bool.isRequired, error: PropTypes.string, onFinish: PropTypes.func.isRequired, onClose: PropTypes.func.isRequired, onEnded: PropTypes.func.isRequired };
