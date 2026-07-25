// READ-ONLY filesystem scanner. See SECURITY INVARIANT in lib.rs.
//
// Strategy:
//   * jwalk does parallel directory traversal with a Rayon pool.
//   * Symlinks are NOT followed (no loops, no escape from root).
//   * Permission errors are counted, never panicked.
//   * After traversal we build the full hierarchy, then PRUNE it for the
//     frontend. Pruning aggregates small files into a synthetic rollup
//     node per directory while preserving total bytes.
//   * The full per-directory file list is retained separately so the
//     frontend can drill into a rollup ("expand_aggregate") on demand
//     without rescanning.
//
// IMPORTANT: every byte that sits on disk is counted. iCloud placeholder
// stubs, hidden dotfiles, and aggregated small files all contribute to
// totals — we never silently discard size.

use dashmap::DashMap;
use jwalk::WalkDirGeneric;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

// ----- Pruning constants ---------------------------------------------------

const MAX_FILES_PER_DIR: usize = 200;
const MIN_FILE_SIZE_FRACTION: f64 = 0.001;
const MIN_FILE_SIZE_ABS: u64 = 64 * 1024;
const MAX_TOTAL_NODES: usize = 15_000;
const CANCEL_CHECK_STRIDE: usize = 256;

// ----- Errors --------------------------------------------------------------

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("scan cancelled")]
    Cancelled,
}

// ----- Cancellation --------------------------------------------------------

#[derive(Clone)]
pub struct ScanCancelToken {
    flag: Arc<AtomicBool>,
}

impl ScanCancelToken {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

// ----- Progress ------------------------------------------------------------

type ProgressCb = dyn Fn(u64, u64, u64, u64, String) + Send + Sync;

pub struct ScanProgress {
    pub files: Arc<AtomicU64>,
    pub dirs: Arc<AtomicU64>,
    pub bytes: Arc<AtomicU64>,
    pub errors: Arc<AtomicU64>,
    pub last_emit_ms: Arc<AtomicU64>,
    pub on_tick: Arc<ProgressCb>,
}

// ----- Tree node (frontend payload) ----------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub file_count: u64,
    pub dir_count: u64,
    pub error_count: u64,
    /// Synthetic rollup of files pruned from the visualization. Click to
    /// expand_aggregate() the parent directory and see the underlying list.
    #[serde(skip_serializing_if = "is_false", default)]
    pub aggregated: bool,
    pub aggregated_count: u64,
    /// For aggregated nodes: the parent directory path whose small files
    /// are represented here. Used by expand_aggregate.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub aggregated_parent: Option<String>,
    /// True if this directory was skipped because it lives on a different
    /// filesystem (cloud sync, USB, network mount). Its `size` is unknown
    /// from our side — the bytes are not on this disk.
    #[serde(skip_serializing_if = "is_false", default)]
    pub external: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

pub struct ScanOutput {
    pub root: TreeNode,
    pub total_files: u64,
    pub total_dirs: u64,
    pub total_bytes: u64,
    pub permission_errors: u64,
    /// Full per-directory file list (name, size). Retained so the frontend
    /// can drill into aggregated rollups without rescanning.
    pub files_by_dir: HashMap<PathBuf, Vec<(String, u64)>>,
    pub stats: Stats,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ExtStat {
    pub ext: String,
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
    /// One entry per distinct extension. Sorted by size descending.
    pub by_extension: Vec<ExtStat>,
    /// Top N largest files, by size descending.
    pub top_files: Vec<TopFile>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Internal accumulator for a directory while we walk.
struct DirAcc {
    name: String,
    own_size: u64,
    file_count: u64,
    dir_count: u64,
    error_count: u64,
    external: bool,
    files: Vec<(String, u64)>,
    children: Vec<PathBuf>,
}

/// Path-based skip list for known macOS cloud-sync mount points. These
/// FileProvider-backed directories sit on the same device as $HOME but
/// every metadata() call inside them can hang on network I/O.
/// Their bytes are NOT on the local disk.
fn is_cloud_sync_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/Library/CloudStorage/")
        || s.contains("/Library/Mobile Documents/")
        // Common direct-mount locations:
        || s.ends_with("/Library/CloudStorage")
        || s.ends_with("/Library/Mobile Documents")
}

pub fn scan(
    root: &Path,
    progress: ScanProgress,
    cancel: ScanCancelToken,
) -> Result<ScanOutput, ScanError> {
    let canonical_root = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf());

