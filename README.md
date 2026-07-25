# DiskAudit

**A read-only disk usage visualizer for macOS.** Point it at a folder — or your
whole startup disk — and see every file as a block sized by the space it
actually occupies. Find the big thing, understand what it is, and act on it.

![Treemap view](docs/screenshots/treemap.png)

DiskAudit is built around one loop:

1. **Find** — the treemap starts filling in seconds into a scan and keeps
   refining live. The biggest blocks are the answer to "where did my space go?"
2. **Understand** — click to drill in, hover for exact sizes and paths, search
   (⌘F) for things like *every video over 1 GB*, browse category and extension
   statistics, open the full listing behind any "N smaller items" block.
3. **Act** — right-click any file or folder: **Reveal in Finder**, **Copy
   Path**, or **Copy Delete Command** (puts an `rm` command on the clipboard
   for *you* to paste into Terminal — see the guarantee below). Or just drop
   a folder from Finder onto the window to scan it.
4. **Reclaim** — the **Reclaimable** tab answers the question the map leaves
   hanging: *which of these bytes don't I need?* Caches, build artifacts,
   Trash, old installers, verified duplicate files and stale-file hints,
   each labeled with **why** it's reclaimable and how safe acting on it is —
   plus reviewable exports and a deliberately careful deletion-script
   generator (see below).

| Search anything by size and kind | Complete statistics |
| --- | --- |
| ![Search](docs/screenshots/search.png) | ![Statistics](docs/screenshots/stats.png) |

| Every "smaller items" block opens a full listing | Light mode |
| --- | --- |
| ![Listing](docs/screenshots/listing.png) | ![Light mode](docs/screenshots/treemap-light.png) |

*(Screenshots show the built-in demo dataset rendered by the development
mock — run a scan to see your own disk.)*

## The read-only guarantee

DiskAudit **never writes, moves, renames, or deletes anything**. This is
enforced in three layers:

- The Rust scanner uses only read APIs (`metadata`, `read_dir`, directory
  traversal; duplicate detection additionally opens files **read-only** to
  hash their contents). There is no code path that opens a file for writing,
  removes anything, or spawns a process. An audited security comment at the
  top of `src-tauri/src/lib.rs` documents the allowed API surface.
- The UI layer (Tauri) is granted **no filesystem capability at all** — just
  the folder-open dialog, "reveal in Finder", and *write-only* clipboard
  access. Each grant is justified in `src-tauri/capabilities/default.json`.
- Everything the app produces to act on — the single "Copy Delete Command",
  the Reclaimable tab's exports, and its generated deletion scripts — is
  **plain text placed on the clipboard**. DiskAudit never saves any of it to
  disk (no export files, no temp files) and has no code path that executes a
  script or shell command. Deleting remains a deliberate act you perform
  yourself in Terminal.

## Reclaimable space

The Reclaimable tab lists space you could plausibly free, **grouped by the
reason it's reclaimable** — because the reason determines how safe acting on
it is:

- **Regenerates automatically (safe).** App caches (`~/Library/Caches/*`),
  developer tool caches (npm, cargo, Go, Gradle, `~/.cache/*`), Xcode
  DerivedData / device support / simulator caches, and build artifacts
  (`node_modules`, Rust `target`, `Pods`, `.venv`, `__pycache__`, `.next`,
  Go/PHP `vendor`). Deleting these costs rebuild/re-download time, not data.
- **Genuinely disposable, but gone forever (careful).** Trash contents,
  installers (`.dmg`/`.pkg`/`.xip`/`.ipsw`) sitting in Downloads for 30+
  days, Xcode archives, and iOS device backups (the last two are here — not
  under "safe" — because they do *not* regenerate).
- **Duplicates (careful).** Files with byte-identical content at several
  paths, verified by hashing in a separate, explicitly-started, cancellable
  pass (size grouping → head/tail sample → full hash, so only files that
  already collided twice are fully read; the tab reports how much I/O it
  actually did). The reclaimable figure is the group total **minus one kept
  copy** — the kept copy is marked and never counted. Hardlinks are excluded
  outright (deleting one path frees nothing).
- **Stale (a hint, not a verdict).** Files over 500 MB not modified in over a
  year — judged by **modification time**, because macOS mounts are typically
  `noatime` and access times lie. Never flagged inside `~/Library` or
  package-like folders (`.app`, `.photoslibrary`, …).

Detection is **deliberately conservative**: ambiguous names need
corroborating markers (`target` only counts with a sibling `Cargo.toml`,
`.venv` needs `pyvenv.cfg`, bare `build`/`dist` are never flagged), nothing
outside the scan root or touching skipped territory is ever offered, and a
quiet tab means "nothing matched the rules", not "nothing could be freed".
The headline number is a deduplicated union — a duplicate inside a flagged
`node_modules` is never counted twice.

**Exports** (selected findings or all of them): CSV — the default, with
path, size, kind, category, confidence and reason, meant to be reviewed in a
spreadsheet before anything is deleted — plus plain paths and JSON. Every
export carries provenance: scan root, timestamp, total, DiskAudit version.

**Deletion scripts** are generated from your explicit selection only
(nothing is ever pre-selected), and are the most carefully engineered text
the app produces:

