import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "./ipc";
import type { SearchHit } from "./types";
import { formatBytes } from "./format";
import { CATEGORIES, Category, categoryColor } from "./categories";
import { parentPath } from "./nav";

/** External trigger (e.g. clicking a stats row) that opens the search with
 * filters preset. */
export interface SearchRequest {
  text?: string;
  ext?: string;
  category?: Category;
  minSize?: number;
}

interface SearchBarProps {
  enabled: boolean;
  request: SearchRequest | null;
  /** Navigate the treemap to dirPath; optionally highlight one child. */
  onNavigate: (dirPath: string, highlightPath?: string) => void;
}

const SIZE_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "Any size", value: 0 },
  { label: "Over 10 MB", value: 10_000_000 },
  { label: "Over 100 MB", value: 100_000_000 },
  { label: "Over 1 GB", value: 1_000_000_000 },
];

export default function SearchBar({ enabled, request, onNavigate }: SearchBarProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [ext, setExt] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [minSize, setMinSize] = useState(0);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // External request (stats row click) presets the filters and opens.
  useEffect(() => {
    if (!request) return;
    setText(request.text ?? "");
    setExt(request.ext ?? "");
    setCategory(request.category ?? "");
    setMinSize(request.minSize ?? 0);
    setOpen(true);
    inputRef.current?.focus();
  }, [request]);

  const hasQuery = !!(text.trim() || ext || category || minSize > 0);

  useEffect(() => {
    if (!open || !enabled || !hasQuery) {
      setHits(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await invoke<SearchHit[]>("search_files", {
          query: text.trim(),
          ext: ext || null,
          category: category || null,
          minSize: minSize || null,
          limit: 200,
        });
        if (alive) setHits(res);
      } catch {
        if (alive) setHits([]);
      } finally {
        if (alive) setLoading(false);
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, enabled, hasQuery, text, ext, category, minSize]);

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = useCallback(
    (hit: SearchHit) => {
      setOpen(false);
      if (hit.is_dir) {
        onNavigate(hit.path);
      } else {
        const parent = parentPath(hit.path);
        if (parent) onNavigate(parent, hit.path);
      }
    },
    [onNavigate]
  );

  if (!enabled) return null;

  return (
    <div className="searchbar" ref={rootRef}>
      <input
        ref={inputRef}
        className="search-input"
        type="search"
        placeholder="Search files and folders…  (⌘F)"
        aria-label="Search scanned files and folders"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => setText(e.target.value)}
      />
      {open && (
        <div className="search-drop" role="listbox" aria-label="Search results">
          <div className="search-filters">
            <select
              value={minSize}
              onChange={(e) => setMinSize(Number(e.target.value))}
              aria-label="Minimum size"
            >
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category | "")}
              aria-label="File category"
            >
              <option value="">All kinds</option>
              {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORIES[c].label}
                </option>
              ))}
            </select>
            {ext && (
              <button
                className="filter-chip"
                onClick={() => setExt("")}
                title="Clear extension filter"
              >
                .{ext} ✕
              </button>
            )}
          </div>
          <div className="search-results">
            {!hasQuery && (
              <div className="search-hint">
                Type a name, or filter by kind/size — e.g. every video over
                1&nbsp;GB.
              </div>
            )}
            {hasQuery && loading && hits === null && (
              <div className="search-hint">Searching…</div>
            )}
            {hasQuery && hits && hits.length === 0 && !loading && (
              <div className="search-hint">Nothing matches.</div>
            )}
            {hits?.map((h) => (
              <button
                key={h.path}
                className="search-row"
                onClick={() => pick(h)}
                role="option"
                aria-selected="false"
                title={h.path}
              >
                <span
                  className="cat-bar-swatch"
                  style={{
                    background: h.is_dir ? "var(--fg-3)" : categoryColor(h.name),
                  }}
                />
                <span className="search-name">
                  {h.name}
                  {h.is_dir && <span className="tag">folder</span>}
                </span>
                <span className="search-path">{h.path}</span>
                <span className="search-size">{formatBytes(h.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
