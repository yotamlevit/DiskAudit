// Reclaim detection + duplicate pipeline tests. Synthetic stores exercise
// the path-matching rules and the cross-category accounting; real tempdir
// fixtures (the test-only filesystem-write carve-out, see lib.rs) exercise
// the hashing pipeline against actual duplicates, hardlinks, and a clone.

use super::*;
use crate::scanner::{DirAcc, FileRec, ScanShared};
use parking_lot::Mutex;
use std::fs;
use std::sync::Arc;

const NOW: i64 = 1_700_000_000;
const OLD: i64 = NOW - 400 * DAY_SECS; // > 1 year ago
const RECENT: i64 = NOW - 5 * DAY_SECS;

// ----- Synthetic-store helpers ---------------------------------------------

fn synth(shared: &ScanShared, path: &str, files: Vec<FileRec>, children: Vec<&str>) {
    let p = PathBuf::from(path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let mut acc = DirAcc::new(name);
    acc.own_size = files.iter().map(|f| f.size).sum();
    acc.files = files;
    acc.children = children.into_iter().map(PathBuf::from).collect();
    shared.dirs.insert(p, Mutex::new(acc));
}

fn file(name: &str, size: u64, mtime: i64) -> FileRec {
    FileRec {
        name: name.to_string(),
        size,
        logical: size,
        mtime,
        ..Default::default()
    }
}

fn store(root: &str) -> ScanShared {
    ScanShared::new(1, PathBuf::from(root))
}

fn report(shared: &ScanShared) -> ReclaimReport {
    crate::scanner::finalize(shared);
    build_report_at(shared, NOW)
}

fn group<'a>(r: &'a ReclaimReport, kind: &str) -> Option<&'a ReclaimGroup> {
    r.groups.iter().find(|g| g.kind == kind)
}

fn paths_of(g: &ReclaimGroup) -> Vec<&str> {
    g.items.iter().map(|i| i.path.as_str()).collect()
}

// ----- Cache / well-known detection ----------------------------------------

#[test]
fn library_caches_children_are_flagged_per_app() {
    let shared = store("/Users/alice");
    synth(
        &shared,
        "/Users/alice",
        vec![],
        vec!["/Users/alice/Library"],
    );
    synth(
        &shared,
        "/Users/alice/Library",
        vec![],
        vec!["/Users/alice/Library/Caches"],
    );
    synth(
        &shared,
        "/Users/alice/Library/Caches",
        vec![],
        vec![
            "/Users/alice/Library/Caches/com.apple.Safari",
            "/Users/alice/Library/Caches/tiny",
        ],
    );
    synth(
        &shared,
        "/Users/alice/Library/Caches/com.apple.Safari",
        vec![file("c.db", 200_000_000, RECENT)],
        vec![],
    );
    synth(
        &shared,
        "/Users/alice/Library/Caches/tiny",
        vec![file("t.db", 1_000, RECENT)],
        vec![],
    );

    let r = report(&shared);
    let g = group(&r, "app_cache").expect("app cache group");
    assert_eq!(
        paths_of(g),
        vec!["/Users/alice/Library/Caches/com.apple.Safari"],
        "per-app children flagged; sub-floor ones dropped"
    );
    assert_eq!(g.total, 200_000_000);
    assert_eq!(g.class, ReclaimClass::Regenerable);
    assert_eq!(g.confidence, Confidence::Safe);
    assert_eq!(r.total, 200_000_000);
}

#[test]
fn near_miss_cache_paths_are_not_flagged() {
    // Same shapes, wrong base: a project folder that mimics the layout.
    let shared = store("/Users/alice");
    synth(
        &shared,
        "/Users/alice",
        vec![],
        vec!["/Users/alice/project"],
    );
    synth(
        &shared,
        "/Users/alice/project",
        vec![],
        vec![
            "/Users/alice/project/Library",
            "/Users/alice/project/Downloads",
        ],
    );
    synth(
        &shared,
        "/Users/alice/project/Library",
        vec![],
        vec!["/Users/alice/project/Library/Caches"],
    );
    synth(
        &shared,
        "/Users/alice/project/Library/Caches",
        vec![],
        vec!["/Users/alice/project/Library/Caches/huge"],
    );
    synth(
        &shared,
        "/Users/alice/project/Library/Caches/huge",
        vec![file("data.bin", 900_000_000, RECENT)],
        vec![],
    );
    synth(
        &shared,
        "/Users/alice/project/Downloads",
        vec![file("app.dmg", 900_000_000, OLD)],
        vec![],
    );

    let r = report(&shared);
    assert!(group(&r, "app_cache").is_none(), "fake Library/Caches");
    assert!(group(&r, "installer").is_none(), "fake Downloads");
    // The old dmg in the FAKE Downloads still legitimately qualifies as a
    // stale large file — right class, low confidence — but never as a
    // confidently-deletable installer.
    let stale = group(&r, "stale").expect("stale hint remains");
    assert_eq!(
        paths_of(stale),
        vec!["/Users/alice/project/Downloads/app.dmg"]
    );
    assert_eq!(r.total, 900_000_000);
}