    let dirs: Arc<DashMap<PathBuf, Mutex<DirAcc>>> = Arc::new(DashMap::new());

    let cancel_for_walk = cancel.clone();
    let dirs_for_walk = dirs.clone();
    let progress_files = progress.files.clone();
    let progress_dirs = progress.dirs.clone();
    let progress_bytes = progress.bytes.clone();
    let progress_errors = progress.errors.clone();
    let progress_last = progress.last_emit_ms.clone();
    let progress_cb = progress.on_tick.clone();

    let root_name = canonical_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_root.to_string_lossy().to_string());
    dirs.insert(
        canonical_root.clone(),
        Mutex::new(DirAcc {
            name: root_name,
            own_size: 0,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            external: false,
            files: Vec::new(),
            children: Vec::new(),
        }),
    );

    // Record the root's filesystem device so we can detect crossings into
    // mounts (USB drives, network shares, real FUSE volumes).
    let root_dev: u64 = std::fs::metadata(&canonical_root)
        .map(|m| m.dev())
        .unwrap_or(0);

    let walker = WalkDirGeneric::<((), ())>::new(&canonical_root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(jwalk::Parallelism::RayonNewPool(0))
        .process_read_dir(move |_depth, dir_path, _read_dir_state, children| {
            // Fast cancel path: drop all entries so jwalk doesn't queue more.
            if cancel_for_walk.is_cancelled() {
                children.clear();
                return;
            }

            let dir_path_buf = dir_path.to_path_buf();
            if !dirs_for_walk.contains_key(&dir_path_buf) {
                let name = dir_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir_path.to_string_lossy().to_string());
                dirs_for_walk.insert(
                    dir_path_buf.clone(),
                    Mutex::new(DirAcc {
                        name,
                        own_size: 0,
                        file_count: 0,
                        dir_count: 0,
                        error_count: 0,
                        external: false,
                        files: Vec::new(),
                        children: Vec::new(),
                    }),
                );
            }

            // External-filesystem skip. Two checks, either trips the skip:
            //   (a) Path-based: known macOS cloud-sync mount points
            //       (FileProvider sits on the same device but every stat()
            //       inside it can hang on the network).
            //   (b) Dev-ID-based: real mounts (USB, network, FUSE volumes)
            //       that report a different device id than the scan root.
            // Skipped dirs are recorded in the tree as zero-size externals;
            // their bytes are not counted toward the local-disk total.
            if is_cloud_sync_path(dir_path) {
                children.clear();
                if let Some(acc) = dirs_for_walk.get(&dir_path_buf) {
                    acc.lock().external = true;
                }
                return;
            }
            if root_dev != 0 {
                if let Ok(md) = std::fs::metadata(dir_path) {
                    if md.dev() != root_dev {
                        children.clear();
                        if let Some(acc) = dirs_for_walk.get(&dir_path_buf) {
                            acc.lock().external = true;
                        }
                        return;
                    }
                }
            }

            // Aggregate locally to minimize lock acquisition + atomic churn.
            let mut local_size: u64 = 0;
            let mut local_files: Vec<(String, u64)> = Vec::new();
            let mut local_subdirs: Vec<PathBuf> = Vec::new();
            let mut local_errors: u64 = 0;
            let mut iter_count: usize = 0;

            for entry_result in children.iter_mut() {
                iter_count += 1;
                if iter_count % CANCEL_CHECK_STRIDE == 0
                    && cancel_for_walk.is_cancelled()
                {
                    children.clear();
                    return;
                }

                match entry_result {
                    Ok(entry) => {
                        if entry.file_type.is_symlink() {
                            continue;
                        }
                        let fname_os = entry.file_name();
                        let fname = fname_os.to_string_lossy();

                        if entry.file_type.is_file() {
                            // Count every file. iCloud placeholders, hidden
                            // dotfiles, and everything else are ALL bytes
                            // on disk — they contribute to totals.
                            let size = match entry.metadata() {
                                Ok(md) => md.len(),
                                Err(_) => {
                                    local_errors += 1;
                                    0
                                }
                            };
                            local_size += size;
                            local_files.push((fname.into_owned(), size));
                        } else if entry.file_type.is_dir() {
                            let child_path = entry.path();
                            let child_name = fname.into_owned();
                            dirs_for_walk
                                .entry(child_path.clone())
                                .or_insert_with(|| {
                                    Mutex::new(DirAcc {
                                        name: child_name,
                                        own_size: 0,
                                        file_count: 0,
                                        dir_count: 0,
                                        error_count: 0,
                                        external: false,
                                        files: Vec::new(),
                                        children: Vec::new(),
                                    })
                                });
                            local_subdirs.push(child_path);
                        }
                    }
                    Err(_) => {
                        local_errors += 1;
                    }
                }
            }

            let added_files = local_files.len() as u64;
            let added_dirs = local_subdirs.len() as u64;

            if let Some(acc) = dirs_for_walk.get(&dir_path_buf) {
                let mut g = acc.lock();
                g.own_size += local_size;
                g.file_count += added_files;
                g.dir_count += added_dirs;
                g.error_count += local_errors;
                g.files.append(&mut local_files);
                g.children.append(&mut local_subdirs);
            }
            progress_files.fetch_add(added_files, Ordering::Relaxed);
            progress_dirs.fetch_add(added_dirs, Ordering::Relaxed);
            progress_bytes.fetch_add(local_size, Ordering::Relaxed);
            progress_errors.fetch_add(local_errors, Ordering::Relaxed);

            // Throttled progress emit (~ every 100ms).
            let now = now_ms();
            let last = progress_last.load(Ordering::Relaxed);
            if now.saturating_sub(last) >= 100
                && progress_last
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                let f = progress_files.load(Ordering::Relaxed);
                let d = progress_dirs.load(Ordering::Relaxed);
                let b = progress_bytes.load(Ordering::Relaxed);
                let e = progress_errors.load(Ordering::Relaxed);
                let cur = dir_path.to_string_lossy().to_string();
                (progress_cb)(f, d, b, e, cur);
            }
        });

    for entry in walker {
        if cancel.is_cancelled() {
            return Err(ScanError::Cancelled);
        }
        if entry.is_err() {
            progress.errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    {
        let f = progress.files.load(Ordering::Relaxed);
        let d = progress.dirs.load(Ordering::Relaxed);
        let b = progress.bytes.load(Ordering::Relaxed);
        let e = progress.errors.load(Ordering::Relaxed);
        (progress.on_tick)(f, d, b, e, String::new());
    }

    // Snapshot the full per-dir file lists BEFORE pruning, so we can serve
    // expand_aggregate later. This is the source of truth for drill-in.
    let files_by_dir = snapshot_files_by_dir(&dirs);

    // Compute stats from the same source. This walks every file once.
    let stats = compute_stats(&dirs);

    let mut tree = build_tree(&canonical_root, &dirs);
    let total_bytes = tree.size;
    prune_to_budget(&mut tree, total_bytes);

    let total_files = progress.files.load(Ordering::Relaxed);
    let total_dirs = progress.dirs.load(Ordering::Relaxed);
    let permission_errors = progress.errors.load(Ordering::Relaxed);

    Ok(ScanOutput {
        root: tree,
        total_files,
        total_dirs,
        total_bytes,
        permission_errors,
        files_by_dir,
        stats,
    })
}

/// Lowercase the file's last extension, or "" if none.
fn extract_ext(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default()
}

const TOP_FILES_N: usize = 50;
const MAX_EXT_ROWS: usize = 80;

fn compute_stats(dirs: &DashMap<PathBuf, Mutex<DirAcc>>) -> Stats {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut by_ext: HashMap<String, (u64, u64)> = HashMap::new();
    // Min-heap of size N: keep largest TOP_FILES_N files. We push Reverse so
    // smallest-of-the-top is at peek; if a new file beats it, swap.
    let mut top: BinaryHeap<Reverse<(u64, String, String)>> = BinaryHeap::new();

    for kv in dirs.iter() {
        let dir_path = kv.key();
        let g = kv.value().lock();
        if g.external {
            continue;
        }
        for (fname, fsize) in &g.files {
            let ext = extract_ext(fname);
            let entry = by_ext.entry(ext).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += *fsize;

            if top.len() < TOP_FILES_N {
                let mut full = dir_path.clone();
                full.push(fname);
                top.push(Reverse((
                    *fsize,
                    fname.clone(),
                    full.to_string_lossy().into_owned(),
                )));
            } else if let Some(Reverse((min_sz, _, _))) = top.peek() {
                if fsize > min_sz {
                    top.pop();
                    let mut full = dir_path.clone();
                    full.push(fname);
                    top.push(Reverse((
                        *fsize,
                        fname.clone(),
                        full.to_string_lossy().into_owned(),
                    )));
                }
            }
        }
    }

    let mut by_extension: Vec<ExtStat> = by_ext
        .into_iter()
        .map(|(ext, (count, size))| ExtStat { ext, count, size })
        .collect();
    by_extension.sort_by(|a, b| b.size.cmp(&a.size));
    by_extension.truncate(MAX_EXT_ROWS);

    let mut top_vec: Vec<TopFile> = top
        .into_iter()
        .map(|Reverse((size, name, path))| TopFile { name, path, size })
        .collect();
    top_vec.sort_by(|a, b| b.size.cmp(&a.size));

    Stats {
        by_extension,
        top_files: top_vec,
    }
}

fn snapshot_files_by_dir(
    dirs: &DashMap<PathBuf, Mutex<DirAcc>>,
) -> HashMap<PathBuf, Vec<(String, u64)>> {
    let mut out = HashMap::with_capacity(dirs.len());
    for kv in dirs.iter() {
        let g = kv.value().lock();
        if !g.files.is_empty() {
            out.insert(kv.key().clone(), g.files.clone());
        }
    }
    out
}

fn build_tree(root: &Path, dirs: &DashMap<PathBuf, Mutex<DirAcc>>) -> TreeNode {
    fn visit(path: &Path, dirs: &DashMap<PathBuf, Mutex<DirAcc>>) -> TreeNode {
        let (
            name,
            own_size,
            file_count,
            dir_count,
            error_count,
            external,
            files,
            children_paths,
        ) = {
            if let Some(acc) = dirs.get(path) {
                let g = acc.lock();
                (
                    g.name.clone(),
                    g.own_size,
                    g.file_count,
                    g.dir_count,
                    g.error_count,
                    g.external,
                    g.files.clone(),
                    g.children.clone(),
                )
            } else {
                (
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.to_string_lossy().to_string()),
                    0,
                    0,
                    0,
                    0,
                    false,
                    Vec::new(),
                    Vec::new(),
                )
            }
        };

        let mut total = own_size;
        let mut child_nodes: Vec<TreeNode> =
            Vec::with_capacity(children_paths.len() + files.len());

        for child_path in children_paths {
            let node = visit(&child_path, dirs);
            total += node.size;
            child_nodes.push(node);
        }

        for (fname, fsize) in files {
            let mut fpath = path.to_path_buf();
            fpath.push(&fname);
            child_nodes.push(TreeNode {
                name: fname,
                path: fpath.to_string_lossy().to_string(),
                size: fsize,
                is_dir: false,
                file_count: 0,
                dir_count: 0,
                error_count: 0,
                aggregated: false,
                aggregated_count: 1,
                aggregated_parent: None,
                external: false,
                children: Vec::new(),
            });
        }

        child_nodes.sort_by(|a, b| b.size.cmp(&a.size));

        TreeNode {
            name: if external {
                format!("{} «external»", name)
            } else {
                name
            },
            path: path.to_string_lossy().to_string(),
            size: total,
            is_dir: true,
            file_count,
            dir_count,
            error_count,
            aggregated: false,
            aggregated_count: file_count,
            aggregated_parent: None,
            external,
            children: child_nodes,
        }
    }

    visit(root, dirs)
}

