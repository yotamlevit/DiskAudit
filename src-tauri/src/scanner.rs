// READ-ONLY filesystem scanner. See SECURITY INVARIANT in lib.rs.
//
// Architecture:
//   * jwalk walks the tree in parallel (Rayon pool), accumulating per-directory
//     records into a DashMap that lives for the whole session (ScanShared).
//   * The map IS the data store. Views, listings, stats and search are served
//     on demand from it — no giant tree payload is ever shipped to the UI.
//     While a scan is running the same queries work against the partial map,
//     which is what makes the streaming treemap possible.
//   * After the walk, `finalize` caches recursive totals on every directory,
//     making later view queries O(view size).
//
// Size accounting (deliberate policy — see README):
//   * `size` is ALLOCATED bytes (st_blocks * 512): what deleting the file
//     would actually free. Sparse files count their real blocks, not their
//     logical length. The logical total is tracked separately for the summary.
//   * Hardlinks are deduplicated by (device, inode): the first path seen
//     carries the size, other links show 0 bytes. The deduplicated amount is
//     reported in the summary. (Which path "wins" depends on walk order.)
//   * APFS clones are NOT deduplicated — macOS offers no public API to detect
//     shared extents; Finder counts clones the same way.
//   * Symlinks are never followed. Each one is recorded where it stands with
//     the link's own allocated size (usually 0) and tallied in the summary.
//   * Skipped territory (cloud dirs, other volumes, the firmlink alias) is
//     recorded as zero-size nodes with an explicit reason, never dropped.
//
// Error accounting: every failure is counted exactly once —
//   * unreadable directory (read_dir fails): counted via jwalk's
//     read_children_error in the drain loop, attributed to that directory;
//   * unreadable entry inside a readable directory: counted in
//     process_read_dir where it surfaces as an Err child;
//   * stat failure on a file: counted where the metadata call fails.

use crate::categories::category_for_ext;
use crate::platform::{ScanPolicy, SkipReason};
use dashmap::{DashMap, DashSet};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

// ----- Tunables ------------------------------------------------------------

/// How often the parallel walk checks the cancel flag inside one directory.
const CANCEL_CHECK_STRIDE: usize = 256;
/// Progress emit throttle (ms).
const PROGRESS_EMIT_MS: u64 = 100;

/// View building: always keep at least this many children per directory
/// (so small dirs render fully) …
const KEEP_MIN: usize = 10;
/// … but never more than this many.
const MAX_CHILDREN_PER_DIR: usize = 300;
/// Children smaller than this fraction of their parent are rolled into the
/// tail aggregate — they'd be sub-pixel slivers at that zoom level.
const FLOOR_FRACTION: f64 = 0.002;
const FLOOR_ABS: u64 = 1024;

const TOP_FILES_N: usize = 100;
const MAX_EXT_ROWS: usize = 80;
const MAX_SKIPPED_REPORTED: usize = 500;

// ----- Cancellation --------------------------------------------------------

#[derive(Clone, Default)]
pub struct ScanCancelToken {
    flag: Arc<AtomicBool>,
}

impl ScanCancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

// ----- Accumulator store ---------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct FileRec {
    pub name: String,
    /// Allocated bytes (0 for hardlink duplicates and unstattable files).
    pub size: u64,
    /// Logical length (st_size). Duplicate grouping keys on THIS, never on
    /// `size`, which is deliberately 0 for hardlink dupes and stat failures.
    pub logical: u64,
    /// Modification time, unix seconds (0 when unknown). Access times are
    /// unreliable on macOS (noatime mounts), so mtime is the staleness signal.
    pub mtime: i64,
    pub is_symlink: bool,
    /// st_nlink > 1: deleting this one path frees nothing while other links
    /// exist (possibly outside the scan root), so it is never a reclaimable
    /// duplicate candidate.
    pub hardlinked: bool,
}

/// Per-directory record. Built up during the walk; recursive totals are
/// filled in by `finalize` (and computed on the fly for live views).
#[derive(Default)]
pub struct DirAcc {
    pub name: String,
    /// Allocated bytes of direct (non-recursive) entries.
    pub own_size: u64,
    pub files: Vec<FileRec>,
    pub children: Vec<PathBuf>,
    pub error_count: u64,
    pub symlink_count: u64,
    pub skip: Option<SkipReason>,
    // Cached recursive totals, valid once ScanShared.complete is set.
    pub total_size: u64,
    pub rec_files: u64,
    pub rec_dirs: u64,
    pub rec_errors: u64,
    pub rec_symlinks: u64,
}