// ----- Build artifacts (markers and near-misses) ---------------------------

#[test]
fn artifact_dirs_need_their_markers() {
    let shared = store("/Users/alice/code");
    synth(
        &shared,
        "/Users/alice/code",
        vec![],
        vec![
            "/Users/alice/code/rustproj",
            "/Users/alice/code/notrust",
            "/Users/alice/code/webapp",
            "/Users/alice/code/pyproj",
        ],
    );
    // target WITH sibling Cargo.toml → flagged.
    synth(
        &shared,
        "/Users/alice/code/rustproj",
        vec![file("Cargo.toml", 500, RECENT)],
        vec!["/Users/alice/code/rustproj/target"],
    );
    synth(
        &shared,
        "/Users/alice/code/rustproj/target",
        vec![file("bin", 50_000_000, RECENT)],
        vec![],
    );
    // target WITHOUT Cargo.toml → someone's real folder named target.
    synth(
        &shared,
        "/Users/alice/code/notrust",
        vec![],
        vec!["/Users/alice/code/notrust/target"],
    );
    synth(
        &shared,
        "/Users/alice/code/notrust/target",
        vec![file("thesis.pdf", 60_000_000, RECENT)],
        vec![],
    );
    // node_modules → always.
    synth(
        &shared,
        "/Users/alice/code/webapp",
        vec![],
        vec!["/Users/alice/code/webapp/node_modules"],
    );
    synth(
        &shared,
        "/Users/alice/code/webapp/node_modules",
        vec![file("blob.js", 80_000_000, RECENT)],
        vec![],
    );
    // venv WITHOUT pyvenv.cfg → not flagged.
    synth(
        &shared,
        "/Users/alice/code/pyproj",
        vec![],
        vec!["/Users/alice/code/pyproj/venv"],
    );
    synth(
        &shared,
        "/Users/alice/code/pyproj/venv",
        vec![file("photos.zip", 70_000_000, RECENT)],
        vec![],
    );

    let r = report(&shared);
    let g = group(&r, "build_artifact").expect("artifacts");
    let mut got = paths_of(g);
    got.sort();
    assert_eq!(
        got,
        vec![
            "/Users/alice/code/rustproj/target",
            "/Users/alice/code/webapp/node_modules",
        ]
    );
    assert_eq!(g.total, 130_000_000);
}

#[test]
fn nested_findings_collapse_to_the_outermost() {
    // node_modules containing another node_modules and a target with
    // Cargo.toml: one finding, counted once.
    let shared = store("/r");
    synth(&shared, "/r", vec![], vec!["/r/node_modules"]);
    synth(
        &shared,
        "/r/node_modules",
        vec![file("a.js", 30_000_000, RECENT)],
        vec!["/r/node_modules/dep"],
    );
    synth(
        &shared,
        "/r/node_modules/dep",
        vec![file("Cargo.toml", 100, RECENT)],
        vec![
            "/r/node_modules/dep/node_modules",
            "/r/node_modules/dep/target",
        ],
    );
    synth(
        &shared,
        "/r/node_modules/dep/node_modules",
        vec![file("b.js", 20_000_000, RECENT)],
        vec![],
    );
    synth(
        &shared,
        "/r/node_modules/dep/target",
        vec![file("c.bin", 25_000_000, RECENT)],
        vec![],
    );

    let r = report(&shared);
    let g = group(&r, "build_artifact").expect("artifacts");
    assert_eq!(paths_of(g), vec!["/r/node_modules"]);
    // 30 MB + 20 MB + 25 MB + the 100-byte Cargo.toml, counted once.
    assert_eq!(g.total, 75_000_100, "whole subtree, counted once");
    assert_eq!(r.total, 75_000_100);
}

