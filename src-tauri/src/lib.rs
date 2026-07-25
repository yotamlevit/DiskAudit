// DiskAudit — read-only disk usage scanner.
//
// SECURITY INVARIANT (audited):
// This crate must NEVER perform filesystem mutation. Allowed APIs are
// strictly: std::fs::metadata, std::fs::symlink_metadata, std::fs::read_dir,
// Path::canonicalize, jwalk traversal (which only reads), and — added for
// duplicate detection, reclaim.rs ONLY — std::fs::File::open in read mode to
// hash file contents. That last one is a deliberate, audited expansion of
// the I/O surface: it opens with File::open (never OpenOptions), reads
// bytes, and does nothing else with the handle. Forbidden everywhere:
// fs::write, fs::remove_*, fs::rename, fs::create_dir*, fs::set_permissions,
// OpenOptions with .write/.create/.append, std::process::Command, any libc
// calls that mutate.
//
// Plugin surface (see capabilities/default.json for the frontend grants,
// each justified there):
//   * dialog        — folder picker (open only).
//   * opener        — reveal-in-Finder (NSWorkspace "select in Finder") and
//                     opening the Full Disk Access settings pane URL. It
//                     never launches shells or arbitrary programs, and no
//                     app code passes it anything but a scanned path or the
//                     fixed settings URL.
//   * clipboard-manager — WRITE-only ("Copy path" / "Copy delete command",
//                     and the Reclaimable tab's exports and generated
//                     deletion scripts). The app never reads the clipboard.
//                     Everything the Reclaimable feature produces — findings
//                     exports (text/CSV/JSON) and deletion scripts — is
//                     plain text placed ON the clipboard for the USER to
//                     review and run themselves. No code path in DiskAudit
//                     executes a script or shell command, and none may be
//                     added; the app also never writes these artifacts to
//                     disk (no save dialog, no export file, no temp file).
//   * window-state  — persists window size/position in app data.
// None of these mutate the scanned filesystem.
//
// Test-only code (#[cfg(test)]) builds fixture trees under the OS temp dir
// (including one /bin/cp -c invocation to create an APFS clone fixture);
// none of it is compiled into the shipped app.

mod categories;
#[doc(hidden)]
pub mod devtool;
mod platform;
mod reclaim;
mod scanner;

use parking_lot::Mutex;
use scanner::{DirListing, ProgressCb, ScanDone, ScanShared, SearchHit, SearchQuery, ViewPayload};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct AppState {
    current: Mutex<Option<Arc<ScanShared>>>,
    next_scan_id: AtomicU64,
}

fn current_scan(state: &AppState) -> Result<Arc<ScanShared>, String> {
    state
        .current
        .lock()
        .clone()
        .ok_or_else(|| "no scan in progress or cached; start a scan first".to_string())
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    scan_id: u64,
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    current: String,
}

/// How long after a cancel we wait for the walker thread before returning a
/// partial summary anyway. The thread can be stuck in an unabortable
/// metadata() syscall (network filesystems); the UI must not hang with it.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