impl DirAcc {
    pub(crate) fn new(name: String) -> Self {
        Self {
            name,
            ..Default::default()
        }
    }
    pub(crate) fn skipped(name: String, reason: SkipReason) -> Self {
        Self {
            name,
            skip: Some(reason),
            ..Default::default()
        }
    }
}

/// Live progress counters (UI ticker only; authoritative numbers come from
/// the finalized tree).
#[derive(Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub logical_bytes: AtomicU64,
    pub symlinks: AtomicU64,
    pub hardlink_saved: AtomicU64,
    pub errors: AtomicU64,
    last_emit_ms: AtomicU64,
}

/// One scan's entire state. Held in AppState for the whole session; queries
/// (views, listings, stats, search) are served from it on demand, during and
/// after the walk.
pub struct ScanShared {
    pub scan_id: u64,
    pub root: PathBuf,
    pub root_name: String,
    pub dirs: DashMap<PathBuf, Mutex<DirAcc>>,
    pub token: ScanCancelToken,
    /// finalize() ran; cached totals are valid.
    pub complete: AtomicBool,
    /// The walk was cancelled; results are partial.
    pub cancelled: AtomicBool,
    pub counters: Counters,
    pub summary: Mutex<Option<ScanDone>>,
    /// State of the (separate, explicitly-triggered) duplicate pass.
    pub dup: Mutex<crate::reclaim::DupState>,
}

impl ScanShared {
    pub fn new(scan_id: u64, root: PathBuf) -> Self {
        let root_name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        Self {
            scan_id,
            root,
            root_name,
            dirs: DashMap::new(),
            token: ScanCancelToken::new(),
            complete: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            counters: Counters::default(),
            summary: Mutex::new(None),
            dup: Mutex::new(crate::reclaim::DupState::default()),
        }
    }

    pub fn is_complete(&self) -> bool {
        self.complete.load(Ordering::Acquire)
    }
}

// ----- Frontend payload types (mirrored by hand in src/types.ts) -----------

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// One node of an on-demand treemap view.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ViewNode {
    pub name: String,
    pub path: String,
    /// Allocated bytes, recursive for directories.
    pub size: u64,
    pub is_dir: bool,
    /// Recursive counts (directories only).
    #[serde(skip_serializing_if = "is_zero")]
    pub file_count: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub dir_count: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub error_count: u64,
    #[serde(skip_serializing_if = "is_false")]
    pub is_symlink: bool,
    /// Synthetic tail rollup of this directory's smaller children (files AND
    /// folders). Click → list the parent directory.
    #[serde(skip_serializing_if = "is_false")]
    pub aggregated: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub aggregated_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregated_parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<SkipReason>,
    /// Directory has content that this view doesn't include (depth cap or
    /// node budget). Drill in to fetch it.
    #[serde(skip_serializing_if = "is_false")]
    pub has_hidden_children: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ViewNode>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ViewPayload {
    pub scan_id: u64,
    pub complete: bool,
    pub cancelled: bool,
    pub root: ViewNode,
}