// ----- Trash / installers / stale ------------------------------------------

#[test]
fn trash_installers_and_stale_rules() {
    let shared = store("/Users/alice");
    synth(
        &shared,
        "/Users/alice",
        vec![file("old-raw-footage.mov", 900_000_000, OLD)],
        vec![
            "/Users/alice/.Trash",
            "/Users/alice/Downloads",
            "/Users/alice/Photos.photoslibrary",
        ],
    );
    synth(
        &shared,
        "/Users/alice/.Trash",
        vec![file("junk.zip", 5_000_000, RECENT)],
        vec![],
    );
    synth(
        &shared,
        "/Users/alice/Downloads",
        vec![
            file("old-installer.dmg", 300_000_000, OLD),
            file("fresh-installer.dmg", 300_000_000, RECENT), // too new
            file("old-video.mp4", 800_000_000, OLD),          // not an installer → stale
            file("tiny.pkg", 1_000_000, OLD),                 // under floor
        ],
        vec![],
    );
    // Big old file inside a package-like dir: NOT stale-flagged.
    synth(
        &shared,
        "/Users/alice/Photos.photoslibrary",
        vec![file("masters.db", 2_000_000_000, OLD)],
        vec![],
    );

    let r = report(&shared);
    let trash = group(&r, "trash").expect("trash");
    assert_eq!(paths_of(trash), vec!["/Users/alice/.Trash"]);
    assert_eq!(trash.class, ReclaimClass::Disposable);

    let inst = group(&r, "installer").expect("installers");
    assert_eq!(
        paths_of(inst),
        vec!["/Users/alice/Downloads/old-installer.dmg"],
        "only old, large installers"
    );

    let stale = group(&r, "stale").expect("stale");
    let mut got = paths_of(stale);
    got.sort();
    assert_eq!(
        got,
        vec![
            "/Users/alice/Downloads/old-video.mp4",
            "/Users/alice/old-raw-footage.mov",
        ],
        "old+big files, but never inside package-like dirs"
    );
    assert_eq!(stale.confidence, Confidence::Hint);

    assert_eq!(
        r.total,
        5_000_000 + 300_000_000 + 800_000_000 + 900_000_000,
        "union of all findings, no double counting"
    );
}

#[test]
fn stale_never_flags_under_library_or_unknown_mtime() {
    let shared = store("/Users/alice");
    synth(
        &shared,
        "/Users/alice",
        vec![file("no-mtime.bin", 900_000_000, 0)],
        vec!["/Users/alice/Library"],
    );
    synth(
        &shared,
        "/Users/alice/Library",
        vec![file("appdata.db", 900_000_000, OLD)],
        vec![],
    );
    let r = report(&shared);
    assert!(group(&r, "stale").is_none());
}

#[test]
fn findings_containing_skipped_territory_are_dropped() {
    use crate::platform::SkipReason;
    let shared = store("/Users/alice");
    synth(
        &shared,
        "/Users/alice",
        vec![],
        vec!["/Users/alice/node_modules"],
    );
    synth(
        &shared,
        "/Users/alice/node_modules",
        vec![file("a.js", 50_000_000, RECENT)],
        vec!["/Users/alice/node_modules/mount"],
    );
    shared.dirs.insert(
        PathBuf::from("/Users/alice/node_modules/mount"),
        Mutex::new(DirAcc::skipped("mount".into(), SkipReason::OtherVolume)),
    );
    let r = report(&shared);
    assert!(
        group(&r, "build_artifact").is_none(),
        "a finding containing a live mount point must not be offered"
    );
}

// ----- Duplicate accounting over synthetic results -------------------------

fn dup_group(files: Vec<(&str, u64, i64)>) -> VerifiedGroup {
    VerifiedGroup {
        logical: files.first().map(|f| f.1).unwrap_or(0),
        files: files
            .into_iter()
            .map(|(p, alloc, mtime)| DupFile {
                path: PathBuf::from(p),
                alloc,
                mtime,
            })
            .collect(),
    }
}

