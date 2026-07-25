import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen, openDialog } from "./ipc";
import Treemap, { Highlight } from "./Treemap";
import Stats from "./Stats";
import ListPanel from "./ListPanel";
import SearchBar, { SearchRequest } from "./SearchBar";
import SkippedPanel from "./SkippedPanel";
import type {
  ProgressPayload,
  ScanDone,
  ViewNode,
  ViewPayload,
} from "./types";
import { formatBytes, formatDuration, formatNumber } from "./format";
import { Crumb, jumpTo, parentPath, pushCrumb, trailTo } from "./nav";
import { loadRecents, saveRecent, RecentScan } from "./recents";
import type { Category } from "./categories";

type Phase = "idle" | "scanning" | "done" | "error";
type Tab = "treemap" | "stats";

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
  const [tab, setTab] = useState<Tab>("treemap");
  const [listPath, setListPath] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [searchReq, setSearchReq] = useState<SearchRequest | null>(null);
  const [recents, setRecents] = useState<RecentScan[]>(() => loadRecents());
  const [fdaDismissed, setFdaDismissed] = useState(false);

  // Generation counter: each startScan bumps it; async results from an older
  // generation are dropped instead of clobbering the new scan's state.
  const genRef = useRef(0);
  const stackRef = useRef<Crumb[]>([]);
  stackRef.current = stack;
  const navDirRef = useRef<"down" | "up" | "jump">("jump");
  const viewCache = useRef<Map<string, ViewPayload>>(new Map());

  // Resolve home dir as the default path once on mount. (Keyed on nothing:
  // clearing the input must NOT repopulate it.)
  useEffect(() => {
    invoke<string>("home_dir")
      .then((h) => setPath((p) => p || h))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
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
      const selected = await openDialog();
      if (selected) setPath(selected);
    } catch (e) {
      setErrorMsg(String(e));
    }
  }, []);

  // `pathOverride` lets recents/menu trigger a scan without waiting for the
  // path state to commit. (Guarded by typeof: onClick passes a MouseEvent.)
  const startScan = useCallback(async (pathOverride?: unknown) => {
    const target =
      typeof pathOverride === "string" && pathOverride ? pathOverride : path;
    if (!target) return;
    const gen = ++genRef.current;
    setPhase("scanning");
    setSummary(null);
    setView(null);
    setStack([]);
    setListPath(null);
    setShowSkipped(false);
    setCancelling(false);
    setHighlight(null);
    setSearchReq(null);
    setFdaDismissed(false);
    setTab("treemap");
    setProgress(ZERO_PROGRESS);
    setErrorMsg("");
    viewCache.current.clear();
    try {
      const done = await invoke<ScanDone>("start_scan", { path: target });
      if (genRef.current !== gen) return; // superseded by a newer scan
      setSummary(done);
      setPhase("done");
      setRecents(saveRecent(done.root_path, done.allocated_bytes));
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
      navDirRef.current = "down";
      setHighlight(null);
      setStack((s) => pushCrumb(s, { path: node.path, name: node.name }));
      fetchView(node.path);
    },
    [fetchView]
  );

  const goTo = useCallback(
    (index: number) => {
      const target = stackRef.current[index];
      if (!target) return;
      navDirRef.current = "up";
      setHighlight(null);
      setStack((s) => jumpTo(s, index));
      fetchView(target.path);
    },
    [fetchView]
  );

  const goUpOne = useCallback(() => {
    if (stackRef.current.length > 1) {
      goTo(stackRef.current.length - 2);
    }
  }, [goTo]);

  /** Jump the treemap straight to a directory (search / stats / list). */
  const navigateToPath = useCallback(
    (dirPath: string, highlightPath?: string) => {
      const root = stackRef.current[0];
      if (!root) return;
      navDirRef.current = "jump";
      setTab("treemap");
      setListPath(null);
      setStack(trailTo(root, dirPath));
      setHighlight(
        highlightPath ? { path: highlightPath, ts: Date.now() } : null
      );
      fetchView(dirPath);
    },
    [fetchView]
  );

  const openDirFromList = useCallback(
    (dirPath: string, _name: string) => {
      navigateToPath(dirPath);
    },
    [navigateToPath]
  );

  // Keyboard: ⌘O browse, ⌘R rescan, Esc/Backspace/⌘↑ go up. (⌘F is handled
  // by the search bar; panels handle their own Esc in the capture phase.)
  const startScanRef = useRef(startScan);
  startScanRef.current = startScan;
  const browseRef = useRef(browse);
  browseRef.current = browse;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (phaseRef.current !== "scanning") browseRef.current();
        return;
      }
      if (cmd && e.key.toLowerCase() === "r") {
        e.preventDefault(); // also stops the webview from reloading
        if (phaseRef.current !== "scanning") startScanRef.current();
        return;
      }
      if (inField) return;
      if (
        e.key === "Escape" ||
        e.key === "Backspace" ||
        (cmd && e.key === "ArrowUp")
      ) {
        e.preventDefault();
        goUpOne();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUpOne]);

  // Native menu events (File → Open Folder… / Rescan).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen<void>("menu://open-folder", () => {
      if (phaseRef.current !== "scanning") browseRef.current();
    }).then((u) => unsubs.push(u));
    listen<void>("menu://rescan", () => {
      if (phaseRef.current !== "scanning") startScanRef.current();
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  const current = view?.root ?? null;
  const showResults = (phase === "done" || phase === "scanning") && current;
  const showFdaHint =
    phase === "done" &&
    !fdaDismissed &&
    (summary?.permission_errors ?? 0) > 0;

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
            onKeyDown={(e) => {
              if (e.key === "Enter" && phase !== "scanning") startScan();
            }}
          />
          <button
            className="btn btn-ghost"
            onClick={browse}
            disabled={phase === "scanning"}
            title="Choose a folder (⌘O)"
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
              title={phase === "done" ? "Rescan (⌘R)" : "Scan (⏎)"}
            >
              {phase === "done" && summary?.root_path === path
                ? "Rescan"
                : "Scan"}
            </button>
          )}
        </div>
      </header>

      {phase === "scanning" && (
        <div className="status-banner" role="status" aria-live="polite">
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
          Scan stopped early — showing what was found up to that point.{" "}
          <button className="link-btn" onClick={startScan}>
            Scan again
          </button>
        </div>
      )}
      {phase === "done" && summary?.root_note && (
        <div className="notice-banner info" role="note">
          {summary.root_note}
        </div>
      )}
      {showFdaHint && (
        <div className="notice-banner" role="status">
          {formatNumber(summary!.permission_errors)} item
          {summary!.permission_errors === 1 ? "" : "s"} couldn't be read —
          usually macOS privacy protection. Grant DiskAudit{" "}
          <strong>Full Disk Access</strong> in System Settings → Privacy &amp;
          Security, then rescan.{" "}
          <button className="link-btn" onClick={() => setFdaDismissed(true)}>
            Dismiss
          </button>
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
          {summary.skipped_total > 0 && (
            <button
              className="summary-cell summary-clickable"
              onClick={() => setShowSkipped(true)}
              title="What wasn't scanned, and why"
            >
              <span className="summary-label">Not scanned</span>
              <span className="summary-value">
                {formatNumber(summary.skipped_total)}{" "}
                <span className="summary-more">›</span>
              </span>
            </button>
          )}
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
          <div className="toolbar-row">
            <div className="view-tabs" role="tablist">
              <button
                className={`view-tab ${tab === "treemap" ? "active" : ""}`}
                onClick={() => setTab("treemap")}
                role="tab"
                aria-selected={tab === "treemap"}
              >
                Map
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
            <SearchBar
              enabled={phase === "done"}
              request={searchReq}
              onNavigate={navigateToPath}
            />
          </div>
          {tab === "treemap" && (
            <>
              <div className="breadcrumbs" aria-label="Path navigation">
                {stack.length > 1 && (
                  <button
                    className="crumb back"
                    onClick={goUpOne}
                    title="Go up one level (Esc, ⌘↑ or Backspace)"
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
              <main
                className={`treemap-main nav-${navDirRef.current}`}
                key={current.path + ":" + (view?.complete ? "c" : "l")}
              >
                <Treemap
                  root={current}
                  onDrillDown={drillDown}
                  highlight={highlight}
                />
              </main>
            </>
          )}
          {tab === "stats" && summary && (
            <main className="stats-main">
              <Stats
                summary={summary}
                onFileClick={(filePath) => {
                  const parent = parentPath(filePath);
                  if (parent) navigateToPath(parent, filePath);
                }}
                onExtClick={(ext) => setSearchReq({ ext, text: "" })}
                onCategoryClick={(cat) =>
                  setSearchReq({ category: cat as Category, text: "" })
                }
              />
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
          <h2>Where did the space go?</h2>
          <p>
            Pick a folder and scan it. Every file becomes a block sized by the
            space it occupies on disk — click the big ones to see what they
            are. DiskAudit never writes, moves, or deletes anything.
          </p>
          <ul className="empty-tips">
            <li>Click a folder block to look inside it.</li>
            <li>Go back up with the ← button, breadcrumbs, Esc or ⌘↑.</li>
            <li>When the scan finishes, search with ⌘F.</li>
          </ul>
          {recents.length > 0 && (
            <div className="recents">
              <div className="recents-title">Recent scans</div>
              {recents.map((r) => (
                <button
                  key={r.path}
                  className="recent-chip"
                  title={`Scan ${r.path} again`}
                  onClick={() => {
                    setPath(r.path);
                    startScanRef.current(r.path);
                  }}
                >
                  <span className="recent-path">{r.path}</span>
                  {r.bytes !== undefined && (
                    <span className="recent-size">{formatBytes(r.bytes)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {listPath && (
        <ListPanel
          path={listPath}
          onClose={() => setListPath(null)}
          onOpenDir={openDirFromList}
        />
      )}
      {showSkipped && summary && (
        <SkippedPanel summary={summary} onClose={() => setShowSkipped(false)} />
      )}
    </div>
  );
}
