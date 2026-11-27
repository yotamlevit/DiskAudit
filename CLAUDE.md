# DiskAudit

A desktop app for macOS, Windows and Linux that scans a directory and
visualizes disk usage as a live, interactive treemap. Read-only by design: it
never writes, moves, or deletes anything. See README.md for the user-facing
story; this file is for working on the code.

**Status:** 1.2. Cross-platform: the scanner moved into a UI-free core crate
with one platform module per OS, the UI adapts its wording/units/paths to the
host, and cleanup scripts come in bash and PowerShell dialects. macOS is the
only platform exercised by hand so far; Linux is verified by tests and a `du`
comparison in a container; Windows compiles and lints from macOS
(`--target x86_64-pc-windows-msvc`) and is otherwise verified only by CI.
See "Remaining limitations".

## Stack

- **Shell:** Tauri v2 (Rust) — `src-tauri/` (command layer) +
  `src-tauri/core/` (`diskaudit-core`: scanner, store, reclaim, platform —
  no Tauri dependency)
- **UI:** React 18 + TypeScript + Vite — `src/`
- **Layout:** `d3-hierarchy` squarified treemap
- **Walker:** `jwalk` (parallel, Rayon-backed) + `dashmap` + `parking_lot`;
  `windows-sys` on Windows only (allocation size, file identity)
- **Plugins:** dialog (folder picker), opener (reveal in Finder, settings
  deep-link), clipboard-manager (write-only), window-state

## Commands

```bash
npm run tauri dev      # run the app (starts Vite on :1420, then Tauri)
npm run dev            # UI alone in a browser, backed by src/devMock.ts
                       # (?os=windows / ?os=linux impersonates that host:
                       # wording, units, and C:\ paths end to end)
npm run build          # tsc -b && vite build  (frontend only)
npm test               # vitest (frontend units + App smoke vs the mock)
npm run tauri build    # produce .app + .dmg
npx tsc -b --force     # type-check the frontend
cargo test / clippy --workspace --all-targets   # from src-tauri/
cargo run --release -p diskaudit-core --example scan_summary -- [--reclaim] [--dups] <path>
                       # CLI harness: totals vs du; --reclaim prints the
                       # findings report, --dups also runs the duplicate pass

# Checking the other platforms from a Mac (core crate only — it has no GTK /
# WebView dependency; CARGO_FEATURE_PURE avoids blake3's MSVC assembler):
CARGO_FEATURE_PURE=1 cargo clippy -p diskaudit-core --all-targets \
    --target x86_64-pc-windows-msvc -- -D warnings
docker run --rm --user 1000:1000 -e HOME=/tmp -e CARGO_HOME=/tmp/cargo \
    -e CARGO_TARGET_DIR=/tmp/target -v "$PWD":/repo:ro -w /repo/src-tauri \
    rust:1-slim cargo test -p diskaudit-core --locked   # real Linux run
```

CI (`.github/workflows/ci.yml`) runs on macOS, Windows and Linux: fmt
--check, clippy -D warnings and tests for the core crate, a scanner-vs-`du`
check, tsc + vitest (which EXECUTES the generated bash and PowerShell
scripts where bash / pwsh exist), and a full `tauri build --no-bundle`.
`release.yml` builds installers for every platform on a `v*` tag into a
draft release (unsigned unless signing secrets are set).

## Architecture

The store is the center: a scan populates a session-lifetime map, and the UI
asks for bounded views of it on demand — during the scan (live, partial) and
after it (finalized). No full-tree payload ever crosses IPC.

