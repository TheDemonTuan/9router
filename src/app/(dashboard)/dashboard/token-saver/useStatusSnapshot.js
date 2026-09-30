"use client";
import { useEffect, useRef, useState } from "react";
import { RTK_CONFIG } from "open-sse/config/rtkConfig.js";

export default function useStatusSnapshot(url) {
  const [snapshot, setSnapshot] = useState(null);
  const [receivedAt, setReceivedAt] = useState(null);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reset, setReset] = useState(false);
  const session = useRef(null);
  useEffect(() => {
    if (authRequired) return;
    let alive = true, running = false, stopped = false, queued = false;
    let timer, deadline, controller;
    async function refresh() {
      if (!alive || stopped || document.hidden) return;
      if (running) { queued = true; return; }
      running = true;
      controller = new AbortController();
      let timedOut = false;
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, RTK_CONFIG.statusRequestMs);
      try {
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!alive || controller.signal.aborted) return;
        if (res.status === 401 || res.status === 403) {
          stopped = true; setAuthRequired(true); setError("Sign in to view status. Reload after signing in."); return;
        }
        if (!res.ok) throw Error("Status unavailable");
        const data = await res.json();
        if (!alive || controller.signal.aborted) return;
        if (session.current && session.current !== data.session.id) setReset(true);
        session.current = data.session.id;
        setSnapshot(data); setReceivedAt(new Date().toISOString()); setError("");
      } catch {
        if (alive && (timedOut || !controller.signal.aborted)) setError(timedOut ? "Status request timed out; last received values retained." : "Status unavailable; last received values retained.");
      } finally {
        clearTimeout(deadline); running = false;
        if (alive && !stopped && !document.hidden) { timer = setTimeout(refresh, queued ? 0 : RTK_CONFIG.statusPollMs); queued = false; }
      }
    }
    function visibility() { clearTimeout(timer); if (document.hidden) { queued = false; controller?.abort(); } else refresh(); }
    document.addEventListener("visibilitychange", visibility); refresh();
    return () => { alive = false; clearTimeout(timer); clearTimeout(deadline); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [url, refreshKey, authRequired]);
  return { snapshot, receivedAt, error, authRequired, reset, refresh: () => setRefreshKey(k => k + 1) };
}
