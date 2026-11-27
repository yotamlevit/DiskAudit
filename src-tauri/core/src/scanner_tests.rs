// Scanner tests against REAL fixture trees, built under the OS temp dir —
// the only place in the codebase (test-only, never compiled into the app)
// that writes to the filesystem. These run on every OS. (Synthetic-store
// tests live in scanner_synth_tests.rs.)

use super::*;
use crate::platform::ScanPolicy;
use std::fs;

fn tmp_root(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("diskaudit-test-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    crate::platform::resolve_root(&d)
}

fn noop_progress() -> Arc<ProgressCb> {
    Arc::new(|_, _, _, _, _| {})
}

/// Walk + finalize a real fixture directory with the default platform policy.
fn scan_fixture(root: &Path) -> Arc<ScanShared> {
    let shared = Arc::new(ScanShared::new(1, root.to_path_buf()));
    let policy = Arc::new(ScanPolicy::for_root(root));
    walk(&shared, policy, noop_progress());
    finalize(&shared);
    shared
}

/// Independent oracle for a path's allocated bytes (not following links).
/// On Unix this deliberately does NOT go through the platform layer under
/// test; Windows has no second API to ask.
#[cfg(unix)]
fn alloc_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).unwrap().blocks() * 512
}
#[cfg(not(unix))]
fn alloc_of(path: &Path) -> u64 {
    if fs::symlink_metadata(path).unwrap().file_type().is_symlink() {
        return platform::link_alloc(path);
    }
    let m = platform::stat_file(path).unwrap();
    assert!(
        m.alloc < m.logical + 1024 * 1024,
        "allocation {} is implausible for a {}-byte file",
        m.alloc,
        m.logical
    );
    m.alloc
}

/// Blocks a directory itself occupies (0 on APFS and on Windows, where the
/// scanner does not count them; ~4 KiB on ext4).
fn dir_alloc(_path: &Path) -> u64 {
    #[cfg(unix)]
    {
        alloc_of(_path)
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// Own blocks of every real directory in the fixture (root included),
/// found by an independent recursive read_dir — never through a symlink,
/// and not into `exclude` (directories the scan under test skips).
fn tree_dir_alloc(root: &Path, exclude: &[PathBuf]) -> u64 {
    let mut total = dir_alloc(root);
    for entry in fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() && !exclude.contains(&path) {
            total += tree_dir_alloc(&path, exclude);
        }
    }
    total
}

/// chmod 000 stops nobody when the tests run as root (containers).
#[cfg(unix)]
fn lock_dir(dir: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o000)).unwrap();
    fs::read_dir(dir).is_err()
}
#[cfg(unix)]
fn unlock_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Create a symlink; false where the OS refuses (Windows without Developer
/// Mode or admin rights), in which case the caller skips its assertions.
fn symlink(target: &Path, link: &Path, _is_dir: bool) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        if _is_dir {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        } else {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }
}

// ----- Real-filesystem fixtures -------------------------------------------

#[test]
fn counts_are_recursive() {
    let root = tmp_root("counts");
    fs::create_dir_all(root.join("a").join("b")).unwrap();
    fs::write(root.join("a/f1"), vec![1u8; 10_000]).unwrap();
    fs::write(root.join("a/b/f2"), vec![2u8; 20_000]).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    let expected = alloc_of(&root.join("a/f1")) + alloc_of(&root.join("a/b/f2"));
    assert_eq!(t.files, 2, "recursive file count");
    assert_eq!(t.dirs, 2, "recursive dir count");
    assert_eq!(
        t.size,
        expected + tree_dir_alloc(&root, &[]),
        "recursive allocated size"
    );

    // The view exposes recursive counts on the nested dir too.
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    let a = view.children.iter().find(|c| c.name == "a").unwrap();
    assert_eq!(a.file_count, 2);
    assert_eq!(a.dir_count, 1);
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn permission_error_counted_exactly_once() {
    let root = tmp_root("perm");
    let locked = root.join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("hidden.dat"), vec![0u8; 1000]).unwrap();
    if !lock_dir(&locked) {
        unlock_dir(&locked);
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);

    unlock_dir(&locked);
    let _ = fs::remove_dir_all(&root);

    assert_eq!(t.errors, 1, "one unreadable dir = exactly one error");

    // And it is attributed to the locked dir itself.
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    let locked_node = view.children.iter().find(|c| c.name == "locked").unwrap();
    assert_eq!(locked_node.error_count, 1);
}