#[tauri::command]
async fn start_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ScanDone, String> {
    let path_buf = PathBuf::from(&path);
    let mut canonical = path_buf.canonicalize().unwrap_or(path_buf);
    let md = std::fs::metadata(&canonical)
        .map_err(|e| format!("Cannot access {}: {}", canonical.to_string_lossy(), e))?;
    if !md.is_dir() {
        // Forgiving: a dropped/typed FILE means "scan its enclosing folder".
        match canonical.parent() {
            Some(parent) if parent.as_os_str().is_empty() => {
                return Err(format!("Not a directory: {}", canonical.to_string_lossy()))
            }
            Some(parent) => canonical = parent.to_path_buf(),
            None => return Err(format!("Not a directory: {}", canonical.to_string_lossy())),
        }
    }

    // Supersede any running scan (and any duplicate pass on it).
    if let Some(prev) = state.current.lock().as_ref() {
        prev.token.cancel();
        reclaim::cancel_dup_scan(prev);
    }

    let scan_id = state.next_scan_id.fetch_add(1, Ordering::SeqCst) + 1;
    let shared = Arc::new(ScanShared::new(scan_id, canonical.clone()));
    *state.current.lock() = Some(shared.clone());

    let policy = Arc::new(platform::ScanPolicy::for_root(&canonical));
    let root_note = platform::root_note(&canonical);

    let app_for_progress = app.clone();
    let on_progress: Arc<ProgressCb> = Arc::new(move |files, dirs, bytes, errors, current| {
        let _ = app_for_progress.emit(
            "scan://progress",
            ProgressPayload {
                scan_id,
                files,
                dirs,
                bytes,
                errors,
                current,
            },
        );
    });

    let started = Instant::now();
    let shared_task = shared.clone();
    let note_task = root_note.clone();
    let join_handle = tauri::async_runtime::spawn_blocking(move || {
        // A panic anywhere in the scan must not take the app down (the
        // release profile unwinds; see Cargo.toml). Shared state is only
        // ever appended to, so observing it after a panic is safe.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            scanner::walk(&shared_task, policy, on_progress);
            scanner::finalize(&shared_task);
            let stats = scanner::compute_stats(&shared_task);
            let (skipped, skipped_total) = scanner::collect_skipped(&shared_task);
            let done = build_done(
                &shared_task,
                stats,
                skipped,
                skipped_total,
                note_task,
                started.elapsed().as_millis() as u64,
            );
            *shared_task.summary.lock() = Some(done.clone());
            done
        }))
    });
    let mut join_handle = Box::pin(join_handle);

    // Await the scan, but stay responsive to cancellation: if the walker
    // thread is stuck in the kernel, return a partial summary after a grace
    // period. The thread finishes on its own later and stores the full
    // summary in shared state (served by get_summary / get_view).
    let mut cancel_deadline: Option<Instant> = None;
    let joined = loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if shared.token.is_cancelled() {
                    let deadline = *cancel_deadline.get_or_insert_with(|| Instant::now() + CANCEL_GRACE);
                    if Instant::now() >= deadline {
                        return Ok(partial_done(&shared, root_note, started.elapsed().as_millis() as u64));
                    }
                }
            }
            joined = &mut join_handle => break joined,
        }
    };

    match joined {
        Ok(Ok(done)) => Ok(done),
        Ok(Err(_panic)) => Err(
            "The scan hit an internal error (panic) and was stopped. Partial results may be \
             available; please report this."
                .to_string(),
        ),
        Err(e) => Err(format!("scan task failed to run: {e}")),
    }
}

/// Summary from the finalized tree (authoritative totals).
fn build_done(
    shared: &ScanShared,
    stats: scanner::Stats,
    skipped: Vec<scanner::SkippedEntry>,
    skipped_total: u64,
    root_note: Option<String>,
    elapsed_ms: u64,
) -> ScanDone {
    let t = scanner::root_totals(shared);
    let c = &shared.counters;
    ScanDone {
        scan_id: shared.scan_id,
        root_path: shared.root.to_string_lossy().to_string(),
        root_name: shared.root_name.clone(),
        root_note,
        cancelled: shared.cancelled.load(Ordering::SeqCst),
        elapsed_ms,
        total_files: t.files,
        total_dirs: t.dirs,
        total_symlinks: t.symlinks,
        allocated_bytes: t.size,
        logical_bytes: c.logical_bytes.load(Ordering::Relaxed),
        hardlink_saved_bytes: c.hardlink_saved.load(Ordering::Relaxed),
        permission_errors: t.errors,
        skipped,
        skipped_total,
        stats,
    }
}

/// Best-effort summary from live counters, for when the walker thread cannot
/// be joined (stuck syscall after cancel). Stats/skips arrive later via
/// get_summary once the thread finishes.
fn partial_done(shared: &ScanShared, root_note: Option<String>, elapsed_ms: u64) -> ScanDone {
    let c = &shared.counters;
    ScanDone {
        scan_id: shared.scan_id,
        root_path: shared.root.to_string_lossy().to_string(),
        root_name: shared.root_name.clone(),
        root_note,
        cancelled: true,
        elapsed_ms,
        total_files: c.files.load(Ordering::Relaxed),
        total_dirs: c.dirs.load(Ordering::Relaxed),
        total_symlinks: c.symlinks.load(Ordering::Relaxed),
        allocated_bytes: c.bytes.load(Ordering::Relaxed),
        logical_bytes: c.logical_bytes.load(Ordering::Relaxed),
        hardlink_saved_bytes: c.hardlink_saved.load(Ordering::Relaxed),
        permission_errors: c.errors.load(Ordering::Relaxed),
        skipped: Vec::new(),
        skipped_total: 0,
        stats: scanner::Stats::default(),
    }
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cur) = state.current.lock().as_ref() {
        cur.token.cancel();
    }
    Ok(())
}

/// Bounded treemap view of a subtree. Works during a scan (partial, live
/// data) and after it (cached totals).
#[tauri::command]
async fn get_view(
    state: State<'_, AppState>,
    path: Option<String>,
    depth: Option<usize>,
    budget: Option<usize>,
) -> Result<ViewPayload, String> {
    let shared = current_scan(&state)?;
    let target = path
        .map(PathBuf::from)
        .unwrap_or_else(|| shared.root.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root =
            scanner::build_view(&shared, &target, depth.unwrap_or(4), budget.unwrap_or(3000))?;
        Ok::<ViewPayload, String>(ViewPayload {
            scan_id: shared.scan_id,
            complete: shared.is_complete(),
            cancelled: shared.cancelled.load(Ordering::SeqCst),
            root,
        })
    })
    .await
    .map_err(|e| format!("view task failed: {e}"))??;
    Ok(result)
}