#[test]
fn duplicate_accounting_keeps_one_copy() {
    let shared = store("/r");
    synth(&shared, "/r", vec![], vec![]);
    {
        let mut d = shared.dup.lock();
        d.status = DupStatus::Done;
        d.groups = vec![dup_group(vec![
            ("/r/a/photo.jpg", 10_000_000, 100), // oldest → kept
            ("/r/b/photo.jpg", 10_000_000, 200),
            ("/r/c/photo copy.jpg", 10_000_000, 300),
        ])];
    }
    let r = report(&shared);
    assert_eq!(r.dup.group_count, 1);
    let g = &r.dup.groups[0];
    assert_eq!(
        g.reclaimable, 20_000_000,
        "group total minus the kept copy — never the whole group"
    );
    let kept: Vec<_> = g.copies.iter().filter(|c| c.keep).collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].path, "/r/a/photo.jpg", "oldest copy kept");
    assert_eq!(r.total, 20_000_000);
    assert_eq!(r.dup.status, "done");
}

#[test]
fn duplicate_copies_inside_other_findings_do_not_double_count() {
    // Copy inside node_modules is already counted by the artifact finding.
    let shared = store("/r");
    synth(&shared, "/r", vec![], vec!["/r/node_modules"]);
    synth(
        &shared,
        "/r/node_modules",
        vec![file("big.bin", 50_000_000, RECENT)],
        vec![],
    );
    {
        let mut d = shared.dup.lock();
        d.status = DupStatus::Done;
        d.groups = vec![
            dup_group(vec![
                ("/r/node_modules/big.bin", 50_000_000, 100),
                ("/r/keep.bin", 50_000_000, 200),
                ("/r/extra.bin", 50_000_000, 300),
            ]),
            // Both copies inside the finding: nothing extra to reclaim.
            dup_group(vec![
                ("/r/node_modules/x.bin", 30_000_000, 100),
                ("/r/node_modules/y.bin", 30_000_000, 200),
            ]),
        ];
    }
    let r = report(&shared);
    assert_eq!(r.dup.group_count, 1, "all-inside group dropped");
    let g = &r.dup.groups[0];
    assert_eq!(
        g.reclaimable, 50_000_000,
        "only the free extra copy counts (in-finding copy excluded, one kept)"
    );
    let flagged: Vec<_> = g.copies.iter().filter(|c| c.in_finding).collect();
    assert_eq!(flagged.len(), 1);
    assert!(!flagged[0].keep);
    assert_eq!(
        r.total,
        50_000_000 + 50_000_000,
        "node_modules once + one dup copy once"
    );
}

#[test]
fn stale_file_in_a_dup_group_counts_once_as_duplicate() {
    let shared = store("/r");
    synth(
        &shared,
        "/r",
        vec![
            file("old-a.bin", 900_000_000, OLD),
            file("old-b.bin", 900_000_000, OLD),
        ],
        vec![],
    );
    {
        let mut d = shared.dup.lock();
        d.status = DupStatus::Done;
        d.groups = vec![dup_group(vec![
            ("/r/old-a.bin", 900_000_000, OLD),
            ("/r/old-b.bin", 900_000_000, OLD),
        ])];
    }
    let r = report(&shared);
    assert!(
        group(&r, "stale").is_none(),
        "dup members leave the stale group"
    );
    assert_eq!(r.dup.reclaimable, 900_000_000);
    assert_eq!(r.total, 900_000_000, "counted exactly once");
}

// ----- The real pipeline against a real fixture tree -----------------------

