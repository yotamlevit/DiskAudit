// DiskAudit — read-only disk usage scanner.
//
// SECURITY INVARIANT (audited):
// This crate must NEVER perform filesystem mutation. Allowed APIs are
// strictly: std::fs::metadata, std::fs::symlink_metadata, std::fs::read_dir,
// jwalk traversal (which only reads). Forbidden: fs::write, fs::remove_*,
// fs::rename, fs::create_dir*, fs::set_permissions, OpenOptions with
// .write/.create/.append, std::process::Command, any libc syscalls that
// mutate. Tauri capability also restricts frontend to dialog:open only.

mod scanner;

use parking_lot::Mutex;
use scanner::{ScanCancelToken, ScanProgress, Stats, TreeNode};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct AppState {
    cancel: Mutex<Option<ScanCancelToken>>,
    /// Cached scan output for serving expand_aggregate without rescanning.
    cache: Mutex<Option<ScanCache>>,
}

struct ScanCache {
    total_bytes: u64,
    files_by_dir: HashMap<PathBuf, Vec<(String, u64)>>,
}

#[derive(Serialize, Clone)]
struct ScanResultPayload {
    root: Arc<TreeNode>,
    elapsed_ms: u128,
    total_files: u64,
    total_dirs: u64,
    total_bytes: u64,
    permission_errors: u64,
    stats: Stats,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    current: String,
}

#[tauri::command]
async fn start_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanResultPayload, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_buf.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    if let Some(prev) = state.cancel.lock().take() {
        prev.cancel();
    }

    let token = ScanCancelToken::new();
    *state.cancel.lock() = Some(token.clone());

    let app_for_progress = app.clone();
    let progress = ScanProgress {
        files: Arc::new(AtomicU64::new(0)),
        dirs: Arc::new(AtomicU64::new(0)),
        bytes: Arc::new(AtomicU64::new(0)),
        errors: Arc::new(AtomicU64::new(0)),
        last_emit_ms: Arc::new(AtomicU64::new(0)),
        on_tick: Arc::new(move |files, dirs, bytes, errors, current| {
            let _ = app_for_progress.emit(
                "scan://progress",
                ProgressPayload {
                    files,
                    dirs,
                    bytes,
                    errors,
                    current,
                },
            );
        }),
    };

    let token_for_task = token.clone();
    let token_for_select = token.clone();
    let path_for_task = path_buf.clone();
    let started = Instant::now();

    // Spawn the scan on a blocking thread. Important: we do NOT just await
    // the JoinHandle, because the blocking thread can get stuck inside a
    // network-backed metadata() call (e.g. on cloud-mounted dirs) and the
    // OS gives us no way to abort that syscall. Instead, we race the join
    // against a polling loop that watches the cancel flag, so the UI
    // command resolves immediately on cancel even if the blocking thread
    // is still blocked deep in the kernel. The thread will eventually
    // unblock on its own (or when the process exits) and exit cleanly.
    let join_handle = tauri::async_runtime::spawn_blocking(move || {
        scanner::scan(&path_for_task, progress, token_for_task)
    });
    let mut join_handle = Box::pin(join_handle);

    let scan_result = loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if token_for_select.is_cancelled() {
                    return Err("scan cancelled".to_string());
                }
            }
            joined = &mut join_handle => {
                break joined.map_err(|e| format!("scan task join error: {e}"))?;
            }
        }
    };

    let elapsed_ms = started.elapsed().as_millis();
    let scan = scan_result.map_err(|e| e.to_string())?;

    *state.cache.lock() = Some(ScanCache {
        total_bytes: scan.total_bytes,
        files_by_dir: scan.files_by_dir,
    });

    Ok(ScanResultPayload {
        root: Arc::new(scan.root),
        elapsed_ms,
        total_files: scan.total_files,
        total_dirs: scan.total_dirs,
        total_bytes: scan.total_bytes,
        permission_errors: scan.permission_errors,
        stats: scan.stats,
    })
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(prev) = state.cancel.lock().take() {
        prev.cancel();
    }
    Ok(())
}

/// Expand a "« N smaller files »" rollup. Given the parent directory whose
/// rollup the user clicked, return a synthetic directory node containing
/// the underlying small files as leaves.
#[tauri::command]
fn expand_aggregate(
    state: State<'_, AppState>,
    parent_path: String,
) -> Result<TreeNode, String> {
    let cache_guard = state.cache.lock();
    let cache = cache_guard
        .as_ref()
        .ok_or_else(|| "no scan in cache; run a scan first".to_string())?;

    let parent_buf = PathBuf::from(&parent_path);
    let files = cache
        .files_by_dir
        .get(&parent_buf)
        .ok_or_else(|| format!("no cached files for: {}", parent_path))?;

    // Compute the total size of the parent dir from the file list +
    // (we don't have subdir totals here, but for floor purposes the
    // file-only sum is a reasonable lower bound; the global floor still
    // applies). This matches the local_floor used during pruning.
    let parent_files_total: u64 = files.iter().map(|(_, s)| *s).sum();
    // Use whichever is larger between this dir's files-only size and the
    // recorded scan total — local floor scales with parent.size which
    // includes subdir contents in the original prune. To stay consistent
    // we use the original parent total if available; here we approximate
    // by max(files_total, ...) — this is imperfect but the floor mainly
    // matters for very large parents which will have a populated files list.
    let parent_total = parent_files_total;

    let global_floor = scanner::global_floor_for(cache.total_bytes);

    let node = scanner::expand_aggregate(&parent_buf, files, parent_total, global_floor);
    Ok(node)
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            expand_aggregate,
            home_dir
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