#[derive(Serialize, Clone, Debug)]
pub struct DirEntryPayload {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub is_symlink: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<SkipReason>,
    #[serde(skip_serializing_if = "is_zero")]
    pub file_count: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub dir_count: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DirListing {
    pub path: String,
    pub dir_size: u64,
    pub total: usize,
    pub offset: usize,
    pub entries: Vec<DirEntryPayload>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ExtStat {
    pub ext: String,
    pub count: u64,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct CatStat {
    pub category: String,
    pub count: u64,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ExtOtherStat {
    pub distinct: u64,
    pub count: u64,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct TopFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Stats {
    /// Complete category totals over ALL files (not truncated). Non-zero
    /// categories only, sorted by size descending.
    pub by_category: Vec<CatStat>,
    /// Top extensions by size. `ext_other` holds the aggregated remainder so
    /// percentages still sum to the true total.
    pub by_extension: Vec<ExtStat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext_other: Option<ExtOtherStat>,
    pub top_files: Vec<TopFile>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SkippedEntry {
    pub path: String,
    pub reason: SkipReason,
}

/// Final (or cancelled-partial) scan summary.
#[derive(Serialize, Clone, Debug)]
pub struct ScanDone {
    pub scan_id: u64,
    pub root_path: String,
    pub root_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_note: Option<String>,
    pub cancelled: bool,
    pub elapsed_ms: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub total_symlinks: u64,
    /// Allocated bytes (hardlink-deduplicated) — the headline number.
    pub allocated_bytes: u64,
    /// Sum of logical file lengths, for the summary's honesty line.
    pub logical_bytes: u64,
    pub hardlink_saved_bytes: u64,
    pub permission_errors: u64,
    pub skipped: Vec<SkippedEntry>,
    pub skipped_total: u64,
    pub stats: Stats,
}

// ----- Walk ----------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

pub type ProgressCb = dyn Fn(u64, u64, u64, u64, String) + Send + Sync;

/// Walk the tree rooted at `shared.root`, populating `shared.dirs`.
/// Returns normally on completion OR cancellation (check `shared.cancelled`).
/// Panic-free by construction: no unwrap/expect/indexing on runtime data.
pub fn walk(shared: &Arc<ScanShared>, policy: Arc<ScanPolicy>, on_progress: Arc<ProgressCb>) {
    let root = shared.root.clone();
    shared
        .dirs
        .entry(root.clone())
        .or_insert_with(|| Mutex::new(DirAcc::new(shared.root_name.clone())));

    // (device, inode) pairs already counted, for hardlink dedup.
    let seen_inodes: Arc<DashSet<(u64, u64)>> = Arc::new(DashSet::new());

    let shared_w = shared.clone();
    let policy_w = policy;
    let seen_w = seen_inodes;
    let progress_w = on_progress.clone();

    let walker = jwalk::WalkDirGeneric::<((), ())>::new(&root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(jwalk::Parallelism::RayonNewPool(0))
        .process_read_dir(move |_depth, dir_path, _state, children| {
            if shared_w.token.is_cancelled() {
                children.clear();
                return;
            }

            let dir_path_buf = dir_path.to_path_buf();
            shared_w
                .dirs
                .entry(dir_path_buf.clone())
                .or_insert_with(|| Mutex::new(DirAcc::new(name_of(dir_path))));

            let mut local_size: u64 = 0;
            let mut local_logical: u64 = 0;
            let mut local_files: Vec<FileRec> = Vec::new();
            let mut local_subdirs: Vec<PathBuf> = Vec::new();
            let mut local_errors: u64 = 0;
            let mut local_symlinks: u64 = 0;
            let mut local_hl_saved: u64 = 0;

            for (i, entry_result) in children.iter_mut().enumerate() {
                if i % CANCEL_CHECK_STRIDE == CANCEL_CHECK_STRIDE - 1
                    && shared_w.token.is_cancelled()
                {
                    children.clear();
                    return;
                }
                match entry_result {
                    Ok(entry) => {
                        let fname = entry.file_name().to_string_lossy().into_owned();
                        let ft = entry.file_type;
                        if ft.is_symlink() {
                            // Never followed; the link itself occupies ~0
                            // allocated bytes but is still recorded.
                            let size = entry
                                .metadata()
                                .ok()
                                .map(|md| md.blocks() * 512)
                                .unwrap_or(0);
                            local_symlinks += 1;
                            local_size += size;
                            local_files.push(FileRec {
                                name: fname,
                                size,
                                is_symlink: true,
                                ..Default::default()
                            });
                        } else if ft.is_dir() {
                            let child_path = entry.path();
                            let dev = entry.metadata().ok().map(|md| md.dev());
                            let skip = policy_w.skip_reason(&child_path, dev);
                            shared_w.dirs.entry(child_path.clone()).or_insert_with(|| {
                                Mutex::new(match skip {
                                    Some(r) => DirAcc::skipped(fname.clone(), r),
                                    None => DirAcc::new(fname.clone()),
                                })
                            });
                            if skip.is_some() {
                                // Do not descend.
                                entry.read_children_path = None;
                            }
                            local_subdirs.push(child_path);
                        } else {
                            // Regular files, plus rare others (sockets,
                            // FIFOs) which report 0 blocks anyway.
                            match entry.metadata() {
                                Ok(md) => {
                                    let alloc = md.blocks() * 512;
                                    let counted =
                                        if md.nlink() > 1 && !seen_w.insert((md.dev(), md.ino())) {
                                            local_hl_saved += alloc;
                                            0
                                        } else {
                                            alloc
                                        };
                                    local_size += counted;
                                    local_logical += md.len();
                                    local_files.push(FileRec {
                                        name: fname,
                                        size: counted,
                                        logical: md.len(),
                                        mtime: md.mtime(),
                                        is_symlink: false,
                                        hardlinked: md.nlink() > 1,
                                    });
                                }
                                Err(_) => {
                                    local_errors += 1;
                                    local_files.push(FileRec {
                                        name: fname,
                                        ..Default::default()
                                    });
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // Unreadable entry inside a readable directory.
                        // Counted here and ONLY here (the drain loop skips
                        // Err entries to avoid double counting).
                        local_errors += 1;
                    }
                }
            }

            let added_files = local_files.iter().filter(|f| !f.is_symlink).count() as u64;
            let added_dirs = local_subdirs.len() as u64;

            if let Some(acc) = shared_w.dirs.get(&dir_path_buf) {
                let mut g = acc.lock();
                g.own_size += local_size;
                g.error_count += local_errors;
                g.symlink_count += local_symlinks;
                g.files.append(&mut local_files);
                g.children.append(&mut local_subdirs);
            }

            let c = &shared_w.counters;
            c.files.fetch_add(added_files, Ordering::Relaxed);
            c.dirs.fetch_add(added_dirs, Ordering::Relaxed);
            c.bytes.fetch_add(local_size, Ordering::Relaxed);
            c.logical_bytes.fetch_add(local_logical, Ordering::Relaxed);
            c.symlinks.fetch_add(local_symlinks, Ordering::Relaxed);
            c.hardlink_saved
                .fetch_add(local_hl_saved, Ordering::Relaxed);
            c.errors.fetch_add(local_errors, Ordering::Relaxed);

            let now = now_ms();
            let last = c.last_emit_ms.load(Ordering::Relaxed);
            if now.saturating_sub(last) >= PROGRESS_EMIT_MS
                && c.last_emit_ms
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                (progress_w)(
                    c.files.load(Ordering::Relaxed),
                    c.dirs.load(Ordering::Relaxed),
                    c.bytes.load(Ordering::Relaxed),
                    c.errors.load(Ordering::Relaxed),
                    dir_path.to_string_lossy().to_string(),
                );
            }
        });

    // Drain the walker. Unreadable DIRECTORIES surface here as an Ok entry
    // carrying read_children_error — count each once, attributed to that
    // directory. Err entries were already counted in process_read_dir.
    for entry in walker {
        if shared.token.is_cancelled() {
            shared.cancelled.store(true, Ordering::SeqCst);
            break;
        }
        if let Ok(e) = entry {
            if e.read_children_error.is_some() {
                if let Some(acc) = shared.dirs.get(&e.path()) {
                    acc.lock().error_count += 1;
                }
                shared.counters.errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    if shared.token.is_cancelled() {
        shared.cancelled.store(true, Ordering::SeqCst);
    }

    // Final progress tick so the UI shows the true end state.
    let c = &shared.counters;
    (on_progress)(
        c.files.load(Ordering::Relaxed),
        c.dirs.load(Ordering::Relaxed),
        c.bytes.load(Ordering::Relaxed),
        c.errors.load(Ordering::Relaxed),
        String::new(),
    );
}

// ----- Totals / finalize ---------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
pub struct Totals {
    pub size: u64,
    pub files: u64,
    pub dirs: u64,
    pub errors: u64,
    pub symlinks: u64,
}

/// Compute recursive totals for every directory under `start` (iterative
/// post-order; a visited-set guards against pathological cycles).
pub(crate) fn compute_subtree_totals(
    shared: &ScanShared,
    start: &Path,
) -> HashMap<PathBuf, Totals> {
    let mut memo: HashMap<PathBuf, Totals> = HashMap::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, bool)> = vec![(start.to_path_buf(), false)];

    while let Some((path, processed)) = stack.pop() {
        if processed {
            let mut t = Totals::default();
            let children = if let Some(acc) = shared.dirs.get(&path) {
                let g = acc.lock();
                t.size = g.own_size;
                t.errors = g.error_count;
                t.symlinks = g.symlink_count;
                t.files = g.files.iter().filter(|f| !f.is_symlink).count() as u64;
                g.children.clone()
            } else {
                Vec::new()
            };
            for child in &children {
                if let Some(ct) = memo.get(child) {
                    t.size += ct.size;
                    t.files += ct.files;
                    t.dirs += 1 + ct.dirs;
                    t.errors += ct.errors;
                    t.symlinks += ct.symlinks;
                } else {
                    t.dirs += 1;
                }
            }
            memo.insert(path, t);
        } else {
            if !visited.insert(path.clone()) {
                continue;
            }
            let children = shared
                .dirs
                .get(&path)
                .map(|acc| acc.lock().children.clone())
                .unwrap_or_default();
            stack.push((path, true));
            for child in children {
                stack.push((child, false));
            }
        }
    }
    memo
}

/// Cache recursive totals on every DirAcc and mark the scan complete.
pub fn finalize(shared: &ScanShared) {
    let totals = compute_subtree_totals(shared, &shared.root);
    for (path, t) in &totals {
        if let Some(acc) = shared.dirs.get(path) {
            let mut g = acc.lock();
            g.total_size = t.size;
            g.rec_files = t.files;
            g.rec_dirs = t.dirs;
            g.rec_errors = t.errors;
            g.rec_symlinks = t.symlinks;
        }
    }
    shared.complete.store(true, Ordering::Release);
}

/// Cached totals of the scan root (valid once finalize ran).
pub fn root_totals(shared: &ScanShared) -> Totals {
    cached_totals(shared, &shared.root)
}

pub(crate) fn cached_totals(shared: &ScanShared, path: &Path) -> Totals {
    shared
        .dirs
        .get(path)
        .map(|acc| {
            let g = acc.lock();
            Totals {
                size: g.total_size,
                files: g.rec_files,
                dirs: g.rec_dirs,
                errors: g.rec_errors,
                symlinks: g.rec_symlinks,
            }
        })
        .unwrap_or_default()
}

// ----- Stats ---------------------------------------------------------------

fn extract_ext(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

/// Full-scan statistics: complete per-category totals, top extensions with an
/// aggregated remainder, and the largest files. Symlinks are excluded (they
/// carry no meaningful size and would pollute the "no extension" bucket).
pub fn compute_stats(shared: &ScanShared) -> Stats {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut by_ext: HashMap<String, (u64, u64)> = HashMap::new();
    let mut by_cat: HashMap<&'static str, (u64, u64)> = HashMap::new();
    let mut top: BinaryHeap<Reverse<(u64, String, String)>> = BinaryHeap::new();

    for kv in shared.dirs.iter() {
        let dir_path = kv.key();
        let g = kv.value().lock();
        if g.skip.is_some() {
            continue;
        }
        for f in &g.files {
            if f.is_symlink {
                continue;
            }
            let ext = extract_ext(&f.name);
            let cat = category_for_ext(&ext);
            let e = by_ext.entry(ext).or_insert((0, 0));
            e.0 += 1;
            e.1 += f.size;
            let ce = by_cat.entry(cat).or_insert((0, 0));
            ce.0 += 1;
            ce.1 += f.size;

            let candidate = |top: &BinaryHeap<Reverse<(u64, String, String)>>| {
                top.len() < TOP_FILES_N
                    || top
                        .peek()
                        .map(|Reverse((min, _, _))| f.size > *min)
                        .unwrap_or(true)
            };
            if candidate(&top) {
                let full = dir_path.join(&f.name);
                top.push(Reverse((
                    f.size,
                    f.name.clone(),
                    full.to_string_lossy().into_owned(),
                )));
                if top.len() > TOP_FILES_N {
                    top.pop();
                }
            }
        }
    }

    let mut by_category: Vec<CatStat> = by_cat
        .into_iter()
        .map(|(category, (count, size))| CatStat {
            category: category.to_string(),
            count,
            size,
        })
        .collect();
    by_category.sort_by_key(|c| std::cmp::Reverse(c.size));

    let mut by_extension: Vec<ExtStat> = by_ext
        .into_iter()
        .map(|(ext, (count, size))| ExtStat { ext, count, size })
        .collect();
    by_extension.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
    let ext_other = if by_extension.len() > MAX_EXT_ROWS {
        let rest = by_extension.split_off(MAX_EXT_ROWS);
        Some(ExtOtherStat {
            distinct: rest.len() as u64,
            count: rest.iter().map(|e| e.count).sum(),
            size: rest.iter().map(|e| e.size).sum(),
        })
    } else {
        None
    };

    let mut top_files: Vec<TopFile> = top
        .into_iter()
        .map(|Reverse((size, name, path))| TopFile { name, path, size })
        .collect();
    top_files.sort_by_key(|f| std::cmp::Reverse(f.size));

    Stats {
        by_category,
        by_extension,
        ext_other,
        top_files,
    }
}

/// All skipped directories, for the summary panel. Sorted by path; capped.
pub fn collect_skipped(shared: &ScanShared) -> (Vec<SkippedEntry>, u64) {
    let mut all: Vec<SkippedEntry> = shared
        .dirs
        .iter()
        .filter_map(|kv| {
            let g = kv.value().lock();
            g.skip.map(|reason| SkippedEntry {
                path: kv.key().to_string_lossy().to_string(),
                reason,
            })
        })
        .collect();
    let total = all.len() as u64;
    all.sort_by(|a, b| a.path.cmp(&b.path));
    all.truncate(MAX_SKIPPED_REPORTED);
    (all, total)
}

// ----- View building -------------------------------------------------------

enum Candidate {
    Dir {
        path: PathBuf,
        name: String,
        totals: Totals,
        skip: Option<SkipReason>,
    },
    File {
        name: String,
        size: u64,
        is_symlink: bool,
    },
}

impl Candidate {
    fn size(&self) -> u64 {
        match self {
            Candidate::Dir { totals, .. } => totals.size,
            Candidate::File { size, .. } => *size,
        }
    }
}

struct Slot {
    node: ViewNode,
    child_ids: Vec<usize>,
}

/// Build a bounded treemap view of the subtree at `path`: at most `max_depth`
/// levels and (approximately) `budget` nodes. Every directory either shows
/// ALL its children, rolls the tail into one explicit aggregate node (bytes
/// preserved), or is marked `has_hidden_children` — sizes are always honest.
/// Works on both live (mid-scan) and finalized state.
pub fn build_view(
    shared: &ScanShared,
    path: &Path,
    max_depth: usize,
    budget: usize,
) -> Result<ViewNode, String> {
    if !shared.dirs.contains_key(path) {
        return Err(format!(
            "path is not part of this scan: {}",
            path.to_string_lossy()
        ));
    }
    let live_totals = if shared.is_complete() {
        None
    } else {
        Some(compute_subtree_totals(shared, path))
    };
    let totals_of = |p: &Path| -> Totals {
        match &live_totals {
            Some(map) => map.get(p).copied().unwrap_or_default(),
            None => cached_totals(shared, p),
        }
    };

    let max_depth = max_depth.clamp(1, 8);
    let budget = budget.clamp(100, 20_000);

    let root_totals = totals_of(path);
    let root_node = dir_view_node(shared, path, root_totals);

    let mut arena: Vec<Slot> = vec![Slot {
        node: root_node,
        child_ids: Vec::new(),
    }];
    let mut queue: VecDeque<(usize, PathBuf, usize)> =
        VecDeque::from([(0usize, path.to_path_buf(), 0usize)]);
    let mut budget_left = budget.saturating_sub(1);

    while let Some((id, dir_path, depth)) = queue.pop_front() {
        let (files, subdir_paths) = match shared.dirs.get(&dir_path) {
            Some(acc) => {
                let g = acc.lock();
                (g.files.clone(), g.children.clone())
            }
            None => continue,
        };
        let has_content = !files.is_empty() || !subdir_paths.is_empty();

        if depth >= max_depth || budget_left == 0 {
            if let Some(slot) = arena.get_mut(id) {
                slot.node.has_hidden_children = has_content;
            }
            continue;
        }

        let mut cands: Vec<Candidate> = Vec::with_capacity(files.len() + subdir_paths.len());
        for sp in subdir_paths {
            let (name, skip) = shared
                .dirs
                .get(&sp)
                .map(|acc| {
                    let g = acc.lock();
                    (g.name.clone(), g.skip)
                })
                .unwrap_or_else(|| (name_of(&sp), None));
            let totals = totals_of(&sp);
            cands.push(Candidate::Dir {
                path: sp,
                name,
                totals,
                skip,
            });
        }
        for f in files {
            cands.push(Candidate::File {
                name: f.name,
                size: f.size,
                is_symlink: f.is_symlink,
            });
        }
        cands.sort_by_key(|c| std::cmp::Reverse(c.size()));

        let parent_total = arena.get(id).map(|s| s.node.size).unwrap_or(0).max(1);
        let floor = ((parent_total as f64 * FLOOR_FRACTION) as u64).max(FLOOR_ABS);

        let mut agg_size: u64 = 0;
        let mut agg_count: u64 = 0;
        let mut kept_here: usize = 0;
        let mut placed: u64 = 0;

        for (i, cand) in cands.into_iter().enumerate() {
            // Keep a child if it clears the sliver floor — or, so the tail
            // aggregate stays a genuine tail, while the not-yet-placed
            // remainder still holds more than ~20% of the directory's bytes
            // (uniform directories would otherwise collapse into one giant
            // "smaller items" block).
            let remainder_large = parent_total.saturating_sub(placed) > parent_total / 5;
            let keep = budget_left > 0
                && kept_here < MAX_CHILDREN_PER_DIR
                && (i < KEEP_MIN || cand.size() >= floor || remainder_large);
            if !keep {
                agg_size += cand.size();
                agg_count += 1;
                continue;
            }
            budget_left -= 1;
            kept_here += 1;
            placed += cand.size();
            let child_id = arena.len();
            match cand {
                Candidate::Dir {
                    path: dpath,
                    name,
                    totals,
                    skip,
                } => {
                    let mut node = ViewNode {
                        name,
                        path: dpath.to_string_lossy().to_string(),
                        size: totals.size,
                        is_dir: true,
                        file_count: totals.files,
                        dir_count: totals.dirs,
                        error_count: totals.errors,
                        skip_reason: skip,
                        ..Default::default()
                    };
                    if skip.is_some() {
                        node.has_hidden_children = false;
                    } else {
                        queue.push_back((child_id, dpath, depth + 1));
                    }
                    arena.push(Slot {
                        node,
                        child_ids: Vec::new(),
                    });
                }
                Candidate::File {
                    name,
                    size,
                    is_symlink,
                } => {
                    let fpath = dir_path.join(&name);
                    arena.push(Slot {
                        node: ViewNode {
                            name,
                            path: fpath.to_string_lossy().to_string(),
                            size,
                            is_dir: false,
                            is_symlink,
                            ..Default::default()
                        },
                        child_ids: Vec::new(),
                    });
                }
            }
            if let Some(slot) = arena.get_mut(id) {
                slot.child_ids.push(child_id);
            }
        }

        if agg_count > 0 {
            let parent_str = dir_path.to_string_lossy().to_string();
            let agg_id = arena.len();
            arena.push(Slot {
                node: ViewNode {
                    name: format!("{} smaller items", agg_count),
                    path: format!("{}/\u{f8ff}aggregate", parent_str),
                    size: agg_size,
                    is_dir: false,
                    aggregated: true,
                    aggregated_count: agg_count,
                    aggregated_parent: Some(parent_str),
                    ..Default::default()
                },
                child_ids: Vec::new(),
            });
            if let Some(slot) = arena.get_mut(id) {
                slot.child_ids.push(agg_id);
            }
        }
    }

    Ok(assemble(&mut arena, 0))
}

/// Move nodes out of the arena into their final tree shape. Recursion depth
/// is bounded by the view depth (≤ 8).
fn assemble(arena: &mut Vec<Slot>, id: usize) -> ViewNode {
    let (mut node, child_ids) = match arena.get_mut(id) {
        Some(slot) => (
            std::mem::take(&mut slot.node),
            std::mem::take(&mut slot.child_ids),
        ),
        None => return ViewNode::default(),
    };
    for cid in child_ids {
        node.children.push(assemble(arena, cid));
    }
    node
}

fn dir_view_node(shared: &ScanShared, path: &Path, totals: Totals) -> ViewNode {
    let (name, skip) = shared
        .dirs
        .get(path)
        .map(|acc| {
            let g = acc.lock();
            (g.name.clone(), g.skip)
        })
        .unwrap_or_else(|| (name_of(path), None));
    ViewNode {
        name,
        path: path.to_string_lossy().to_string(),
        size: totals.size,
        is_dir: true,
        file_count: totals.files,
        dir_count: totals.dirs,
        error_count: totals.errors,
        skip_reason: skip,
        ..Default::default()
    }
}

// ----- Directory listing ---------------------------------------------------

/// Complete, honest listing of one directory's direct children (dirs with
/// recursive totals + files), sorted by size descending. This is what an
/// aggregate node opens into.
pub fn list_dir(
    shared: &ScanShared,
    path: &Path,
    offset: usize,
    limit: usize,
) -> Result<DirListing, String> {
    let (files, subdir_paths) = match shared.dirs.get(path) {
        Some(acc) => {
            let g = acc.lock();
            (g.files.clone(), g.children.clone())
        }
        None => {
            return Err(format!(
                "path is not part of this scan: {}",
                path.to_string_lossy()
            ))
        }
    };

    let live_totals = if shared.is_complete() {
        None
    } else {
        Some(compute_subtree_totals(shared, path))
    };
    let totals_of = |p: &Path| -> Totals {
        match &live_totals {
            Some(map) => map.get(p).copied().unwrap_or_default(),
            None => cached_totals(shared, p),
        }
    };

    let mut entries: Vec<DirEntryPayload> = Vec::with_capacity(files.len() + subdir_paths.len());
    for sp in subdir_paths {
        let (name, skip) = shared
            .dirs
            .get(&sp)
            .map(|acc| {
                let g = acc.lock();
                (g.name.clone(), g.skip)
            })
            .unwrap_or_else(|| (name_of(&sp), None));
        let t = totals_of(&sp);
        entries.push(DirEntryPayload {
            name,
            path: sp.to_string_lossy().to_string(),
            size: t.size,
            is_dir: true,
            is_symlink: false,
            skip_reason: skip,
            file_count: t.files,
            dir_count: t.dirs,
        });
    }
    for f in files {
        let fpath = path.join(&f.name);
        entries.push(DirEntryPayload {
            name: f.name,
            path: fpath.to_string_lossy().to_string(),
            size: f.size,
            is_dir: false,
            is_symlink: f.is_symlink,
            skip_reason: None,
            file_count: 0,
            dir_count: 0,
        });
    }
    entries.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));

    let total = entries.len();
    let dir_size = totals_of(path).size;
    let limit = limit.clamp(1, 2000);
    let end = offset.saturating_add(limit).min(total);
    let slice = if offset < total {
        entries[offset..end].to_vec()
    } else {
        Vec::new()
    };

    Ok(DirListing {
        path: path.to_string_lossy().to_string(),
        dir_size,
        total,
        offset,
        entries: slice,
    })
}

// ----- Search --------------------------------------------------------------

pub struct SearchQuery {
    pub text: String,
    pub min_size: u64,
    pub category: Option<String>,
    /// Exact (lowercase) extension filter, e.g. "mp4".
    pub ext: Option<String>,
    pub limit: usize,
}

/// Case-insensitive substring search over every scanned file and directory
/// name, ranked by size. Requires a finalized scan (totals must be cached).
pub fn search(shared: &ScanShared, q: &SearchQuery) -> Vec<SearchHit> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    if !shared.is_complete() {
        return Vec::new();
    }
    let needle = q.text.to_lowercase();
    let limit = q.limit.clamp(1, 1000);
    // Min-heap of the top `limit` hits by size.
    let mut heap: BinaryHeap<Reverse<(u64, String, String, bool)>> = BinaryHeap::new();
    let mut push = |size: u64, name: &str, path: String, is_dir: bool| {
        if size < q.min_size {
            return;
        }
        if heap.len() >= limit {
            if let Some(Reverse((min, _, _, _))) = heap.peek() {
                if size <= *min {
                    return;
                }
            }
            heap.pop();
        }
        heap.push(Reverse((size, name.to_string(), path, is_dir)));
    };

    for kv in shared.dirs.iter() {
        let dir_path = kv.key();
        let g = kv.value().lock();
        // Directory hits (only for pure text searches — a category or
        // extension filter means "files of this kind").
        if q.category.is_none()
            && q.ext.is_none()
            && !needle.is_empty()
            && g.name.to_lowercase().contains(&needle)
            && dir_path != &shared.root
        {
            push(
                g.total_size,
                &g.name,
                dir_path.to_string_lossy().to_string(),
                true,
            );
        }
        if g.skip.is_some() {
            continue;
        }
        for f in &g.files {
            if f.is_symlink {
                continue;
            }
            if !needle.is_empty() && !f.name.to_lowercase().contains(&needle) {
                continue;
            }
            if q.category.is_some() || q.ext.is_some() {
                let fext = extract_ext(&f.name);
                if let Some(ext) = &q.ext {
                    if &fext != ext {
                        continue;
                    }
                }
                if let Some(cat) = &q.category {
                    if category_for_ext(&fext) != cat.as_str() {
                        continue;
                    }
                }
            }
            let fpath = dir_path.join(&f.name);
            push(f.size, &f.name, fpath.to_string_lossy().to_string(), false);
        }
    }

    let mut hits: Vec<SearchHit> = heap
        .into_iter()
        .map(|Reverse((size, name, path, is_dir))| SearchHit {
            name,
            path,
            size,
            is_dir,
        })
        .collect();
    hits.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    hits
}

#[cfg(test)]
#[path = "scanner_tests.rs"]
mod tests;
