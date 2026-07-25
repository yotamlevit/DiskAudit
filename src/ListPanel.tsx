import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DirListing, SkipReason } from "./types";
import { formatBytes, formatNumber } from "./format";
import { categoryColor } from "./categories";

interface ListPanelProps {
  path: string;
  onClose: () => void;
  onOpenDir: (path: string, name: string) => void;
}

const PAGE = 500;

export const SKIP_LABELS: Record<SkipReason, string> = {
  cloud_storage: "cloud storage — not scanned",
  other_volume: "different volume — not scanned",
  firmlink_alias: "counted at its firmlinked location",
};

/** Full, honest listing of one directory — what an aggregate ("smaller
 * items") block opens into. Every direct child, sorted by size. */
export default function ListPanel({ path, onClose, onOpenDir }: ListPanelProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string>("");
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<DirListing>("list_dir", { path, offset: 0, limit: PAGE })
      .then((l) => {
        if (alive) setListing(l);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const loadMore = useCallback(async () => {
    if (!listing || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await invoke<DirListing>("list_dir", {
        path,
        offset: listing.entries.length,
        limit: PAGE,
      });
      setListing({
        ...next,
        entries: [...listing.entries, ...next.entries],
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [listing, loadingMore, path]);

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

  const total = listing?.dir_size || 1;

  return (
    <div className="list-overlay" onClick={onClose}>
      <div
        className="list-panel"
        role="dialog"
        aria-label={`Contents of ${path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="list-header">
          <div className="list-title">
            <div className="list-title-name">Everything in</div>
            <div className="list-title-path" title={path}>
              {path}
            </div>
          </div>
          <div className="list-meta">
            {listing && (
              <>
                {formatNumber(listing.total)} items ·{" "}
                {formatBytes(listing.dir_size)}
              </>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="list-body">
          <table className="ext-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th className="num">Size</th>
                <th className="num">% of folder</th>
                <th>Kind</th>
              </tr>
            </thead>
            <tbody>
              {listing?.entries.map((e) => (
                <tr
                  key={e.path}
                  className={e.is_dir && !e.skip_reason ? "row-clickable" : ""}
                  onClick={() => {
                    if (e.is_dir && !e.skip_reason) onOpenDir(e.path, e.name);
                  }}
                >
                  <td>
                    <span
                      className="cat-bar-swatch"
                      style={{
                        background: e.is_dir
                          ? "var(--fg-3)"
                          : categoryColor(e.name),
                      }}
                    />
                  </td>
                  <td className="ellip" title={e.path}>
                    {e.name}
                    {e.is_symlink && <span className="tag">symlink</span>}
                    {e.skip_reason && (
                      <span className="tag warn-tag">
                        {SKIP_LABELS[e.skip_reason]}
                      </span>
                    )}
                  </td>
                  <td className="num">{formatBytes(e.size)}</td>
                  <td className="num">
                    {((e.size / total) * 100).toFixed(1)}%
                  </td>
                  <td className="kind">
                    {e.is_dir
                      ? `folder${
                          e.file_count
                            ? ` · ${formatNumber(e.file_count)} files`
                            : ""
                        }`
                      : e.is_symlink
                      ? "symlink"
                      : "file"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listing && listing.entries.length < listing.total && (
            <button
              className="btn btn-ghost list-more"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore
                ? "Loading…"
                : `Show ${formatNumber(
                    Math.min(PAGE, listing.total - listing.entries.length)
                  )} more`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
