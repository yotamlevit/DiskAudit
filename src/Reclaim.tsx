// The Reclaimable tab: what could be freed, grouped by WHY it's
// reclaimable, with visible confidence. Selection starts empty and is
// always explicit; "select all" exists only inside a single regenerable
// group or a single duplicate group — never across the tab, never into the
// gone-forever classes. Everything the tab produces (exports, deletion
// scripts) is clipboard text via shell.ts; the app never writes or runs it.

import { useEffect, useMemo, useState } from "react";
import type {
  DupGroup,
  ReclaimGroup,
  ReclaimItem,
  ReclaimProgress,
  ReclaimReport,
} from "./types";
import {
  formatAge,
  formatBytes,
  formatDate,
  formatNumber,
} from "./format";
import { copyText } from "./ipc";
import { parentPath } from "./nav";
import {
  deletionScript,
  exportCsv,
  exportJson,
  exportPlain,
  ReclaimExportItem,
  ScriptMode,
} from "./shell";
import { APP_VERSION } from "./version";

interface ReclaimProps {
  report: ReclaimReport | null;
  /** The underlying scan is still running (findings partial). */
  scanning: boolean;
  /** A duplicate pass is in flight right now. */
  dupActive: boolean;
  dupProgress: ReclaimProgress | null;
  home: string;
  onStartDup: () => void;
  onCancelDup: () => void;
  /** Jump the treemap to a directory (optionally highlighting a child). */
  onNavigate: (dirPath: string, highlightPath?: string) => void;
  onContext: (
    target: { path: string; name: string; isDir: boolean },
    x: number,
    y: number
  ) => void;
  onToast: (msg: string, danger?: boolean) => void;
}

/** Badge per reason-class: a cache and a stale personal file must not look
 * alike at a glance. */
const CLASS_BADGE: Record<string, { label: string; cls: string }> = {
  regenerable: { label: "regenerates — safe", cls: "badge-safe" },
  disposable: { label: "gone forever", cls: "badge-careful" },
  duplicate: { label: "keep one copy", cls: "badge-dup" },
  stale: { label: "hint — review first", cls: "badge-hint" },
};

const DUP_PHASE_LABEL: Record<string, string> = {
  collecting: "Collecting candidates",
  sampling: "Sampling likely matches",
  hashing: "Verifying byte-for-byte",
};

function toExportItem(
  item: ReclaimItem,
  group: ReclaimGroup
): ReclaimExportItem {
  return {
    path: item.path,
    size: item.size,
    isDir: item.is_dir,
    category: group.kind,
    confidence: group.confidence,
    reason: item.reason,
  };
}

function dupExportItem(copy: { path: string; size: number }, g: DupGroup): ReclaimExportItem {
  return {
    path: copy.path,
    size: copy.size,
    isDir: false,
    category: "duplicate",
    confidence: "careful",
    reason: `Duplicate copy of "${g.name}" — another copy is kept`,
  };
}

