// Scanner tests over SYNTHETIC stores (no filesystem): view building,
// aggregation, listings, stats and search. The fixtures are hand-written
// `/`-separated paths, so this file is compiled on Unix only; the logic it
// covers has no OS-specific branches.

use super::*;

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

fn synth_dir(shared: &ScanShared, path: &str, files: Vec<(&str, u64)>, children: Vec<&str>) {
    let p = PathBuf::from(path);
    let mut acc = DirAcc::new(name_of(&p));
    acc.own_size = files.iter().map(|(_, s)| *s).sum();
    acc.files = files
        .into_iter()
        .map(|(n, size)| FileRec {
            name: n.to_string(),
            size,
            logical: size,
            ..Default::default()
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
    synth_dir(
        &shared,
        "/synthetic/holiday-pics",
        vec![("x.png", 50_000)],
        vec![],
    );
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
