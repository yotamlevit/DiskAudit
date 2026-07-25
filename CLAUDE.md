# DiskAudit

A macOS desktop app that scans a directory and visualizes disk usage as an interactive
treemap. Read-only by design: it never writes, moves, or deletes anything.

**Status:** pre-1.0. Core scan + treemap + stats work; see "Known problems" below.

> The `README.md` in this repo describes an unrelated, abandoned idea (enumerating host
> VMs and emailing disk reports). It is stale — ignore it. The local disk visualizer
> described here is the actual product.

## Stack

- **Shell:** Tauri v2 (Rust) — `src-tauri/`
- **UI:** React 18 + TypeScript + Vite — `src/`
- **Layout:** `d3-hierarchy` squarified treemap
- **Walker:** `jwalk` (parallel, Rayon-backed) + `dashmap` + `parking_lot`

## Commands

```bash
npm run tauri dev      # run the app (starts Vite on :1420, then Tauri)
npm run build          # tsc -b && vite build  (frontend only)
npm run tauri build    # produce .app + .dmg
npx tsc -b --force     # type-check the frontend
cargo check            # from src-tauri/ — type-check Rust
```

There is no test suite and no CI.

## Architecture

```
User picks path
    ↓
invoke("start_scan", { path })                    src/App.tsx
    ↓
start_scan command (async, spawn_blocking)        src-tauri/src/lib.rs
    ↓  emits "scan://progress" every ~100ms
scanner::scan()                                   src-tauri/src/scanner.rs
    │
    ├─ jwalk parallel walk, process_read_dir callback per directory
    │     accumulates into DashMap<PathBuf, Mutex<DirAcc>>
    │     skips: symlinks, cloud-sync paths, cross-device dirs
    ├─ snapshot_files_by_dir()  → full file list, cached for expand_aggregate
    ├─ compute_stats()          → by_extension (top 80), top_files (top 50)
    ├─ build_tree()             → full TreeNode hierarchy
    └─ prune_to_budget()        → rolls small files into "« N smaller files »" nodes
    ↓
ScanResultPayload → React state → <Treemap> / <Stats>
```

### Key invariants

**Read-only.** `src-tauri/src/lib.rs` carries an audited security comment listing the
only permitted filesystem APIs (`metadata`, `symlink_metadata`, `read_dir`, jwalk).
Forbidden: any `fs::write`/`remove`/`rename`/`create_dir`/`set_permissions`,
`OpenOptions` with write flags, and `std::process::Command`. The Tauri capability
(`src-tauri/capabilities/default.json`) grants only `dialog:allow-open`.

**Skipped territory.** Two skip rules, both recorded in the tree as zero-size `external`
nodes rather than silently dropped:
- Path-based: `/Library/CloudStorage/`, `/Library/Mobile Documents/` — FileProvider dirs
  sit on the same device as `$HOME` but `metadata()` inside them can block on network I/O.
- Device-based: any directory whose `st_dev` differs from the scan root's.

**Pruning.** The full tree would be millions of nodes, so `prune_tree` keeps at most
`MAX_FILES_PER_DIR` (200) files per directory and drops anything below a per-directory
floor (`max(0.1% of dir size, 64 KiB, global_floor)`). Dropped files collapse into one
synthetic aggregate node whose `size` preserves their total bytes. Clicking it calls
`expand_aggregate`, which re-derives the dropped set from the cached `files_by_dir`.

### Frontend layout

| File | Role |
| --- | --- |
| `src/App.tsx` | Phase machine (`idle`/`scanning`/`done`/`error`), path input, breadcrumb stack, view tabs |
| `src/Treemap.tsx` | SVG treemap, tooltip, legend. Renders `MAX_VIEW_DEPTH` (3) levels below current root |
| `src/Stats.tsx` | By-category bars, by-extension table, largest-files table |
| `src/categories.ts` | Extension → category → color. Single source of truth for all coloring |
| `src/format.ts` | `formatBytes` / `formatNumber` / `formatDuration` |
| `src/types.ts` | Mirrors the Rust serde payloads by hand — keep in sync manually |

Navigation is a `stack: TreeNode[]`. Drilling pushes, breadcrumbs slice, right-click pops.

## Conventions

- `types.ts` is hand-maintained against Rust structs. Change a `#[derive(Serialize)]`
  struct and you must update `types.ts` — nothing checks this.
- Rust field names cross the boundary as `snake_case` (no serde rename).
- Colors come from `categories.ts` only. Don't hardcode file-type colors in components.
- CSS is one flat `src/styles.css` with custom properties at `:root`.

## Known problems

Real defects confirmed by reading the code, not speculation:

- **Scanning `/` returns nonsense on macOS.** The `st_dev` check marks
  `/System/Volumes/Data` as external, so a full-drive scan skips all user data.
- **Cancelling shows a red error.** `start_scan` returns `Err("scan cancelled")`, which
  the frontend renders as "Scan failed:" in the error banner.
- **Category percentages are wrong.** `Stats.tsx` derives category totals from
  `by_extension`, which the backend truncates to the top 80 extensions.
- **Aggregate expansion doesn't match its own rollup.** `expand_aggregate` in `lib.rs`
  computes the floor from files-only size while pruning used the full directory size
  (including subdirectories), so the expanded file set differs from what was rolled up.
- **`file_count` / `dir_count` are direct children only**, but the tooltip labels them
  "Contains" — they read as recursive totals and disagree with the summary bar.
- **Sizes disagree with Finder.** `formatBytes` divides by 1024 while labeling "KB/MB/GB";
  macOS reports decimal units. Also uses logical size (`md.len()`), not allocated blocks,
  and does no hardlink/APFS-clone dedup.
- **Node budget can't be met on directory-heavy trees.** `prune_to_budget` only ever
  removes files, never directories, so `MAX_TOTAL_NODES` is not actually a bound.
- **Tooltip mispositions near edges.** It's `position: fixed` with viewport coordinates,
  but clamped against canvas dimensions.
- **No streaming results.** A large scan shows only a progress counter until it finishes.
- Permission errors appear to be double-counted (inside `process_read_dir` and again in
  the outer walker loop).
- Right-click-to-go-up is bound to the whole app root, which also suppresses the native
  context menu on the path input.