export default function Reclaim({
  report,
  scanning,
  dupActive,
  dupProgress,
  home,
  onStartDup,
  onCancelDup,
  onNavigate,
  onContext,
  onToast,
}: ReclaimProps) {
  const [selected, setSelected] = useState<Map<string, ReclaimExportItem>>(
    () => new Map()
  );
  const [scriptOpen, setScriptOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // A new scan means a new world: selection must not carry over.
  useEffect(() => {
    setSelected(new Map());
    setScriptOpen(false);
  }, [report?.scan_id]);

  const allExportItems = useMemo(() => {
    if (!report) return [];
    const items = report.groups.flatMap((g) =>
      g.items.map((i) => toExportItem(i, g))
    );
    for (const g of report.dup.groups) {
      for (const c of g.copies) {
        if (!c.keep && !c.in_finding) items.push(dupExportItem(c, g));
      }
    }
    return items;
  }, [report]);

  if (!report) {
    return (
      <div className="reclaim-root">
        <div className="reclaim-empty">Working out what could be freed…</div>
      </div>
    );
  }

  const selectedItems = [...selected.values()];
  const selectedBytes = selectedItems.reduce((s, i) => s + i.size, 0);
  const dup = report.dup;
  const dupRunning = dupActive || dup.status === "running";

  const toggle = (item: ReclaimExportItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.path)) next.delete(item.path);
      else next.set(item.path, item);
      return next;
    });
  };
  const setMany = (items: ReclaimExportItem[], on: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const i of items) {
        if (on) next.set(i.path, i);
        else next.delete(i.path);
      }
      return next;
    });
  };

  const doExport = async (kind: "csv" | "plain" | "json") => {
    setExportOpen(false);
    const items = selectedItems.length > 0 ? selectedItems : allExportItems;
    if (items.length === 0) {
      onToast("Nothing to export yet.");
      return;
    }
    const meta = {
      root: report.root,
      generatedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      home,
    };
    const text =
      kind === "csv"
        ? exportCsv(items, meta)
        : kind === "plain"
        ? exportPlain(items, meta)
        : exportJson(items, meta);
    try {
      await copyText(text);
      onToast(
        `${kind.toUpperCase()} for ${items.length} finding${
          items.length === 1 ? "" : "s"
        } copied to the clipboard${
          selectedItems.length === 0 ? " (all findings)" : ""
        }. DiskAudit never writes files — paste it wherever you want it.`
      );
    } catch (e) {
      onToast(String(e), true);
    }
  };

  const rowNavigate = (path: string, isDir: boolean) => {
    if (isDir) {
      onNavigate(path);
    } else {
      const parent = parentPath(path);
      if (parent) onNavigate(parent, path);
    }
  };

  const renderItemRow = (
    item: ReclaimItem,
    group: ReclaimGroup
  ) => {
    const exp = toExportItem(item, group);
    const isSel = selected.has(item.path);
    return (
      <div
        className={`reclaim-row ${isSel ? "sel" : ""}`}
        key={item.path}
        onClick={() => rowNavigate(item.path, item.is_dir)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          onContext(
            { path: item.path, name: item.name, isDir: item.is_dir },
            ev.clientX,
            ev.clientY
          );
        }}
        title="Click to show in the map · right-click for actions"
      >
        <input
          type="checkbox"
          checked={isSel}
          aria-label={`Select ${item.name}`}
          onClick={(ev) => ev.stopPropagation()}
          onChange={() => toggle(exp)}
        />
        <div className="reclaim-row-main">
          <div className="reclaim-row-name">{item.name}</div>
          <div className="reclaim-row-path">{item.path}</div>
        </div>
        <div className="reclaim-row-reason">
          {item.reason}
          {item.mtime ? (
            <span className="reclaim-mtime">
              {" "}
              · modified {formatDate(item.mtime)} ({formatAge(item.mtime)} ago)
            </span>
          ) : null}
        </div>
        <div className="reclaim-row-size">{formatBytes(item.size)}</div>
      </div>
    );
  };

  const renderGroup = (group: ReclaimGroup) => {
    const badge = CLASS_BADGE[group.class] ?? CLASS_BADGE.stale;
    const groupItems = group.items.map((i) => toExportItem(i, group));
    const allSel =
      groupItems.length > 0 && groupItems.every((i) => selected.has(i.path));
    return (
      <section className="reclaim-group" key={group.kind}>
        <div className="reclaim-group-head">
          <span className={`reclaim-badge ${badge.cls}`}>{badge.label}</span>
          <h3>{group.label}</h3>
          <span className="reclaim-group-total">
            {formatBytes(group.total)} · {formatNumber(group.count)} item
            {group.count === 1 ? "" : "s"}
          </span>
          {group.class === "regenerable" && (
            <button
              className="link-btn reclaim-selall"
              onClick={() => setMany(groupItems, !allSel)}
            >
              {allSel ? "Clear group" : "Select all in this group"}
            </button>
          )}
        </div>
        <p className="reclaim-group-blurb">{group.blurb}</p>
        <div className="reclaim-rows">
          {group.items.map((i) => renderItemRow(i, group))}
          {(group.more_count ?? 0) > 0 && (
            <div className="reclaim-more">
              …and {formatNumber(group.more_count!)} smaller finding
              {group.more_count === 1 ? "" : "s"} (
              {formatBytes(group.more_bytes ?? 0)}) not listed.
            </div>
          )}
        </div>
      </section>
    );
  };

  const renderDupGroup = (g: DupGroup, idx: number) => {
    const deletable = g.copies
      .filter((c) => !c.keep && !c.in_finding)
      .map((c) => dupExportItem(c, g));
    const allSel =
      deletable.length > 0 && deletable.every((i) => selected.has(i.path));
    return (
      <div className="reclaim-dupgroup" key={g.name + idx}>
        <div className="reclaim-dupgroup-head">
          <span className="reclaim-dup-name">{g.name}</span>
          <span className="reclaim-dup-meta">
            {g.copies.length} copies × {formatBytes(g.logical)} — reclaim{" "}
            <strong>{formatBytes(g.reclaimable)}</strong> (one copy stays)
          </span>
          <button
            className="link-btn reclaim-selall"
            onClick={() => setMany(deletable, !allSel)}
          >
            {allSel ? "Clear" : "Select redundant copies"}
          </button>
        </div>
        {g.copies.map((c) => {
          const isSel = selected.has(c.path);
          const selectable = !c.keep && !c.in_finding;
          return (
            <div
              className={`reclaim-row dup ${isSel ? "sel" : ""}`}
              key={c.path}
              onClick={() => rowNavigate(c.path, false)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                const name = c.path.split("/").pop() ?? c.path;
                onContext(
                  { path: c.path, name, isDir: false },
                  ev.clientX,
                  ev.clientY
                );
              }}
              title="Click to show in the map · right-click for actions"
            >
              {selectable ? (
                <input
                  type="checkbox"
                  checked={isSel}
                  aria-label={`Select copy ${c.path}`}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={() => toggle(dupExportItem(c, g))}
                />
              ) : (
                <span className="reclaim-checkbox-spacer" />
              )}
              <div className="reclaim-row-main">
                <div className="reclaim-row-path solo">{c.path}</div>
              </div>
              {c.keep && (
                <span className="reclaim-badge badge-keep">
                  kept — not counted
                </span>
              )}
              {c.in_finding && (
                <span className="reclaim-badge badge-hint">
                  inside another finding
                </span>
              )}
              <div className="reclaim-row-size">{formatBytes(c.size)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  const noFindings =
    report.groups.length === 0 &&
    dup.groups.length === 0 &&
    !scanning &&
    !dupRunning;

  return (
    <div className="reclaim-root">
      {scanning && (
        <div className="reclaim-banner">
          <div className="spinner" />
          Scan still running — these findings are partial and the numbers are
          still growing. Duplicate detection becomes available when the scan
          finishes.
        </div>
      )}

      <div className="reclaim-headline">
        <div>
          <div className="reclaim-headline-num">
            {scanning ? "≥ " : "≈ "}
            {formatBytes(report.total)}
          </div>
          <div className="reclaim-headline-sub">
            plausibly reclaimable
            {dup.status === "not_started" && !scanning
              ? " — before duplicate detection"
              : ""}
            . Deduplicated: nothing here is counted twice.
          </div>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => doExport("csv")}
          disabled={allExportItems.length === 0}
          title="Copy every finding as CSV — review it in a spreadsheet before acting"
        >
          Export all (CSV)
        </button>
      </div>

      {noFindings && (
        <div className="reclaim-empty">
          <h3>Nothing obviously reclaimable.</h3>
          <p>
            DiskAudit only flags what it can identify with high confidence —
            known caches, build artifacts it can verify, Trash, old
            installers, verified duplicates. A quiet result means nothing
            matched those deliberately conservative rules, not that nothing
            here could ever be freed.
          </p>
          {dup.status === "not_started" && (
            <p>Duplicate detection hasn't run yet — try it below.</p>
          )}
        </div>
      )}

      {report.groups.map(renderGroup)}

      <section className="reclaim-group">
        <div className="reclaim-group-head">
          <span className="reclaim-badge badge-dup">keep one copy</span>
          <h3>Duplicates</h3>
          {dup.status === "done" && (
            <span className="reclaim-group-total">
              {formatBytes(dup.reclaimable)} ·{" "}
              {formatNumber(dup.group_count)} group
              {dup.group_count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {dup.status === "not_started" && !dupRunning && (
          <div className="reclaim-dup-intro">
            <p>
              Files with identical content at several paths. Finding them is a
              separate pass that <strong>reads file contents</strong> (still
              strictly read-only) — it can take a while on large scans, and
              you can cancel it at any time. Hardlinks are excluded; APFS
              clones can't be told apart from real copies, so treat photo
              libraries and the like with care.
            </p>
            <button
              className="btn btn-primary"
              onClick={onStartDup}
              disabled={scanning}
              title={
                scanning ? "Available when the scan finishes" : undefined
              }
            >
              Find duplicates
            </button>
          </div>
        )}
        {dupRunning && (
          <div className="reclaim-dup-progress">
            <div className="spinner" />
            <div className="reclaim-dup-progress-text">
              {DUP_PHASE_LABEL[dupProgress?.phase ?? "collecting"]}
              {dupProgress && dupProgress.total > 0
                ? ` — ${formatNumber(dupProgress.done)} / ${formatNumber(
                    dupProgress.total
                  )} files`
                : ""}
              {dupProgress
                ? ` · ${formatBytes(dupProgress.bytes_read)} read`
                : ""}
            </div>
            <button className="btn btn-ghost" onClick={onCancelDup}>
              Cancel
            </button>
          </div>
        )}
        {(dup.status === "done" ||
          dup.status === "cancelled" ||
          dup.status === "failed") &&
          !dupRunning && (
            <>
              {dup.status === "cancelled" && (
                <p className="reclaim-group-blurb">
                  Duplicate detection was cancelled — showing what was fully
                  verified before the stop.{" "}
                  <button className="link-btn" onClick={onStartDup}>
                    Run it again
                  </button>
                </p>
              )}
              {dup.status === "failed" && (
                <p className="reclaim-group-blurb">
                  Duplicate detection hit an internal error.{" "}
                  <button className="link-btn" onClick={onStartDup}>
                    Try again
                  </button>
                </p>
              )}
              {dup.status === "done" && (
                <p className="reclaim-group-blurb">
                  Verified byte-for-byte ({formatBytes(dup.bytes_read)} read
                  across {formatNumber(dup.files_hashed)} files
                  {dup.errors
                    ? `, ${formatNumber(dup.errors)} unreadable or changed`
                    : ""}
                  ). Each group keeps its oldest copy — the kept copy is never
                  part of the reclaimable number.
                </p>
              )}
              {dup.groups.map(renderDupGroup)}
              {(dup.more_groups ?? 0) > 0 && (
                <div className="reclaim-more">
                  …and {formatNumber(dup.more_groups!)} smaller group
                  {dup.more_groups === 1 ? "" : "s"} (
                  {formatBytes(dup.more_bytes ?? 0)}).
                </div>
              )}
              {dup.status === "done" && dup.groups.length === 0 && (
                <p className="reclaim-group-blurb">
                  No reclaimable duplicates found (files over 1 MB, outside
                  other findings).
                </p>
              )}
            </>
          )}
        {scanning && dup.status === "not_started" && (
          <p className="reclaim-group-blurb">
            Available when the scan finishes.
          </p>
        )}
      </section>

      <div className="reclaim-footer">
        <div className="reclaim-footer-info">
          {selected.size > 0 ? (
            <>
              <strong>{formatNumber(selected.size)}</strong> selected — would
              free <strong>{formatBytes(selectedBytes)}</strong>
            </>
          ) : (
            <span className="reclaim-footer-hint">
              Select findings to export them or build a deletion script.
              Nothing is ever pre-selected.
            </span>
          )}
        </div>
        <div className="reclaim-footer-actions">
          {selected.size > 0 && (
            <button
              className="btn btn-ghost"
              onClick={() => setSelected(new Map())}
            >
              Clear
            </button>
          )}
          <div className="reclaim-export-wrap">
            <button
              className="btn btn-ghost"
              onClick={() => setExportOpen((o) => !o)}
              disabled={allExportItems.length === 0}
            >
              {selected.size > 0 ? "Export selection ▾" : "Export all ▾"}
            </button>
            {exportOpen && (
              <div className="reclaim-export-menu">
                <button className="ctx-item" onClick={() => doExport("csv")}>
                  CSV — for review in a spreadsheet (recommended)
                </button>
                <button className="ctx-item" onClick={() => doExport("plain")}>
                  Plain paths — one per line
                </button>
                <button className="ctx-item" onClick={() => doExport("json")}>
                  JSON — structured findings
                </button>
              </div>
            )}
          </div>
          <button
            className="btn btn-danger"
            onClick={() => setScriptOpen(true)}
            disabled={selected.size === 0}
            title={
              selected.size === 0
                ? "Select findings first — the script only ever contains what you explicitly picked"
                : undefined
            }
          >
            Deletion script…
          </button>
        </div>
      </div>

      {scriptOpen && (
        <ScriptModal
          items={selectedItems}
          root={report.root}
          home={home}
          onClose={() => setScriptOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/** The last moment the user can catch a mistake: show exactly what the
 * script will contain and free, make Trash-vs-permanent an explicit visible
 * choice, and only then put the text on the clipboard. */
function ScriptModal({
  items,
  root,
  home,
  onClose,
  onToast,
}: {
  items: ReclaimExportItem[];
  root: string;
  home: string;
  onClose: () => void;
  onToast: (msg: string, danger?: boolean) => void;
}) {
  const [mode, setMode] = useState<ScriptMode>("trash");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const result = useMemo(() => {
    const meta = {
      root,
      generatedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      home,
    };
    return deletionScript(items, meta, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, root, home, mode]);

  const totalBytes = result.included.reduce((s, i) => s + i.size, 0);

  const copyScript = async () => {
    try {
      await copyText(result.script);
      onToast(
        "Deletion script copied to the clipboard. Save and run it yourself in " +
          "Terminal — it previews only until you pass --yes, and DiskAudit " +
          "itself never runs or saves it.",
        true
      );
      onClose();
    } catch (e) {
      onToast(String(e), true);
    }
  };

  return (
    <div className="list-overlay" onClick={onClose}>
      <div
        className="list-panel reclaim-modal"
        role="dialog"
        aria-label="Generate deletion script"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="list-header">
          <div className="list-title">
            <div className="list-title-name">Generate deletion script</div>
            <div className="list-title-path">
              {formatNumber(result.included.length)} item
              {result.included.length === 1 ? "" : "s"} · would free ≈{" "}
              {formatBytes(totalBytes)}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="list-body reclaim-modal-body">
          <div className="reclaim-mode-cards" role="radiogroup" aria-label="Deletion mode">
            <label className={`reclaim-mode-card ${mode === "trash" ? "on" : ""}`}>
              <input
                type="radio"
                name="script-mode"
                checked={mode === "trash"}
                onChange={() => setMode("trash")}
              />
              <div>
                <div className="reclaim-mode-title">Move to Trash</div>
                <div className="reclaim-mode-sub">
                  Recoverable until you empty the Trash. The safe default.
                </div>
              </div>
            </label>
            <label className={`reclaim-mode-card danger ${mode === "rm" ? "on" : ""}`}>
              <input
                type="radio"
                name="script-mode"
                checked={mode === "rm"}
                onChange={() => setMode("rm")}
              />
              <div>
                <div className="reclaim-mode-title">Delete permanently</div>
                <div className="reclaim-mode-sub">
                  rm -rf — no Trash, no undo. Only if you're sure.
                </div>
              </div>
            </label>
          </div>

          <div className="reclaim-dryrun-note">
            The script is a <strong>preview by default</strong>: running it
            prints what it would do and touches nothing until you re-run it
            with <code>--yes</code>. Every path is re-checked before acting.
            DiskAudit puts the text on your clipboard and does nothing else —
            it never saves or executes the script.
          </div>

          {result.rejected.length > 0 && (
            <div className="reclaim-rejected">
              <strong>
                {formatNumber(result.rejected.length)} item
                {result.rejected.length === 1 ? "" : "s"} refused
              </strong>{" "}
              by the safety checks (also listed inside the script):
              <ul>
                {result.rejected.map((r) => (
                  <li key={r.item.path}>
                    <span className="mono">{r.item.path}</span> — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="reclaim-script-list">
            {result.included.map((i) => (
              <div className="reclaim-script-item" key={i.path}>
                <span className="mono">{i.path}</span>
                <span>{formatBytes(i.size)}</span>
              </div>
            ))}
          </div>

          <details className="reclaim-script-preview">
            <summary>Preview the exact script text</summary>
            <pre>{result.script}</pre>
          </details>
        </div>
        <div className="reclaim-modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={mode === "rm" ? "btn btn-danger" : "btn btn-primary"}
            onClick={copyScript}
            disabled={result.included.length === 0}
          >
            Copy {mode === "rm" ? "permanent-delete" : "move-to-Trash"} script
          </button>
        </div>
      </div>
    </div>
  );
}