#[test]
fn symlinks_counted_never_followed() {
    let root = tmp_root("symlink");
    fs::write(root.join("real.dat"), vec![0u8; 50_000]).unwrap();
    // A symlinked dir must not be traversed (its target counted once).
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("sub").join("inner.dat"), vec![0u8; 30_000]).unwrap();
    if !symlink(&root.join("real.dat"), &root.join("link"), false)
        || !symlink(&root.join("sub"), &root.join("sublink"), true)
    {
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    assert_eq!(t.files, 2, "symlinks are not files");
    assert_eq!(t.symlinks, 2, "both symlinks tallied");
    let expected = alloc_of(&root.join("real.dat"))
        + alloc_of(&root.join("sub").join("inner.dat"))
        + alloc_of(&root.join("link"))
        + alloc_of(&root.join("sublink"));
    assert_eq!(
        t.size,
        expected + tree_dir_alloc(&root, &[]),
        "targets counted once, links at own size"
    );

    // Symlinks appear in listings, flagged.
    let listing = list_dir(&shared, &root, 0, 100).unwrap();
    let links: Vec<_> = listing.entries.iter().filter(|e| e.is_symlink).collect();
    assert_eq!(links.len(), 2);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn hardlinks_deduplicated() {
    let root = tmp_root("hardlink");
    fs::write(root.join("orig.dat"), vec![0u8; 100_000]).unwrap();
    fs::hard_link(root.join("orig.dat"), root.join("copy.dat")).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    let one = alloc_of(&root.join("orig.dat"));
    assert_eq!(
        t.size,
        one + tree_dir_alloc(&root, &[]),
        "two links, one inode, counted once"
    );
    assert_eq!(t.files, 2, "both paths still listed as files");
    assert_eq!(
        shared.counters.hardlink_saved.load(Ordering::Relaxed),
        one,
        "deduplicated bytes reported"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn sparse_files_counted_at_allocated_size() {
    let root = tmp_root("sparse");
    let p = root.join("sparse.bin");
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = fs::File::create(&p).unwrap();
        f.seek(SeekFrom::Start(50_000_000)).unwrap();
        f.write_all(b"end").unwrap();
    }
    let md = fs::metadata(&p).unwrap();
    let allocated = alloc_of(&p);
    // Only meaningful if the filesystem actually made it sparse.
    if allocated >= md.len() {
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    assert_eq!(
        t.size,
        allocated + tree_dir_alloc(&root, &[]),
        "allocated, not logical"
    );
    assert_eq!(
        shared.counters.logical_bytes.load(Ordering::Relaxed),
        md.len(),
        "logical total tracked separately"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cancellation_returns_partial_without_error() {
    let root = tmp_root("cancel");
    fs::write(root.join("f.dat"), vec![0u8; 1000]).unwrap();

    let shared = Arc::new(ScanShared::new(1, root.clone()));
    shared.token.cancel(); // cancelled before it starts: hardest case
    let policy = Arc::new(ScanPolicy::for_root(&root));
    walk(&shared, policy, noop_progress());
    finalize(&shared);

    assert!(shared.cancelled.load(Ordering::SeqCst));
    assert!(shared.is_complete(), "finalize still runs on partial data");
    // Views over the partial store must not fail.
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    assert_eq!(view.path, root.to_string_lossy());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn skip_plumbing_marks_nodes_and_excludes_bytes() {
    let root = tmp_root("skips");
    fs::create_dir(root.join("kept")).unwrap();
    fs::write(root.join("kept").join("k.dat"), vec![0u8; 40_000]).unwrap();
    fs::create_dir(root.join("aliased")).unwrap();
    fs::write(root.join("aliased").join("a.dat"), vec![0u8; 90_000]).unwrap();

    // Policy that treats <root>/aliased as an alias and filters on the
    // root's real device (where the OS has one): "kept" must stay allowed.
    let policy = Arc::new(ScanPolicy::with_rules(
        platform::dir_meta(&root).dev.into_iter().collect(),
        vec![root.join("aliased")],
    ));
    let shared = Arc::new(ScanShared::new(1, root.clone()));
    walk(&shared, policy, noop_progress());
    finalize(&shared);

    let t = root_totals(&shared);
    assert_eq!(
        t.size,
        alloc_of(&root.join("kept").join("k.dat")) + tree_dir_alloc(&root, &[root.join("aliased")]),
        "alias content excluded from totals"
    );

    let view = build_view(&shared, &root, 4, 3000).unwrap();
    let aliased = view.children.iter().find(|c| c.name == "aliased").unwrap();
    assert_eq!(aliased.size, 0);
    assert!(aliased.skip_reason.is_some(), "skip visible in the view");

    let (skipped, total) = collect_skipped(&shared);
    assert_eq!(total, 1);
    assert_eq!(skipped[0].path, root.join("aliased").to_string_lossy());
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn unreadable_scan_root_reports_error_not_panic() {
    let root = tmp_root("rootlock");
    fs::write(root.join("f.dat"), b"x").unwrap();
    if !lock_dir(&root) {
        unlock_dir(&root);
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);

    unlock_dir(&root);
    let _ = fs::remove_dir_all(&root);

    assert_eq!(t.errors, 1, "root read failure is one visible error");
    assert_eq!(t.files, 0);
}

#[test]
fn empty_directory_view_is_valid() {
    let root = tmp_root("empty");
    let shared = scan_fixture(&root);
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    assert!(view.children.is_empty());
    assert!(!view.has_hidden_children);
    let own = dir_alloc(&root);
    let _ = fs::remove_dir_all(&root);
    assert_eq!(view.size, own, "an empty directory is only its own blocks");
}