/// Full listing of one directory's direct children (what an aggregate node
/// opens into), paged, sorted by size.
#[tauri::command]
async fn list_dir(
    state: State<'_, AppState>,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<DirListing, String> {
    let shared = current_scan(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        scanner::list_dir(
            &shared,
            &PathBuf::from(path),
            offset.unwrap_or(0),
            limit.unwrap_or(500),
        )
    })
    .await
    .map_err(|e| format!("list task failed: {e}"))?
}

/// Search scanned names by substring / category / minimum size.
#[tauri::command]
async fn search_files(
    state: State<'_, AppState>,
    query: String,
    min_size: Option<u64>,
    category: Option<String>,
    ext: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let shared = current_scan(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        scanner::search(
            &shared,
            &SearchQuery {
                text: query,
                min_size: min_size.unwrap_or(0),
                category,
                ext: ext.map(|e| e.to_lowercase()),
                limit: limit.unwrap_or(200),
            },
        )
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))
}

/// The stored summary of the current scan, if finalization has happened.
/// Used to pick up full results after a cancel returned early.
#[tauri::command]
fn get_summary(state: State<'_, AppState>) -> Result<Option<ScanDone>, String> {
    Ok(state
        .current
        .lock()
        .as_ref()
        .and_then(|s| s.summary.lock().clone()))
}

/// Reclaimable-space report: path-based findings (cheap, works live) merged
/// with duplicate results when the separate duplicate pass has run.
#[tauri::command]
async fn get_reclaim(state: State<'_, AppState>) -> Result<reclaim::ReclaimReport, String> {
    let shared = current_scan(&state)?;
    tauri::async_runtime::spawn_blocking(move || Ok(reclaim::build_report(&shared)))
        .await
        .map_err(|e| format!("reclaim task failed: {e}"))?
}

#[derive(Serialize, Clone)]
struct ReclaimProgressPayload {
    scan_id: u64,
    phase: String,
    done: u64,
    total: u64,
    bytes_read: u64,
}

/// Start the staged duplicate-detection pass (separate from the scan, and
/// the only code that reads file CONTENTS — read-only; see the SECURITY
/// INVARIANT above). Resolves when the pass finishes or is cancelled.
#[tauri::command]
async fn start_dup_scan(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let shared = current_scan(&state)?;
    if !shared.is_complete() {
        return Err("duplicate detection needs a finished scan".to_string());
    }
    if !reclaim::try_begin_dup_scan(&shared) {
        return Err("duplicate detection is already running".to_string());
    }
    let scan_id = shared.scan_id;
    let app_for_progress = app.clone();
    let on_progress: Arc<reclaim::DupProgressCb> =
        Arc::new(move |phase, done, total, bytes_read| {
            let _ = app_for_progress.emit(
                "reclaim://progress",
                ReclaimProgressPayload {
                    scan_id,
                    phase: phase.to_string(),
                    done,
                    total,
                    bytes_read,
                },
            );
        });
    let shared_task = shared.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reclaim::run_dup_scan(&shared_task, on_progress);
        }))
    })
    .await;
    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_panic)) => {
            reclaim::fail_dup_scan(&shared);
            Err("Duplicate detection hit an internal error and was stopped.".to_string())
        }
        Err(e) => {
            reclaim::fail_dup_scan(&shared);
            Err(format!("duplicate scan task failed to run: {e}"))
        }
    }
}

#[tauri::command]
fn cancel_dup_scan(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cur) = state.current.lock().as_ref() {
        reclaim::cancel_dup_scan(cur);
    }
    Ok(())
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    platform::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "HOME not set".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_scan,
            cancel_scan,
            get_view,
            list_dir,
            search_files,
            get_summary,
            get_reclaim,
            start_dup_scan,
            cancel_dup_scan,
            home_dir
        ])
        .setup(|app| {
            // Standard macOS menu bar. The Edit submenu is what makes
            // ⌘C/⌘V/⌘A work in the path and search inputs.
            let open_item = MenuItemBuilder::with_id("open-folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let rescan_item = MenuItemBuilder::with_id("rescan", "Rescan")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "DiskAudit")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_item)
                .item(&rescan_item)
                .separator()
                .close_window()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                use tauri::Emitter;
                match event.id().as_ref() {
                    "open-folder" => {
                        let _ = app.emit("menu://open-folder", ());
                    }
                    "rescan" => {
                        let _ = app.emit("menu://rescan", ());
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