```
start_scan(path)                                   src-tauri/src/lib.rs
    ↓ platform::resolve_root, spawn_blocking + catch_unwind
scanner::walk()                                    src-tauri/core/src/scanner.rs
    │  jwalk parallel walk → DashMap<PathBuf, Mutex<DirAcc>>  (ScanShared)
    │  per entry: platform::stat_file → allocated bytes, hardlink identity,
    │  mtime (st_blocks*512 / (dev,ino) on Unix; NTFS allocation size /
    │  (volume serial, file index) on Windows); directories add their own
    │  blocks (platform::dir_meta); links tallied, never followed
    │  skips per platform::ScanPolicy (cloud dirs, other volumes/filesystems,
    │  /System/Volumes/Data firmlink alias on "/" scans) — recorded, not dropped
    │  emits "scan://progress" (~10 Hz, tagged with scan_id)
    ↓
scanner::finalize()      caches recursive totals/counts per dir; complete=true
scanner::compute_stats() category totals (ALL files), top-80 ext + remainder,
                         top-100 files
    ↓ start_scan resolves with ScanDone (summary + stats + skipped list)

platform_info()                    → { os, home }: the UI derives ALL its
                                     OS wording, shortcuts, units and the
                                     script dialect from this (src/platform.ts)

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

**Platform layer** (`core/src/platform/`): `mod.rs` holds the shared types
and the public functions; `macos.rs`, `linux.rs` and `windows.rs` each
implement the same private interface (`stat_file`, `dir_meta`, `link_alloc`,
`root_policy`, `resolve_root`, `home_dir`, `reclaim_site`, `INSTALLER_EXTS`,
`stale_excluded`, …). Both Unix modules are compiled on every Unix so their
pure path logic is tested wherever tests run; `windows.rs` only on Windows.

**Reclaim detection** (`reclaim.rs`): pure path matching over the store —
each OS's location knowledge (cache dirs, Xcode paths, trash, temp dirs,
package caches, Downloads) lives in its platform module's `reclaim_site` with
exact home-shaped matching; generic artifact names need corroborating markers in
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
| `src-tauri/src/lib.rs` | Tauri commands, AppState, per-OS menu, SECURITY INVARIANT comment (covers both crates — read before touching fs or capabilities) |
| `src-tauri/core/src/scanner.rs` | Walk, store, finalize, stats, views, listings, search |
| `src-tauri/core/src/reclaim.rs` | Reclaimable detection over the store + the staged duplicate pass (the ONLY code that reads file contents — read-only) + report assembly |
| `src-tauri/core/src/platform/{mod,macos,linux,windows}.rs` | ALL OS-specific policy and metadata access. No non-test code in the core crate outside this directory may use `cfg(target_os)` or `std::os::*` (the app crate has one `cfg`: the macOS app menu in `lib.rs`) |
| `src-tauri/core/src/categories.rs` | Rust side of the shared category table |
| `src-tauri/core/src/*_tests.rs` | Real-filesystem tests (tempdir fixtures; run on every OS; the only code that writes, test-only; the macOS clone fixture shells out to `cp -c`) |
| `src-tauri/core/src/*_synth_tests.rs` | Synthetic-store tests with hand-written `/` paths — compiled on Unix only; ones asserting macOS locations are gated to macOS |
| `src-tauri/core/src/devtool.rs` + `core/examples/scan_summary.rs` | Dev CLI harness (compare against `du -sk`; `--reclaim`/`--dups` for findings) |
| `src/App.tsx` | Phase machine, platform context, nav stack (path crumbs), polling during scan, keyboard, welcome screen, summary strip, toasts |
| `src/platform.ts` | `describePlatform(info)`: every OS-dependent string (file-manager name, shortcuts, trash name, quick picks). Components read it via `usePlatform()` — never hard-code "Finder" or "⌘" |
| `src/Treemap.tsx` | SVG treemap, tooltip, legend (present categories only), highlight flash, right-click |
| `src/Stats.tsx` | "File types" tab: category bars / extension table / largest files — rows navigate or open search |
| `src/Reclaim.tsx` | "Free up space" tab: grouped findings, dup pass UI, explicit selection, export menu, script modal |
| `src/SearchBar.tsx`, `src/ListPanel.tsx`, `src/SkippedPanel.tsx`, `src/ContextMenu.tsx` | Panels |
| `src/ipc.ts` | Tauri IPC indirection; swaps in `src/devMock.ts` in a plain dev browser |
| `src/nav.ts` | Pure path helpers that work on POSIX AND Windows paths (shape detected per path). Never split a path on `/` anywhere else |
| `src/recents.ts`, `src/format.ts`, `src/version.ts` | Pure helpers (unit-tested); `format.ts` holds the host's byte-unit base |
| `src/shell.ts` | THE quoting/command-text module: shellQuote (bash), psQuote/psLiteral (PowerShell), single delete command, findings exports, cleanup-script generators + per-OS dangerous-path validator. Never grow a second quoting path |
| `src/categories.json` | **Single source of truth** for categories/colors/extensions (Rust + TS both derive from it) |
| `src/types.ts` | Hand-maintained mirror of the Rust serde payloads |

## Invariants & conventions

- **Read-only.** The audited comment atop `src-tauri/src/lib.rs` lists
  allowed fs APIs and the justified plugin surface, for both crates. Never
  add `fs::write`/`remove`/`rename`/`create_dir`/`set_permissions`,
  write-mode `OpenOptions`, or `std::process::Command`. Two audited
  exceptions: `File::open` (read mode) in `reclaim.rs` ONLY, for duplicate
  hashing; and `OpenOptions` with `access_mode(FILE_READ_ATTRIBUTES)` in
  `platform/windows.rs` ONLY (a metadata-only handle). New capabilities need
  a justification in `capabilities/default.json`'s description.
- **The app never executes or saves what it generates.** Exports and
  deletion scripts are clipboard text only — no save dialog, no export file,
  no temp file, no execution path, not behind any preference. The
  `no-exec-path` test in `src/test/shell.test.ts` asserts no app source
  imports child_process. Generated scripts are dry-run by default (`--yes`
  to apply), Trash/Recycle-Bin by default (permanent delete is the explicit
  variant), and every path goes through `validateSelection` and then
  `shellQuote` (bash) or `psLiteral` (PowerShell).
- **PowerShell output is printable ASCII only** (`psLiteral` spells other
  characters as `[char]0xNNNN`; comments are transliterated). Windows
  PowerShell 5.1 reads BOM-less scripts in the legacy code page, where bytes
  of a UTF-8 file name can decode to typographic quotes that PowerShell
  accepts as string delimiters. A test asserts the ASCII property.
- **Generated PowerShell never recurses through a reparse point** and never
  uses `Remove-Item -Recurse`; it walks trees itself.
- **`src/types.ts` mirrors the Rust serde structs by hand** — change a
  `#[derive(Serialize)]` payload struct and you must update it in the same
  change; nothing checks this.
- Rust field names cross IPC as `snake_case` (no serde rename). Serde skips
  zero/false/empty fields — TS mirrors them as optional.
- Sizes are **allocated bytes**; UI units follow the host file manager —
  **decimal** on macOS/Linux, **1024-based** on Windows (`setByteUnits`).
  Both are policy — documented in scanner.rs, format.ts and README; don't mix
  in logical sizes. Reclaim thresholds are decimal byte constants on every OS.
- **Categories: eight hues + two neutrals, no more.** The colours are the
  validated slot order of the dataviz palette (light and dark steps in
  `categories.json`, exposed as `--cat-<id>` / `--cat-<id>-ink` by
  `categoryStyleSheet`). A new file kind joins an existing category; a ninth
  hue cannot stay distinguishable. Paint with `categoryVar()`, never the hex.
- Colors/labels/extension mapping come from `categories.json` only.
- Platform-specific behavior goes in `core/src/platform/` (Rust) and
  `src/platform.ts` (wording), nowhere else.
- Paths cross IPC as native strings. The frontend never assumes `/`: use
  `nav.ts` (`parentPath`, `baseName`, `joinPath`, `isWithin`, `samePath`).
- CSS is one flat `src/styles.css`; custom properties at `:root` with a
  `prefers-color-scheme: light` override block. Treemap structural colors are
  CSS vars (`--map-*`); category colors are the generated `--cat-*` vars.
  Fonts are each OS's system UI face (`--font-ui`); never a web font.
- Release profile must NOT set `panic = "abort"` — scan panics are caught
  (catch_unwind) and surfaced as errors.

## Remaining limitations (deliberate or accepted)

- **Not verified on real hardware:** Windows (size/hardlink code, Explorer
  reveal, PowerShell Recycle-Bin action — the last is not exercised even in
  CI, because it shows shell dialogs) and the Linux GUI. Don't describe them
  as working without that evidence.
- Windows scans open one metadata handle per file (no MFT reading — that
  needs admin). Directories' own index allocation is not counted on Windows.
- Linux: a `/` scan stops at every mount point and btrfs subvolume
  (different st_dev), including a separate `/home`. Reported as skipped.
- APFS clones (and btrfs/XFS reflinks) count per-copy (no public API to detect shared extents) — and
  the duplicate pass therefore CANNOT distinguish a clone from a real copy;
  a "duplicate" that is a clone frees ~nothing when deleted (documented in
  README, pinned by a test).
- Synthetic-store Rust tests don't run on Windows (hand-written `/` paths);
  Windows relies on the real-filesystem tests and `platform/windows.rs` tests.
- Reclaim detection deliberately under-reports: no `.exe`/`.AppImage`
  installers, Windows temp dirs only per leftover FOLDER, no Docker data (volumes mix
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
  the Free up space tab is open).
- Treemap blocks have aria labels but aren't tab-focusable; the accessible
  path to any item is the listing panel / search.
- Whole-scan store is kept in memory for instant queries (~hundreds of MB for
  millions of files; the per-file logical size / mtime / hardlink flag added
  for reclaim cost ~16 bytes per file on top).
