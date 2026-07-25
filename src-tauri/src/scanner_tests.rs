// Scanner unit tests. Fixture trees are built under the OS temp dir — the
// only place in the codebase (test-only, never compiled into the app) that
// writes to the filesystem.

use super::*;
use crate::platform::ScanPolicy;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn tmp_root(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("diskaudit-test-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
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

fn alloc_of(path: &Path) -> u64 {
    fs::symlink_metadata(path).unwrap().blocks() * 512
}

fn count_view_nodes(n: &ViewNode) -> usize {
    1 + n.children.iter().map(count_view_nodes).sum::<usize>()
}

/// Every rendered directory must account for all of its bytes: children
/// (including the aggregate) sum exactly to the parent, unless the parent
/// was left unexpanded.
fn assert_sizes_consistent(n: &ViewNode) {
    if n.is_dir && !n.children.is_empty() {
        let sum: u64 = n.children.iter().map(|c| c.size).sum();
        assert_eq!(
            sum, n.size,
            "children of {} sum to {} but node says {}",
            n.path, sum, n.size
        );
        for c in &n.children {
            assert_sizes_consistent(c);
        }
    }
}

// ----- Real-filesystem fixtures -------------------------------------------

#[test]
fn counts_are_recursive() {
    let root = tmp_root("counts");
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::write(root.join("a/f1"), vec![1u8; 10_000]).unwrap();
    fs::write(root.join("a/b/f2"), vec![2u8; 20_000]).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    let expected = alloc_of(&root.join("a/f1")) + alloc_of(&root.join("a/b/f2"));
    assert_eq!(t.files, 2, "recursive file count");
    assert_eq!(t.dirs, 2, "recursive dir count");
    assert_eq!(t.size, expected, "recursive allocated size");

    // The view exposes recursive counts on the nested dir too.
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    let a = view.children.iter().find(|c| c.name == "a").unwrap();
    assert_eq!(a.file_count, 2);
    assert_eq!(a.dir_count, 1);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn permission_error_counted_exactly_once() {
    let root = tmp_root("perm");
    let locked = root.join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("hidden.dat"), vec![0u8; 1000]).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
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
    std::os::unix::fs::symlink(root.join("real.dat"), root.join("link")).unwrap();
    // A symlinked dir must not be traversed (its target counted once).
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("sub/inner.dat"), vec![0u8; 30_000]).unwrap();
    std::os::unix::fs::symlink(root.join("sub"), root.join("sublink")).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    assert_eq!(t.files, 2, "symlinks are not files");
    assert_eq!(t.symlinks, 2, "both symlinks tallied");
    let expected = alloc_of(&root.join("real.dat"))
        + alloc_of(&root.join("sub/inner.dat"))
        + alloc_of(&root.join("link"))
        + alloc_of(&root.join("sublink"));
    assert_eq!(t.size, expected, "targets counted once, links at own size");

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
    assert_eq!(t.size, one, "two links, one inode, counted once");
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
    let allocated = md.blocks() * 512;
    // Only meaningful if the filesystem actually made it sparse.
    if allocated >= md.len() {
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);
    assert_eq!(t.size, allocated, "allocated, not logical");
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
    fs::write(root.join("kept/k.dat"), vec![0u8; 40_000]).unwrap();
    fs::create_dir(root.join("aliased")).unwrap();
    fs::write(root.join("aliased/a.dat"), vec![0u8; 90_000]).unwrap();

    // Policy that treats <root>/aliased as a firmlink alias and filters on a
    // device set that matches nothing real -> "kept" must still be allowed
    // because we include the real device.
    let dev = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&root).unwrap().dev()
    };
    let policy = Arc::new(ScanPolicy::with_rules(
        std::collections::HashSet::from([dev]),
        vec![root.join("aliased")],
    ));
    let shared = Arc::new(ScanShared::new(1, root.clone()));
    walk(&shared, policy, noop_progress());
    finalize(&shared);

    let t = root_totals(&shared);
    assert_eq!(
        t.size,
        alloc_of(&root.join("kept/k.dat")),
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

#[test]
fn unreadable_scan_root_reports_error_not_panic() {
    let root = tmp_root("rootlock");
    fs::write(root.join("f.dat"), b"x").unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();

    let shared = scan_fixture(&root);
    let t = root_totals(&shared);

    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    let _ = fs::remove_dir_all(&root);

    assert_eq!(t.errors, 1, "root read failure is one visible error");
    assert_eq!(t.files, 0);
}

// ----- Synthetic-store tests (no filesystem) -------------------------------

fn synth_dir(shared: &ScanShared, path: &str, files: Vec<(&str, u64)>, children: Vec<&str>) {
    let p = PathBuf::from(path);
    let mut acc = DirAcc::new(name_of(&p));
    acc.own_size = files.iter().map(|(_, s)| *s).sum();
    acc.files = files
        .into_iter()
        .map(|(n, size)| FileRec {
            name: n.to_string(),
            size,
            is_symlink: false,
        })
        .collect();
    acc.children = children.into_iter().map(PathBuf::from).collect();
    shared.dirs.insert(p, Mutex::new(acc));
}

#[test]
fn node_budget_is_a_real_bound_on_dir_heavy_trees() {
    // 30k dirs with one file each — the shape (node_modules-like) that blew
    // the old MAX_TOTAL_NODES.
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    let child_names: Vec<String> = (0..30_000).map(|i| format!("/synthetic/d{}", i)).collect();
    let child_refs: Vec<&str> = child_names.iter().map(|s| s.as_str()).collect();
    synth_dir(&shared, "/synthetic", vec![], child_refs);
    for (i, name) in child_names.iter().enumerate() {
        // Varied sizes so ordering is deterministic.
        synth_dir(&shared, name, vec![("f.dat", 1_000 + i as u64)], vec![]);
    }
    finalize(&shared);

    let budget = 3000;
    let view = build_view(&shared, Path::new("/synthetic"), 4, budget).unwrap();
    let n = count_view_nodes(&view);
    // Budgeted nodes + at most one aggregate per expanded dir.
    assert!(
        n <= 2 * budget,
        "view must respect the node budget; got {n} nodes"
    );
    assert!(n >= 300, "view should not be trivially empty; got {n}");
    assert_sizes_consistent(&view);
    assert_eq!(view.size, root_totals(&shared).size, "no bytes lost");
}

#[test]
fn aggregate_matches_listing_exactly() {
    // One dir, 500 files with distinct sizes: the view rolls the tail into
    // an aggregate; the listing must reproduce exactly that tail.
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    let files: Vec<(String, u64)> = (1..=500)
        .map(|i| (format!("f{:03}.dat", i), i as u64 * 1_000))
        .collect();
    let file_refs: Vec<(&str, u64)> = files.iter().map(|(n, s)| (n.as_str(), *s)).collect();
    synth_dir(&shared, "/synthetic", file_refs, vec![]);
    finalize(&shared);

    let view = build_view(&shared, Path::new("/synthetic"), 2, 3000).unwrap();
    let agg = view
        .children
        .iter()
        .find(|c| c.aggregated)
        .expect("tail must be aggregated");
    let kept: std::collections::HashSet<&str> = view
        .children
        .iter()
        .filter(|c| !c.aggregated)
        .map(|c| c.name.as_str())
        .collect();

    let listing = list_dir(&shared, Path::new("/synthetic"), 0, 2000).unwrap();
    assert_eq!(listing.total, 500, "listing shows everything");
    let tail: Vec<_> = listing
        .entries
        .iter()
        .filter(|e| !kept.contains(e.name.as_str()))
        .collect();
    assert_eq!(tail.len() as u64, agg.aggregated_count, "same item count");
    assert_eq!(
        tail.iter().map(|e| e.size).sum::<u64>(),
        agg.size,
        "same bytes"
    );
    assert_sizes_consistent(&view);
}

#[test]
fn depth_cap_marks_hidden_children() {
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    synth_dir(&shared, "/synthetic", vec![], vec!["/synthetic/a"]);
    synth_dir(&shared, "/synthetic/a", vec![], vec!["/synthetic/a/b"]);
    synth_dir(&shared, "/synthetic/a/b", vec![("deep.dat", 5_000)], vec![]);
    finalize(&shared);

    let view = build_view(&shared, Path::new("/synthetic"), 2, 3000).unwrap();
    let a = &view.children[0];
    let b = &a.children[0];
    assert!(b.children.is_empty(), "depth-capped");
    assert!(b.has_hidden_children, "…and says so");
    assert_eq!(b.size, 5_000, "still sized honestly");
}

#[test]
fn stats_category_totals_are_complete() {
    // 120 distinct extensions -> by_extension truncates to 80 + remainder,
    // but by_category must still cover every byte.
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    let files: Vec<(String, u64)> = (0..120)
        .map(|i| (format!("f.e{:03}", i), 1_000 + i as u64))
        .chain([("movie.mp4".to_string(), 500_000u64)])
        .collect();
    let file_refs: Vec<(&str, u64)> = files.iter().map(|(n, s)| (n.as_str(), *s)).collect();
    synth_dir(&shared, "/synthetic", file_refs, vec![]);
    finalize(&shared);

    let stats = compute_stats(&shared);
    let total = root_totals(&shared).size;

    assert_eq!(stats.by_extension.len(), 80);
    let other = stats.ext_other.as_ref().expect("remainder present");
    assert_eq!(other.distinct, 41);
    let ext_sum: u64 = stats.by_extension.iter().map(|e| e.size).sum::<u64>() + other.size;
    assert_eq!(ext_sum, total, "extension rows + remainder = total");

    let cat_sum: u64 = stats.by_category.iter().map(|c| c.size).sum();
    assert_eq!(cat_sum, total, "category totals cover every byte");
    let video = stats
        .by_category
        .iter()
        .find(|c| c.category == "video")
        .unwrap();
    assert_eq!(video.size, 500_000);
    assert!(stats.by_category.iter().all(|c| c.size > 0));
}

#[test]
fn list_dir_pages_correctly() {
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    let files: Vec<(String, u64)> = (1..=25)
        .map(|i| (format!("f{:02}.dat", i), i as u64 * 100))
        .collect();
    let file_refs: Vec<(&str, u64)> = files.iter().map(|(n, s)| (n.as_str(), *s)).collect();
    synth_dir(&shared, "/synthetic", file_refs, vec![]);
    finalize(&shared);

    let page1 = list_dir(&shared, Path::new("/synthetic"), 0, 10).unwrap();
    let page3 = list_dir(&shared, Path::new("/synthetic"), 20, 10).unwrap();
    assert_eq!(page1.total, 25);
    assert_eq!(page1.entries.len(), 10);
    assert_eq!(page1.entries[0].name, "f25.dat", "sorted by size desc");
    assert_eq!(page3.entries.len(), 5);
    assert_eq!(page3.entries[4].name, "f01.dat");
    // Out-of-range offset is empty, not an error.
    let past = list_dir(&shared, Path::new("/synthetic"), 100, 10).unwrap();
    assert!(past.entries.is_empty());
}

#[test]
fn search_by_name_size_and_category() {
    let shared = ScanShared::new(1, PathBuf::from("/synthetic"));
    synth_dir(
        &shared,
        "/synthetic",
        vec![
            ("holiday.mp4", 3_000_000),
            ("holiday.jpg", 200_000),
            ("notes.txt", 1_000),
        ],
        vec!["/synthetic/holiday-pics"],
    );
    synth_dir(&shared, "/synthetic/holiday-pics", vec![("x.png", 50_000)], vec![]);
    finalize(&shared);

    let hits = search(
        &shared,
        &SearchQuery {
            text: "holiday".into(),
            min_size: 0,
            category: None,
            ext: None,
            limit: 10,
        },
    );
    assert_eq!(hits.len(), 3, "two files + one directory");
    assert!(hits[0].size >= hits[1].size, "ranked by size");
    assert!(hits.iter().any(|h| h.is_dir));

    let video_only = search(
        &shared,
        &SearchQuery {
            text: String::new(),
            min_size: 1_000_000,
            category: Some("video".into()),
            ext: None,
            limit: 10,
        },
    );
    assert_eq!(video_only.len(), 1);
    assert_eq!(video_only[0].name, "holiday.mp4");
}

#[test]
fn empty_directory_view_is_valid() {
    let root = tmp_root("empty");
    let shared = scan_fixture(&root);
    let view = build_view(&shared, &root, 4, 3000).unwrap();
    assert!(view.children.is_empty());
    assert!(!view.has_hidden_children);
    assert_eq!(view.size, 0);
    let _ = fs::remove_dir_all(&root);
}
