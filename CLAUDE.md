# DiskAudit

A macOS desktop app that scans a directory and visualizes disk usage as a live,
interactive treemap. Read-only by design: it never writes, moves, or deletes
anything. See README.md for the user-facing story; this file is for working on
the code.

**Status:** 1.1. Adds the Reclaimable tab (grouped findings + headline
metric), the staged duplicate pass, and clipboard-only exports / deletion
scripts. See "Remaining limitations" below for what is deliberately not
solved.

## Stack

- **Shell:** Tauri v2 (Rust) — `src-tauri/`
- **UI:** React 18 + TypeScript + Vite — `src/`
- **Layout:** `d3-hierarchy` squarified treemap
- **Walker:** `jwalk` (parallel, Rayon-backed) + `dashmap` + `parking_lot`
- **Plugins:** dialog (folder picker), opener (reveal in Finder, settings
  deep-link), clipboard-manager (write-only), window-state

## Commands

```bash
npm run tauri dev      # run the app (starts Vite on :1420, then Tauri)
npm run dev            # UI alone in a browser, backed by src/devMock.ts
npm run build          # tsc -b && vite build  (frontend only)
npm test               # vitest (frontend units + App smoke vs the mock)
npm run tauri build    # produce .app + .dmg
npx tsc -b --force     # type-check the frontend
cargo check / test / clippy --all-targets   # from src-tauri/
cargo run --release --example scan_summary -- [--reclaim] [--dups] <path>
                       # CLI harness: totals vs du; --reclaim prints the
                       # findings report, --dups also runs the duplicate pass
```

CI (`.github/workflows/ci.yml`) runs fmt --check, check, clippy -D warnings,
cargo test, tsc, vitest.

## Architecture

The store is the center: a scan populates a session-lifetime map, and the UI
asks for bounded views of it on demand — during the scan (live, partial) and
after it (finalized). No full-tree payload ever crosses IPC.

```
start_scan(path)                                   src-tauri/src/lib.rs
    ↓ spawn_blocking + catch_unwind
scanner::walk()                                    src-tauri/src/scanner.rs
    │  jwalk parallel walk → DashMap<PathBuf, Mutex<DirAcc>>  (ScanShared)
    │  sizes = st_blocks*512, hardlink dedup by (dev,ino), symlinks tallied
    │  skips per platform::ScanPolicy (cloud dirs, other volumes,
    │  /System/Volumes/Data firmlink alias on "/" scans) — recorded, not dropped
    │  emits "scan://progress" (~10 Hz, tagged with scan_id)
    ↓
scanner::finalize()      caches recursive totals/counts per dir; complete=true
scanner::compute_stats() category totals (ALL files), top-80 ext + remainder,
                         top-100 files
    ↓ start_scan resolves with ScanDone (summary + stats + skipped list)

On demand, live or complete:
  get_view(path, depth≤8, budget)  → bounded ViewNode tree (see below)
  list_dir(path, offset, limit)    → full listing behind an aggregate
  search_files(query/ext/category/min_size)  → ranked hits (complete only)
  get_summary()                    → stored ScanDone (late pickup after cancel)
  get_reclaim()                    → ReclaimReport (reclaim.rs): path-based
                                     findings recomputed per call (works live,
                                     labeled partial) merged with dup results

Separate, explicit, cancellable second pass (complete scans only):
  start_dup_scan()                 → staged duplicate pipeline in reclaim.rs:
                                     size-group → drop singletons → head+tail
                                     sample hash → full blake3 hash (rayon);
                                     emits "reclaim://progress"; results live
                                     in ScanShared.dup; resolves at the end
  cancel_dup_scan()                → keeps groups verified before the stop
```

**Reclaim detection** (`reclaim.rs`): pure path matching over the store —
macOS location knowledge (cache dirs, Xcode paths, Trash, MobileSync
backups, Downloads) lives in `platform.rs::reclaim_site` with exact
home-shaped matching; generic artifact names need corroborating markers in
the store (`target`+`Cargo.toml`, `Pods`+`Podfile`, `.venv`+`pyvenv.cfg`…).
Findings carry a class (regenerable/disposable/duplicate/stale) and derived
confidence. Overlaps resolve ONCE by precedence (dir findings > installers >
dup groups > stale); the headline total is a deduplicated union (tested).
Dup groups use keep-one accounting (oldest copy kept, never counted) and
exclude hardlinked files entirely (nlink>1 frees nothing). All thresholds
are named consts atop reclaim.rs; they are policy, documented in README.

**View building** (`build_view`): BFS with a global node budget. Per directory,
children sorted by size; keep the top 10 unconditionally, then everything above
0.2% of the parent, and keep going while the unplaced remainder exceeds ~20% of
the parent (uniform dirs stay honest), capped at 300 children per dir. The tail
becomes one aggregate node ("N smaller items", bytes preserved) whose click
opens `list_dir` — the listing reproduces the aggregate exactly (same code
path, tested). Depth- or budget-capped dirs get `has_hidden_children`.

**Cancellation** is a normal outcome: the walk drains, finalize still runs,
`ScanDone.cancelled = true`. If the walker thread is stuck in an unabortable
syscall, start_scan returns a partial summary after a 5s grace and the frontend
polls get_summary for the full one.

### Files