// ----- Pruning -------------------------------------------------------------

fn count_nodes(n: &TreeNode) -> usize {
    1 + n.children.iter().map(count_nodes).sum::<usize>()
}

fn prune_to_budget(root: &mut TreeNode, total_bytes: u64) {
    let mut global_floor: u64 = ((total_bytes as f64) * 0.0001) as u64;
    if global_floor < MIN_FILE_SIZE_ABS {
        global_floor = MIN_FILE_SIZE_ABS;
    }
    for _ in 0..6 {
        prune_tree(root, global_floor);
        if count_nodes(root) <= MAX_TOTAL_NODES {
            return;
        }
        global_floor = global_floor.saturating_mul(2);
    }
}

fn prune_tree(node: &mut TreeNode, global_floor: u64) {
    for child in &mut node.children {
        if child.is_dir {
            prune_tree(child, global_floor);
        }
    }

    let mut subdirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();
    for child in node.children.drain(..) {
        if child.is_dir {
            subdirs.push(child);
        } else {
            files.push(child);
        }
    }

    let local_floor: u64 = {
        let by_fraction = ((node.size.max(1) as f64) * MIN_FILE_SIZE_FRACTION) as u64;
        by_fraction.max(MIN_FILE_SIZE_ABS).max(global_floor)
    };

    files.sort_by(|a, b| b.size.cmp(&a.size));

    let mut kept: Vec<TreeNode> = Vec::with_capacity(MAX_FILES_PER_DIR);
    let mut agg_size: u64 = 0;
    let mut agg_count: u64 = 0;

    for f in files {
        let small = f.size < local_floor;
        let over_cap = kept.len() >= MAX_FILES_PER_DIR;
        if !small && !over_cap {
            kept.push(f);
        } else {
            agg_size += f.size;
            agg_count += f.aggregated_count.max(1);
        }
    }

    if agg_count > 0 {
        kept.push(TreeNode {
            name: format!("« {} smaller files »", agg_count),
            path: format!("{}/<small files>", node.path),
            size: agg_size,
            is_dir: false,
            file_count: agg_count,
            dir_count: 0,
            error_count: 0,
            aggregated: true,
            aggregated_count: agg_count,
            aggregated_parent: Some(node.path.clone()),
            external: false,
            children: Vec::new(),
        });
    }

    let mut all = subdirs;
    all.extend(kept);
    all.sort_by(|a, b| b.size.cmp(&a.size));
    node.children = all;
}

