import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Treemap from "./Treemap";
import Stats from "./Stats";
import type { ProgressPayload, ScanResult, TreeNode } from "./types";
import { formatBytes, formatDuration, formatNumber } from "./format";

type Phase = "idle" | "scanning" | "done" | "error";
type View = "treemap" | "stats";

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [path, setPath] = useState<string>("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<ProgressPayload>({
    files: 0,
    dirs: 0,
    bytes: 0,
    errors: 0,
    current: "",
  });
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [stack, setStack] = useState<TreeNode[]>([]);
  const [view, setView] = useState<View>("treemap");

  // Resolve home dir as the default path on first load.
  useEffect(() => {
    if (!path) {
      invoke<string>("home_dir")
        .then((h) => setPath(h))
        .catch(() => {});
    }
  }, [path]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ProgressPayload>("scan://progress", (event) => {
      setProgress(event.payload);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const browse = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        setPath(selected);
      }
    } catch (e) {
      setErrorMsg(String(e));
    }
  }, []);

  const startScan = useCallback(async () => {
    if (!path) return;
    setPhase("scanning");
    setResult(null);
    setStack([]);
    setProgress({ files: 0, dirs: 0, bytes: 0, errors: 0, current: "" });
    setErrorMsg("");
    try {
      const r = await invoke<ScanResult>("start_scan", { path });
      setResult(r);
      setStack([r.root]);
      setPhase("done");
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }, [path]);

  const cancel = useCallback(async () => {
    try {
      await invoke("cancel_scan");
    } catch {
      /* noop */
    }
  }, []);

  const current = stack[stack.length - 1] ?? null;

  const drillDown = useCallback(async (node: TreeNode) => {
    if (node.aggregated && node.aggregated_parent) {
      try {
        const expanded = await invoke<TreeNode>("expand_aggregate", {
          parentPath: node.aggregated_parent,
        });
        setStack((s) => [...s, expanded]);
      } catch (e) {
        setErrorMsg(`Could not expand aggregate: ${e}`);
      }
      return;
    }
    setStack((s) => [...s, node]);
  }, []);

  const goUp = useCallback((depth: number) => {
    setStack((s) => s.slice(0, depth + 1));
  }, []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    },
    []
  );

  const summary = useMemo(() => {
    if (!result) return null;
    return (
      <div className="summary-bar">
        <div className="summary-cell">
          <span className="summary-label">Total size</span>
          <span className="summary-value">{formatBytes(result.total_bytes)}</span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">Files</span>
          <span className="summary-value">{formatNumber(result.total_files)}</span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">Folders</span>
          <span className="summary-value">{formatNumber(result.total_dirs)}</span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">Permission errors</span>
          <span
            className={`summary-value ${
              result.permission_errors > 0 ? "warn" : ""
            }`}
          >
            {formatNumber(result.permission_errors)}
          </span>
        </div>
        <div className="summary-cell">
          <span className="summary-label">Scan time</span>
          <span className="summary-value">
            {formatDuration(result.elapsed_ms)}
          </span>
        </div>
      </div>
    );
  }, [result]);

  return (
    <div className="app-root" onContextMenu={onContextMenu}>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <div className="brand-name">DiskAudit</div>
            <div className="brand-tag">Read-only disk usage explorer</div>
          </div>
        </div>
        <div className="path-controls">
          <input
            className="path-input"
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you  or  /  for full drive"
          />
          <button
            className="btn btn-ghost"
            onClick={browse}
            disabled={phase === "scanning"}
          >
            Browse…
          </button>
          {phase === "scanning" ? (
            <button className="btn btn-danger" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={startScan}
              disabled={!path}
            >
              Scan
            </button>
          )}
        </div>
      </header>

      {phase === "scanning" && (
        <div className="status-banner">
          <div className="spinner" />
          <div className="status-stats">
            <span>
              <strong>{formatNumber(progress.files)}</strong> files
            </span>
            <span>
              <strong>{formatNumber(progress.dirs)}</strong> dirs
            </span>
            <span>
              <strong>{formatBytes(progress.bytes)}</strong> scanned
            </span>
            {progress.errors > 0 && (
              <span className="warn">
                <strong>{formatNumber(progress.errors)}</strong> permission errors
              </span>
            )}
          </div>
          <div className="status-current" title={progress.current}>
            {progress.current}
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="error-banner">
          <strong>Scan failed:</strong> {errorMsg}
          {errorMsg.toLowerCase().includes("permission") && (
            <div className="error-hint">
              macOS may require granting <strong>Full Disk Access</strong> to
              DiskAudit in System Settings → Privacy & Security to scan
              protected locations. The scan will silently skip unreadable
              entries instead.
            </div>
          )}
        </div>
      )}

      {phase === "done" && result && current && (
        <>
          {summary}
          <div className="view-tabs" role="tablist">
            <button
              className={`view-tab ${view === "treemap" ? "active" : ""}`}
              onClick={() => setView("treemap")}
              role="tab"
              aria-selected={view === "treemap"}
            >
              Treemap
            </button>
            <button
              className={`view-tab ${view === "stats" ? "active" : ""}`}
              onClick={() => setView("stats")}
              role="tab"
              aria-selected={view === "stats"}
            >
              Statistics
            </button>
          </div>
          {view === "treemap" && (
            <>
              <div className="breadcrumbs" aria-label="path navigation">
                {stack.map((n, i) => (
                  <span key={n.path + ":" + i} className="crumb-row">
                    <button
                      className={`crumb ${
                        i === stack.length - 1 ? "current" : ""
                      }`}
                      onClick={() => goUp(i)}
                      title={n.path}
                    >
                      {i === 0 ? n.path : n.name}
                    </button>
                    {i < stack.length - 1 && (
                      <span className="crumb-sep">›</span>
                    )}
                  </span>
                ))}
                <span className="crumb-hint">
                  right-click anywhere to go up
                </span>
              </div>
              <main className="treemap-main">
                <Treemap root={current} onDrillDown={drillDown} />
              </main>
            </>
          )}
          {view === "stats" && (
            <main className="stats-main">
              <Stats result={result} />
            </main>
          )}
        </>
      )}

      {phase === "idle" && (
        <div className="empty-state">
          <h2>Pick a folder, then scan.</h2>
          <p>
            DiskAudit traverses the chosen path concurrently and visualizes
            every file as a block proportional to its size. Nothing is written,
            modified, or deleted — ever.
          </p>
          <ul className="empty-tips">
            <li>Click a folder block to drill down.</li>
            <li>Right-click anywhere (or use breadcrumbs) to go back up.</li>
            <li>Hover any block for the full path and exact size.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
