import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Treemap from "./Treemap";
import Stats from "./Stats";
import ListPanel from "./ListPanel";
import type {
  ProgressPayload,
  ScanDone,
  ViewNode,
  ViewPayload,
} from "./types";
import { formatBytes, formatDuration, formatNumber } from "./format";

type Phase = "idle" | "scanning" | "done" | "error";
type View = "treemap" | "stats";

interface Crumb {
  path: string;
  name: string;
}

const VIEW_DEPTH = 4;
const VIEW_BUDGET = 3000;
const ZERO_PROGRESS: ProgressPayload = {
  scan_id: 0,
  files: 0,
  dirs: 0,
  bytes: 0,
  errors: 0,
  current: "",
};

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [path, setPath] = useState<string>("");
  const [summary, setSummary] = useState<ScanDone | null>(null);
  const [view, setView] = useState<ViewPayload | null>(null);
  const [progress, setProgress] = useState<ProgressPayload>(ZERO_PROGRESS);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [stack, setStack] = useState<Crumb[]>([]);
  const [tab, setTab] = useState<View>("treemap");
  const [listPath, setListPath] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Generation counter: each startScan bumps it; async results from an older
  // generation are dropped instead of clobbering the new scan's state.
  const genRef = useRef(0);
  const stackRef = useRef<Crumb[]>([]);
  stackRef.current = stack;
  const viewCache = useRef<Map<string, ViewPayload>>(new Map());

  // Resolve home dir as the default path once on mount. (Keyed on nothing:
  // clearing the input must NOT repopulate it.)
  useEffect(() => {
    invoke<string>("home_dir")
      .then((h) => setPath((p) => p || h))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ProgressPayload>("scan://progress", (event) => {
      setProgress((prev) =>
        event.payload.scan_id >= prev.scan_id ? event.payload : prev
      );
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const fetchView = useCallback(async (targetPath?: string) => {
    const gen = genRef.current;
    if (targetPath) {
      const cached = viewCache.current.get(targetPath);
      if (cached) {
        setView(cached);
        return;
      }
    }
    try {
      const vp = await invoke<ViewPayload>("get_view", {
        path: targetPath ?? null,
        depth: VIEW_DEPTH,
        budget: VIEW_BUDGET,
      });
      if (genRef.current !== gen) return;
      setView(vp);
      if (vp.complete) {
        viewCache.current.set(vp.root.path, vp);
      }
      setStack((s) =>
        s.length === 0 ? [{ path: vp.root.path, name: vp.root.name }] : s
      );
    } catch {
      // Races during scan startup/teardown are expected; the next poll or
      // navigation will succeed.
    }
  }, []);

  // While scanning, poll the (partial) view so the treemap fills in live.
  useEffect(() => {
    if (phase !== "scanning") return;
    const tick = () => {
      const top = stackRef.current[stackRef.current.length - 1];
      fetchView(top?.path);
    };
    const t0 = setTimeout(tick, 400);
    const iv = setInterval(tick, 1200);
    return () => {
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, [phase, fetchView]);

  // If a cancel returned before finalization finished (walker stuck in a
  // syscall), keep polling for the full summary and upgrade when it lands.
  useEffect(() => {
    if (phase !== "done" || !summary?.cancelled) return;
    if (summary.stats.by_category.length > 0 || summary.total_files === 0)
      return;
    const gen = genRef.current;
    const iv = setInterval(async () => {
      try {
        const full = await invoke<ScanDone | null>("get_summary");
        if (genRef.current !== gen) return;
        if (full && full.scan_id === summary.scan_id) {
          setSummary(full);
          viewCache.current.clear();
          const top = stackRef.current[stackRef.current.length - 1];
          fetchView(top?.path);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [phase, summary, fetchView]);

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
    const gen = ++genRef.current;
    setPhase("scanning");
    setSummary(null);
    setView(null);
    setStack([]);
    setListPath(null);
    setCancelling(false);
    setProgress(ZERO_PROGRESS);
    setErrorMsg("");
    viewCache.current.clear();
    try {
      const done = await invoke<ScanDone>("start_scan", { path });
      if (genRef.current !== gen) return; // superseded by a newer scan
      setSummary(done);
      setPhase("done");
      // Refresh the current view with authoritative (finalized) totals.
      viewCache.current.clear();
      const top = stackRef.current[stackRef.current.length - 1];
      fetchView(top?.path);
    } catch (e) {
      if (genRef.current !== gen) return;
      setErrorMsg(String(e));
      setPhase("error");
    }
  }, [path, fetchView]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await invoke("cancel_scan");
    } catch {
      /* noop */
    }
  }, []);

  const drillDown = useCallback(
    (node: ViewNode) => {
      if (node.aggregated && node.aggregated_parent) {
        setListPath(node.aggregated_parent);
        return;
      }
      if (node.skip_reason || !node.is_dir) return;
      setStack((s) => [...s, { path: node.path, name: node.name }]);
      fetchView(node.path);
    },
    [fetchView]
  );

  const goTo = useCallback(
    (index: number) => {
      const target = stackRef.current[index];
      if (!target) return;
      setStack((s) => s.slice(0, index + 1));
      fetchView(target.path);
    },
    [fetchView]
  );

  const openDirFromList = useCallback(
    (dirPath: string, name: string) => {
      setListPath(null);
      setStack((s) => [...s, { path: dirPath, name }]);
      fetchView(dirPath);
    },
    [fetchView]
  );

  const current = view?.root ?? null;
  const showResults = (phase === "done" || phase === "scanning") && current;

  return (
    <div className="app-root">
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
            placeholder="/Users/you  or  /  for the whole startup disk"
            aria-label="Folder to scan"
          />
          <button
            className="btn btn-ghost"
            onClick={browse}
            disabled={phase === "scanning"}
          >
            Browse…
          </button>
          {phase === "scanning" ? (
            <button
              className="btn btn-danger"
              onClick={cancel}
              disabled={cancelling}
            >
              {cancelling ? "Stopping…" : "Stop"}
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
        <div className="status-banner" role="status">
          <div className="spinner" />
          <div className="status-stats">
            <span>
              <strong>{formatNumber(progress.files)}</strong> files
            </span>
            <span>
              <strong>{formatNumber(progress.dirs)}</strong> folders
            </span>
            <span>
              <strong>{formatBytes(progress.bytes)}</strong> found
            </span>
            {progress.errors > 0 && (
              <span className="warn">
                <strong>{formatNumber(progress.errors)}</strong> unreadable
              </span>
            )}
          </div>
          <div className="status-current" title={progress.current}>
            {progress.current}
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="error-banner" role="alert">
          <strong>Scan failed:</strong> {errorMsg}
          {errorMsg.toLowerCase().includes("permission") && (
            <div className="error-hint">
              macOS may require granting <strong>Full Disk Access</strong> to
              DiskAudit in System Settings → Privacy &amp; Security to scan
              protected locations.
            </div>
          )}
        </div>
      )}

      {phase === "done" && summary?.cancelled && (
        <div className="notice-banner" role="status">
          Scan stopped early — showing what was found up to that point.
        </div>
      )}
      {phase === "done" && summary?.root_note && (
        <div className="notice-banner info" role="note">
          {summary.root_note}
        </div>
      )}

      {phase === "done" && summary && (
        <div className="summary-bar">
          <div className="summary-cell">
            <span className="summary-label">On disk</span>
            <span className="summary-value">
              {formatBytes(summary.allocated_bytes)}
            </span>
          </div>
          <div className="summary-cell">
            <span className="summary-label">Files</span>
            <span className="summary-value">
              {formatNumber(summary.total_files)}
            </span>
          </div>
          <div className="summary-cell">
            <span className="summary-label">Folders</span>
            <span className="summary-value">
              {formatNumber(summary.total_dirs)}
            </span>
          </div>
          <div className="summary-cell">
            <span className="summary-label">Unreadable</span>
            <span
              className={`summary-value ${
                summary.permission_errors > 0 ? "warn" : ""
              }`}
            >
              {formatNumber(summary.permission_errors)}
            </span>
          </div>
          <div className="summary-cell">
            <span className="summary-label">Scan time</span>
            <span className="summary-value">
              {formatDuration(summary.elapsed_ms)}
            </span>
          </div>
        </div>
      )}

      {showResults && (
        <>
          <div className="view-tabs" role="tablist">
            <button
              className={`view-tab ${tab === "treemap" ? "active" : ""}`}
              onClick={() => setTab("treemap")}
              role="tab"
              aria-selected={tab === "treemap"}
            >
              Treemap
            </button>
            <button
              className={`view-tab ${tab === "stats" ? "active" : ""}`}
              onClick={() => setTab("stats")}
              role="tab"
              aria-selected={tab === "stats"}
              disabled={!summary}
              title={summary ? undefined : "Available when the scan finishes"}
            >
              Statistics
            </button>
          </div>
          {tab === "treemap" && (
            <>
              <div className="breadcrumbs" aria-label="path navigation">
                {stack.length > 1 && (
                  <button
                    className="crumb back"
                    onClick={() => goTo(stack.length - 2)}
                    title="Go up one level"
                    aria-label="Go up one level"
                  >
                    ←
                  </button>
                )}
                {stack.map((c, i) => (
                  <span key={c.path} className="crumb-row">
                    <button
                      className={`crumb ${
                        i === stack.length - 1 ? "current" : ""
                      }`}
                      onClick={() => goTo(i)}
                      title={c.path}
                    >
                      {i === 0 ? c.path : c.name}
                    </button>
                    {i < stack.length - 1 && (
                      <span className="crumb-sep">›</span>
                    )}
                  </span>
                ))}
              </div>
              <main className="treemap-main">
                <Treemap root={current} onDrillDown={drillDown} />
              </main>
            </>
          )}
          {tab === "stats" && summary && (
            <main className="stats-main">
              <Stats summary={summary} />
            </main>
          )}
        </>
      )}

      {phase === "scanning" && !current && (
        <div className="empty-state">
          <h2>Scanning…</h2>
          <p>The map will appear as soon as the first results are in.</p>
        </div>
      )}

      {phase === "idle" && (
        <div className="empty-state">
          <h2>Pick a folder, then scan.</h2>
          <p>
            DiskAudit maps every file as a block proportional to the space it
            occupies on disk. Nothing is ever written, moved, or deleted.
          </p>
          <ul className="empty-tips">
            <li>Click a folder block to look inside it.</li>
            <li>Use the breadcrumbs (or ←) to go back up.</li>
            <li>Hover any block for its full path and exact size.</li>
          </ul>
        </div>
      )}

      {listPath && (
        <ListPanel
          path={listPath}
          onClose={() => setListPath(null)}
          onOpenDir={openDirFromList}
        />
      )}
    </div>
  );
}