| File | Role |
| --- | --- |
| `src-tauri/src/lib.rs` | Commands, AppState, menu, SECURITY INVARIANT comment (read before touching fs or capabilities) |
| `src-tauri/src/scanner.rs` | Walk, store, finalize, stats, views, listings, search |
| `src-tauri/src/reclaim.rs` | Reclaimable detection over the store + the staged duplicate pass (the ONLY code that reads file contents — read-only) + report assembly |
| `src-tauri/src/platform.rs` | ALL macOS-specific policy: volume-group devices, firmlink alias, cloud-dir detection, $HOME, reclaim locations (caches/Xcode/Trash/backups). Port here for Windows/Linux |
| `src-tauri/src/categories.rs` | Rust side of the shared category table |
| `src-tauri/src/scanner_tests.rs`, `src-tauri/src/reclaim_tests.rs` | Unit tests (tempdir fixtures; the only code that writes, test-only; the clone fixture shells out to `cp -c`, test-only) |
| `src-tauri/src/devtool.rs` + `examples/scan_summary.rs` | Dev CLI harness (compare against `du -sk`; `--reclaim`/`--dups` for findings) |
| `src/App.tsx` | Phase machine, nav stack (path crumbs), polling during scan, keyboard, panels, toasts |
| `src/Treemap.tsx` | SVG treemap, tooltip, legend (present categories only), highlight flash, right-click |
| `src/Stats.tsx` | Category bars / extension table / largest files — rows navigate or open search |
| `src/Reclaim.tsx` | Reclaimable tab: grouped findings, dup pass UI, explicit selection, export menu, script modal |
| `src/SearchBar.tsx`, `src/ListPanel.tsx`, `src/SkippedPanel.tsx`, `src/ContextMenu.tsx` | Panels |
| `src/ipc.ts` | Tauri IPC indirection; swaps in `src/devMock.ts` in a plain dev browser |
| `src/nav.ts`, `src/recents.ts`, `src/format.ts`, `src/version.ts` | Pure helpers (unit-tested) |
| `src/shell.ts` | THE quoting/command-text module: shellQuote, single delete command, findings exports, deletion-script generator + dangerous-path validator. Never grow a second quoting path |
| `src/categories.json` | **Single source of truth** for categories/colors/extensions (Rust + TS both derive from it) |
| `src/types.ts` | Hand-maintained mirror of the Rust serde payloads |

## Invariants & conventions

- **Read-only.** The audited comment atop `lib.rs` lists allowed fs APIs and
  the justified plugin surface. Never add `fs::write`/`remove`/`rename`/
  `create_dir`/`set_permissions`, write-mode `OpenOptions`, or
  `std::process::Command`. `File::open` (read mode) is allowed in
  `reclaim.rs` ONLY, for duplicate hashing. New capabilities need a
  justification in `capabilities/default.json`'s description.
- **The app never executes or saves what it generates.** Exports and
  deletion scripts are clipboard text only — no save dialog, no export file,
  no temp file, no execution path, not behind any preference. The
  `no-exec-path` test in `src/test/shell.test.ts` asserts no app source
  imports child_process. Generated scripts are dry-run by default (`--yes`
  to apply), Trash-move by default (`rm -rf` is the explicit variant), and
  every path goes through `shellQuote` + `validateSelection`.
- **`src/types.ts` mirrors the Rust serde structs by hand** — change a
  `#[derive(Serialize)]` payload struct and you must update it in the same
  change; nothing checks this.
- Rust field names cross IPC as `snake_case` (no serde rename). Serde skips
  zero/false/empty fields — TS mirrors them as optional.
- Sizes are **allocated bytes**; UI units are **decimal** (Finder convention).
  Both are policy — documented in scanner.rs and README; don't mix in logical
  sizes or 1024-based units.
- Colors/labels/extension mapping come from `categories.json` only.
- Platform-specific behavior goes in `platform.rs`, nowhere else.
- CSS is one flat `src/styles.css`; custom properties at `:root` with a
  `prefers-color-scheme: light` override block. Treemap structural colors are
  CSS vars (`--map-*`); category colors are theme-independent.
- Release profile must NOT set `panic = "abort"` — scan panics are caught
  (catch_unwind) and surfaced as errors.

## Remaining limitations (deliberate or accepted)

- Directory inodes' own blocks aren't counted (files only); `du` agrees on
  APFS anyway.
- APFS clones count per-copy (no public API to detect shared extents) — and
  the duplicate pass therefore CANNOT distinguish a clone from a real copy;
  a "duplicate" that is a clone frees ~nothing when deleted (documented in
  README, pinned by a test).
- Reclaim detection deliberately under-reports: no Docker data (volumes mix
  with caches in one VM image), no bare `build`/`dist`, no simulator Devices
  (no `simctl` allowed — Command is forbidden), installers only after 30
  days, stale only ≥ 500 MB / ≥ 1 year by mtime (atime lies under noatime)
  and never under `~/Library` or package-like dirs. Floors: 10 MB dirs /
  1 MB Trash / 1 MB dup candidates.
- Which hardlinked path shows the shared size depends on walk order.
- Purgeable space / APFS snapshots are invisible to user-space walks.
- Search is disabled until a scan finalizes (needs cached totals).
- Live (mid-scan) view polls recompute subtree totals each tick — fine at
  ~1s cadence up to millions of entries, but the poll slows as the scan grows.
  get_reclaim during a scan pays the same live-totals cost (only polled while
  the Reclaimable tab is open).
- Treemap blocks have aria labels but aren't tab-focusable; the accessible
  path to any item is the listing panel / search.
- Whole-scan store is kept in memory for instant queries (~hundreds of MB for
  millions of files; the per-file logical size / mtime / hardlink flag added
  for reclaim cost ~16 bytes per file on top).