fn tmp_root(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("diskaudit-reclaim-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn scan_fixture(root: &Path) -> Arc<ScanShared> {
    let shared = Arc::new(ScanShared::new(1, root.to_path_buf()));
    let policy = Arc::new(crate::platform::ScanPolicy::for_root(root));
    crate::scanner::walk(&shared, policy, Arc::new(|_, _, _, _, _| {}));
    crate::scanner::finalize(&shared);
    shared
}

fn run_pipeline(shared: &Arc<ScanShared>) {
    assert!(try_begin_dup_scan(shared));
    run_dup_scan(shared, Arc::new(|_, _, _, _| {}));
}

#[test]
fn pipeline_finds_real_duplicates_and_ignores_hardlinks() {
    let root = tmp_root("dups");
    let a: Vec<u8> = (0..2_000_000u32).map(|i| (i % 251) as u8).collect();
    let b: Vec<u8> = (0..2_000_000u32).map(|i| (i % 249) as u8).collect();
    // Same size as `a`, differs ONLY in the middle: survives the head+tail
    // sample stage and must be separated by the full hash.
    let mut a_mid = a.clone();
    a_mid[1_000_000] ^= 0xff;

    fs::create_dir_all(root.join("x")).unwrap();
    fs::create_dir_all(root.join("y")).unwrap();
    fs::write(root.join("x/orig.dat"), &a).unwrap();
    fs::write(root.join("y/copy.dat"), &a).unwrap();
    fs::write(root.join("y/similar.dat"), &a_mid).unwrap();
    fs::write(root.join("x/other.dat"), &b).unwrap();
    // Hardlinked pair: same inode, must NOT appear as a duplicate group.
    fs::write(root.join("x/linked.dat"), &b).unwrap();
    fs::hard_link(root.join("x/linked.dat"), root.join("y/linked2.dat")).unwrap();

    let shared = scan_fixture(&root);
    run_pipeline(&shared);

    let d = shared.dup.lock();
    assert_eq!(d.status, DupStatus::Done);
    assert_eq!(
        d.groups.len(),
        1,
        "exactly one verified group (orig+copy); hardlinks and the \
         middle-differing file are excluded"
    );
    let g = &d.groups[0];
    assert_eq!(g.logical, 2_000_000);
    let mut names: Vec<String> = g
        .files
        .iter()
        .map(|f| f.path.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["copy.dat", "orig.dat"]);
    assert!(d.bytes_read > 0, "the pass reports its real I/O");
    drop(d);

    // Keep-one accounting against the real fixture.
    let r = build_report_at(&shared, NOW);
    assert_eq!(r.dup.group_count, 1);
    let alloc_one = fs::metadata(root.join("y/copy.dat")).unwrap().len();
    // Allocated ≥ logical here (non-sparse); reclaimable = exactly one copy.
    assert!(r.dup.groups[0].reclaimable >= alloc_one.min(2_000_000));
    assert_eq!(
        r.dup.groups[0].copies.iter().filter(|c| c.keep).count(),
        1,
        "exactly one kept copy, excluded from the number"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn pipeline_treats_apfs_clones_as_copies_documented_limitation() {
    // `cp -c` (clonefile) shares extents: deleting one copy frees almost
    // nothing, but user space cannot detect that. The pipeline SHOULD report
    // it as a duplicate — this test pins the documented limitation (and
    // quietly passes where cloning isn't supported).
    let root = tmp_root("clone");
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 253) as u8).collect();
    fs::write(root.join("orig.dat"), &data).unwrap();
    let status = std::process::Command::new("/bin/cp")
        .arg("-c")
        .arg(root.join("orig.dat"))
        .arg(root.join("clone.dat"))
        .status();
    let cloned = matches!(status, Ok(s) if s.success());
    if !cloned {
        let _ = fs::remove_dir_all(&root);
        return;
    }

    let shared = scan_fixture(&root);
    run_pipeline(&shared);
    let d = shared.dup.lock();
    assert_eq!(
        d.groups.len(),
        1,
        "clones are indistinguishable from real copies to user space"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn pipeline_cancellation_is_clean() {
    let root = tmp_root("cancel");
    let data = vec![7u8; 1_500_000];
    fs::write(root.join("a.dat"), &data).unwrap();
    fs::write(root.join("b.dat"), &data).unwrap();
    let shared = scan_fixture(&root);
    assert!(try_begin_dup_scan(&shared));
    cancel_dup_scan(&shared); // cancelled before it starts: hardest case
    run_dup_scan(&shared, Arc::new(|_, _, _, _| {}));
    let d = shared.dup.lock();
    assert_eq!(d.status, DupStatus::Cancelled);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn small_files_are_never_read() {
    let root = tmp_root("small");
    fs::write(root.join("a.txt"), b"same tiny content").unwrap();
    fs::write(root.join("b.txt"), b"same tiny content").unwrap();
    let shared = scan_fixture(&root);
    run_pipeline(&shared);
    let d = shared.dup.lock();
    assert_eq!(d.status, DupStatus::Done);
    assert!(d.groups.is_empty(), "under the 1 MB candidate floor");
    assert_eq!(d.bytes_read, 0, "no I/O for files below the floor");
    let _ = fs::remove_dir_all(&root);
}