// ----- Aggregate expansion (for drill-in on rollup nodes) ------------------

/// Build the list of files that were aggregated for a directory: i.e., the
/// files smaller than that dir's local prune floor (or beyond MAX_FILES_PER_DIR).
/// Returns a synthetic "directory" node containing those files as leaves so
/// the frontend can render them as a sub-treemap.
pub fn expand_aggregate(
    parent_dir: &Path,
    files: &[(String, u64)],
    parent_total_size: u64,
    global_floor: u64,
) -> TreeNode {
    let local_floor: u64 = {
        let by_fraction = ((parent_total_size.max(1) as f64) * MIN_FILE_SIZE_FRACTION) as u64;
        by_fraction.max(MIN_FILE_SIZE_ABS).max(global_floor)
    };

    let mut sorted: Vec<&(String, u64)> = files.iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));

    let small_files: Vec<&(String, u64)> = sorted
        .iter()
        .enumerate()
        .filter(|(i, (_, sz))| *i >= MAX_FILES_PER_DIR || *sz < local_floor)
        .map(|(_, p)| *p)
        .collect();

    let mut total: u64 = 0;
    let mut children: Vec<TreeNode> = Vec::with_capacity(small_files.len());
    for (fname, fsize) in &small_files {
        total += *fsize;
        let mut fpath = parent_dir.to_path_buf();
        fpath.push(fname);
        children.push(TreeNode {
            name: fname.clone(),
            path: fpath.to_string_lossy().to_string(),
            size: *fsize,
            is_dir: false,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            aggregated: false,
            aggregated_count: 1,
            aggregated_parent: None,
            external: false,
            children: Vec::new(),
        });
    }
    children.sort_by(|a, b| b.size.cmp(&a.size));

    TreeNode {
        name: format!("« {} smaller files »", children.len() as u64),
        path: format!("{}/<small files>", parent_dir.to_string_lossy()),
        size: total,
        is_dir: true,
        file_count: children.len() as u64,
        dir_count: 0,
        error_count: 0,
        aggregated: true,
        aggregated_count: children.len() as u64,
        aggregated_parent: Some(parent_dir.to_string_lossy().to_string()),
        external: false,
        children,
    }
}

/// Same global-floor logic as prune_to_budget, exposed for expand_aggregate
/// so the frontend gets a consistent threshold.
pub fn global_floor_for(total_bytes: u64) -> u64 {
    let f = ((total_bytes as f64) * 0.0001) as u64;
    f.max(MIN_FILE_SIZE_ABS)
}

include!("../tests_repro.rs");