- **Move-to-Trash by default** (recoverable); permanent `rm -rf` is an
  explicit, clearly-labeled alternative.
- **Dry-run by default**: the script previews and exits unless run with
  `--yes`.
- `set -euo pipefail`; every path shell-quoted; a review comment (size,
  category, why) above every entry; a provenance header.
- Every step re-checks the path still exists, skips and reports anything
  missing, never lets one failure abort the rest, and prints a `du`-measured
  running total to reconcile against DiskAudit's estimate.
- The generator **refuses** dangerous paths — `/`, your home, `~/Library`
  and other protected locations, anything outside the scan root, nested
  selections — and lists what it refused instead of emitting it.

And to repeat the guarantee: script and exports are **clipboard text**. The
app never writes them to disk and can never run them.

## Install / build

Prerequisites: [Rust](https://rustup.rs), Node 20+, Xcode command-line tools.

```bash
npm install
npm run tauri dev     # run in development
npm run tauri build   # produce DiskAudit.app and a .dmg
```

The bundles land in `src-tauri/target/release/bundle/` (`macos/DiskAudit.app`,
`dmg/DiskAudit_*.dmg`). Drag the app to `/Applications`.

## Full Disk Access

macOS privacy protection blocks *every* app from reading Mail, Messages,
Safari data, Time Machine metadata, and parts of `~/Library` until you grant
**Full Disk Access** (System Settings → Privacy & Security → Full Disk
Access). Without it, scans still work but report those places as unreadable —
DiskAudit counts them, shows you how many items it couldn't read, and offers a
button that opens the right settings pane. Grant access and rescan for a
complete picture.

## How DiskAudit measures — and how that relates to Finder

- **Sizes are allocated bytes** (`st_blocks × 512`): the space a file really
  occupies on disk, which is what you get back by deleting it. Finder's Get
  Info headline number is the *logical* size (what the file claims to
  contain); DiskAudit reports the logical total in the statistics view for
  comparison. Sparse files (Docker images, VM disks, some databases) can be
  dramatically smaller on disk than their logical size — DiskAudit shows the
  truth.
- **Units are decimal** (1 MB = 1,000,000 bytes), matching Finder and every
  other macOS surface.
- **Hardlinks are counted once.** Extra links to the same file show as 0 bytes
  and the deduplicated total is reported in the statistics.
- **APFS clones are not deduplicated** — macOS provides no public API to
  detect shared extents. Two clones of a 10 GB file count as 20 GB (Finder
  does the same); actual disk usage may be lower.
- **Scanning `/` shows the startup disk the way Finder presents it**: the
  System and Data volumes merged at their usual paths. The Data volume's
  mount point (`/System/Volumes/Data`) is skipped so nothing is counted
  twice, and helper volumes (Preboot, VM/swap) are listed as skipped.

## What a scan deliberately skips

Nothing disappears silently — every skipped location appears in the map, in
listings, and in the **Not scanned** panel with its reason:

- **Cloud-sync folders** (`~/Library/CloudStorage`, `~/Library/Mobile
  Documents` — iCloud Drive, Dropbox, Google Drive, OneDrive): much of their
  content lives only in the cloud, and reading them can hang on network I/O
  or trigger downloads. Scan one directly (point DiskAudit at it) if you
  really want it measured.
- **Other volumes**: external drives, network shares, mounted disk images,
  and simulator volumes don't occupy space on the disk you're scanning. Scan
  a volume directly to measure it.
- **Symlinks are never followed** (each is counted where it stands, at the
  link's own ~0 size), so nothing is counted twice and scans can't loop.

## Known limitations

- Directory entries themselves (the few KB a huge folder's catalog occupies)
  are not counted, only files. `du` agrees with DiskAudit on APFS to within
  rounding.
- "Purgeable" space that macOS reclaims on demand (local Time Machine
  snapshots, cached iCloud content) is invisible to any user-space walk —
  if Finder's free space disagrees with everyone, snapshots are usually why.
- Which of several hardlinked paths displays the shared size depends on scan
  order.
- The scanner keeps the whole scan in memory to serve drill-in, listing, and
  search queries instantly afterward; very large scans (millions of files)
  cost a few hundred MB of RAM.
- **APFS clones are indistinguishable from real copies** in user space, so
  duplicate detection may list clones — deleting one frees (almost) nothing.
  Treat duplicate findings inside photo libraries and the like with care.
- Reclaimable detection is deliberately conservative and **under-reports**:
  Docker's data is never flagged (its VM image mixes caches with your
  volumes), bare `build`/`dist` folders are never flagged, simulator devices
  aren't (only their caches), and small findings are dropped below a floor.
  An empty tab means nothing matched the rules, not that nothing could go.

## Development

```bash
npx tsc -b --force            # type-check the frontend
npm test                      # frontend tests (vitest)
npm run dev                   # UI in a plain browser against a mock backend
cd src-tauri
cargo test                    # scanner unit tests
cargo run --release --example scan_summary -- ~/Library   # CLI harness, compares to du
```

CI runs `cargo fmt --check`, `cargo check`, `clippy -D warnings`, `cargo
test`, `tsc`, and the vitest suites on every push.

Architecture notes live in [CLAUDE.md](CLAUDE.md).
