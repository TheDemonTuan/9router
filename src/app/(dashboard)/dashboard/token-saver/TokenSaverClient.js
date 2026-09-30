"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Modal, Toggle } from "@/shared/components";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import RtkStats from "./RtkStats";
import SessionDedupStats from "./SessionDedupStats";
import { isValidSessionDedupMode } from "open-sse/config/tokenSaverConfig.js";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [rtkSaving, setRtkSaving] = useState(false);
  const [rtkError, setRtkError] = useState("");
  const [sessionDedupMode, setSessionDedupMode] = useState(null);
  const [sessionDedupSaving, setSessionDedupSaving] = useState(false);
  const [sessionDedupError, setSessionDedupError] = useState("");
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [pxpipeEnabled, setPxpipeEnabled] = useState(false);
  const [pxpipeMinChars, setPxpipeMinChars] = useState(25000);
  const [pxpipeStatus, setPxpipeStatus] = useState({
    installed: false,
    installing: false,
    running: false,
    version: null,
    loading: true,
  });
  const [pxpipeHealth, setPxpipeHealth] = useState(null);
  const [showPxpipeModal, setShowPxpipeModal] = useState(false);
  const [pxpipeActionLoading, setPxpipeActionLoading] = useState(false);
  const [pxpipeActionError, setPxpipeActionError] = useState("");
  const [locale, setLocale] = useState(() => getCurrentLocale());
  const [showWenyan, setShowWenyan] = useState(false);

  useEffect(() => {
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const isSelectedWenyan = CAVEMAN_LEVELS.some((lvl) => lvl.id === cavemanLevel && lvl.wenyan);
  const showAllCavemanLevels = isWenyanLocale || isSelectedWenyan || showWenyan;
  const visibleCavemanLevels = showAllCavemanLevels
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);
  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };


  const handleRtkEnabled = async (value) => {
    setRtkSaving(true);
    setRtkError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (!res.ok) throw Error("RTK setting could not be saved.");
      setRtkEnabledState(value);
    } catch {
      setRtkError("RTK setting could not be saved. Please retry.");
    } finally {
      setRtkSaving(false);
    }
  };

  const handleSessionDedupMode = async (mode) => {
    if (sessionDedupSaving || sessionDedupMode === null) return;
    setSessionDedupSaving(true);
    setSessionDedupError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDedupMode: mode }),
      });
      if (!res.ok) throw Error("Setting unavailable");
      setSessionDedupMode(mode);
    } catch {
      setSessionDedupError("Session Dedup setting could not be saved. Please retry.");
    } finally {
      setSessionDedupSaving(false);
    }
  };
  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };


  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const refreshPxpipeStatus = useCallback(async () => {
    setPxpipeStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/pxpipe/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setPxpipeStatus({ ...data, loading: false });
      if (typeof data.minChars === "number") setPxpipeMinChars(data.minChars);
    } catch {
      setPxpipeStatus({ installed: false, installing: false, running: false, version: null, loading: false });
    }
  }, []);

  const runPxpipeHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/pxpipe/health", { method: "POST" });
      setPxpipeHealth(await res.json());
    } catch (e) {
      setPxpipeHealth({ healthy: false, checks: [], error: e.message });
    }
  }, []);

  const pxpipeAction = useCallback(
    async (endpoint) => {
      setPxpipeActionError("");
      setPxpipeActionLoading(true);
      try {
        const res = await fetch(`/api/pxpipe/${endpoint}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `PXPIPE ${endpoint} failed`);
        await refreshPxpipeStatus();
        await runPxpipeHealth();
      } catch (e) {
        setPxpipeActionError(e.message);
      } finally {
        setPxpipeActionLoading(false);
      }
    },
    [refreshPxpipeStatus, runPxpipeHealth]
  );

  const handlePxpipeEnabled = (value) => {
    setPxpipeEnabled(value);
    patchSetting({ pxpipeEnabled: value });
  };

  const handlePxpipeMinCharsBlur = () => {
    const next = Math.max(0, Number(pxpipeMinChars) || 25000);
    setPxpipeMinChars(next);
    patchSetting({ pxpipeMinChars: next });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setSessionDedupMode(isValidSessionDedupMode(data.sessionDedupMode) ? data.sessionDedupMode : "shadow");
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number") setPxpipeMinChars(data.pxpipeMinChars);
          // PRD: run the PXPIPE health check automatically when the page opens
          refreshPxpipeStatus().then(runPxpipeHealth);
        } else {
          setSessionDedupError("Session Dedup settings unavailable. Reload to retry.");
        }
      } catch {
        setSessionDedupError("Session Dedup settings unavailable. Reload to retry.");
      }
    };
    loadSettings();
  }, [refreshPxpipeStatus, runPxpipeHealth]);


  const pxpipeHealthy = pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipeStatus.loading
    ? "Checking…"
    : pxpipeStatus.installing
      ? "Installing…"
      : !pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <div className="space-y-6 p-6">
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Compress recognized tool output with local filters and the optional upstream Rust RTK sidecar. Unsupported formats remain unchanged.
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
            label="RTK enabled"
            disabled={rtkSaving}
          />
        </div>
        {rtkError && <p role="alert" className="text-sm text-warning">{rtkError}</p>}
        <RtkStats enabled={rtkEnabled} />
        <div className="flex flex-col items-start sm:flex-row sm:items-center justify-between pt-4 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Session Dedup{" "}
              <span className="text-xs text-text-muted">
                {sessionDedupMode === "shadow"
                  ? "Shadow — measuring only; tool results are not deduplicated."
                  : sessionDedupMode === "on"
                  ? "On — verified replacements written to prepared body."
                  : sessionDedupMode === "off"
                  ? "Off — hashing disabled."
                  : "Loading…"}
              </span>
            </p>
            <p className="text-sm text-text-muted">
              Exact repeated historical tool results and completed batches in the same turn. The latest two completed batches, pending/ambiguous batches, previous two user turns, and cache/opaque states are protected.
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <label htmlFor="session-dedup-mode" className="text-sm font-medium sr-only">
              Session Dedup mode
            </label>
            <select
              id="session-dedup-mode"
              aria-label="Session Dedup mode"
              value={sessionDedupMode ?? "shadow"}
              onChange={(event) => handleSessionDedupMode(event.target.value)}
              disabled={sessionDedupSaving || sessionDedupMode === null}
              className="bg-surface border border-border rounded px-3 py-2 text-sm font-medium"
            >
              <option value="off">Off</option>
              <option value="shadow">Shadow</option>
              <option value="on">On</option>
            </select>
          </div>
        </div>
        {sessionDedupError && <p role="alert" className="text-sm text-warning">{sessionDedupError}</p>}
        {sessionDedupMode === "on" && (
          <p className="text-sm text-warning">
            Historical rewrites can reduce implicit prompt-cache reuse. Saved bytes are not billed-token or cost savings. Incoming pre-deduplicated history bypasses mutations.
          </p>
        )}
        <SessionDedupStats mode={sessionDedupMode} />
        <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Shorter chat responses{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Encourages shorter chat replies; adds prompt overhead. Net savings depend on workload.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                  {!showAllCavemanLevels && (
                    <button
                      type="button"
                      onClick={() => setShowWenyan(true)}
                      className="px-2 py-1.5 rounded text-xs font-medium border border-dashed border-border text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
                      title="Show Classical Chinese (Wenyan) levels"
                    >
                      + 文言
                    </button>
                  )}
                  {showWenyan && !isWenyanLocale && !isSelectedWenyan && (
                    <button
                      type="button"
                      onClick={() => setShowWenyan(false)}
                      className="px-1.5 py-1.5 rounded text-xs text-text-muted hover:text-text"
                      title="Hide Wenyan levels"
                    >
                      ×
                    </button>
                  )}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Understand first, reuse existing code, then make the smallest complete change.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
        <p className="text-xs text-text-muted pt-3 mt-3 border-t border-border">
          Style instructions apply only to eligible requests. Native passthrough, structured output and token-saver opt-out skip injection.
        </p>
        {/* PXPIPE hidden from UI — experimental, not exposed to users yet */}
        {false && (
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress prompts as images{" "}
                <a
                  href="https://github.com/teamchong/pxpipe"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (PXPIPE)
                </a>
              </p>
              <span className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}>
                {pxpipeStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowPxpipeModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {pxpipeStatus.installed ? "Manage" : "Setup"}
              </button>
              <a
                href="/dashboard/pxpipe"
                className="text-xs text-primary underline hover:opacity-80"
              >
                Dashboard
              </a>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Transforms large textual context into optimized images before
              sending to the LLM. Ideal for huge prompts, tool outputs and long
              conversations.
            </p>
          </div>
          <Toggle
            checked={pxpipeEnabled}
            disabled={!pxpipeStatus.installed}
            onChange={() => handlePxpipeEnabled(!pxpipeEnabled)}
          />
        </div>
        )}
      </Card>

      <Modal
        isOpen={false}
        title={pxpipeStatus.installed ? "PXPIPE" : "Setup PXPIPE"}
        onClose={() => setShowPxpipeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Compress prompts using multimodal encoding. Runs in-process — no
            extra server or environment variables required.
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span className={pxpipeHealthy || pxpipeStatus.running ? "text-success" : "text-warning"}>
              {pxpipeStatusLabel}
              {pxpipeStatus.version ? ` · v${pxpipeStatus.version}` : ""}
            </span>
          </div>
          {pxpipeHealth?.checks?.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <p className="text-sm font-medium mb-1">Health check</p>
              {pxpipeHealth.checks.map((check) => (
                <div key={check.id} className="flex items-center justify-between text-xs">
                  <span className={check.ok ? "text-success" : "text-warning"}>
                    {check.ok ? "●" : "○"} {check.label}
                  </span>
                  {check.detail && (
                    <span className="text-text-muted font-mono truncate max-w-[50%]">{check.detail}</span>
                  )}
                </div>
              ))}
              {pxpipeHealth.error && (
                <p className="text-xs text-warning mt-1">{pxpipeHealth.error}</p>
              )}
            </div>
          )}
          {!pxpipeStatus.installed ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-warning">PXPIPE is not installed.</p>
              <Button
                onClick={() => pxpipeAction("install")}
                fullWidth
                disabled={pxpipeActionLoading || pxpipeStatus.installing}
              >
                {pxpipeActionLoading || pxpipeStatus.installing ? "Installing…" : "Install"}
              </Button>
              <p className="text-xs text-text-muted">
                Installs the npm package <code className="font-mono">pxpipe-proxy</code> into
                the 9Router data directory. May take a few minutes.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {pxpipeStatus.running ? (
                <>
                  <Button onClick={() => pxpipeAction("restart")} variant="ghost" disabled={pxpipeActionLoading}>
                    Restart
                  </Button>
                  <Button onClick={() => pxpipeAction("stop")} variant="ghost" disabled={pxpipeActionLoading}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button onClick={() => pxpipeAction("start")} disabled={pxpipeActionLoading}>
                  {pxpipeActionLoading ? "Starting…" : "Start"}
                </Button>
              )}
              <Button onClick={() => pxpipeAction("install")} variant="ghost" disabled={pxpipeActionLoading}>
                Repair
              </Button>
              <a
                href="/dashboard/pxpipe#logs"
                className="col-span-2 rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
              >
                Open Logs
              </a>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Minimum prompt size (chars)</p>
            <Input
              value={String(pxpipeMinChars)}
              onChange={(e) => setPxpipeMinChars(e.target.value)}
              onBlur={handlePxpipeMinCharsBlur}
              placeholder="25000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Requests smaller than this bypass PXPIPE and are sent as-is.
            </p>
          </div>
          {pxpipeActionError && (
            <p className="text-sm text-warning">{pxpipeActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshPxpipeStatus().then(runPxpipeHealth)}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button onClick={() => setShowPxpipeModal(false)} fullWidth>
              Done
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}
