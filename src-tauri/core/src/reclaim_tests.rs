// Duplicate-pipeline tests against REAL fixture trees (the test-only
// filesystem-write carve-out, see ../../src/lib.rs): actual duplicates,
// hardlinks, and an APFS clone. These run on every OS.

use super::*;
use crate::scanner::ScanShared;
use std::fs;
use std::sync::Arc;

const NOW: i64 = 1_700_000_000;

fn tmp_root(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("diskaudit-reclaim-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    crate::platform::resolve_root(&d)
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
    fs::write(root.join("x").join("orig.dat"), &a).unwrap();
    fs::write(root.join("y").join("copy.dat"), &a).unwrap();
    fs::write(root.join("y").join("similar.dat"), &a_mid).unwrap();
    fs::write(root.join("x").join("other.dat"), &b).unwrap();
    // Hardlinked pair: same inode, must NOT appear as a duplicate group.
    fs::write(root.join("x").join("linked.dat"), &b).unwrap();
    fs::hard_link(
        root.join("x").join("linked.dat"),
        root.join("y").join("linked2.dat"),
    )
    .unwrap();

    let shared = scan_fixture(&root);
    run_pipeline(&shared);

    let d = shared.dup.lock();
    assert_eq!(d.status, DupStatus::Done);
    assert_eq!(
        d.groups.len(),
        1,
        "exactly one verified group (orig+copy); hardlinks and the \
         middle-differing file are excluded (errors {}, hashed {}, read {}, store {:?})",
        d.errors,
        d.files_hashed,
        d.bytes_read,
        shared
            .dirs
            .iter()
            .flat_map(|kv| {
                kv.value()
                    .lock()
                    .files
                    .iter()
                    .map(|f| (f.name.clone(), f.size, f.logical, f.hardlinked))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
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
    let alloc_one = fs::metadata(root.join("y").join("copy.dat")).unwrap().len();
    // Allocated ≥ logical here (non-sparse); reclaimable = exactly one copy.
    assert!(r.dup.groups[0].reclaimable >= alloc_one.min(2_000_000));
    assert_eq!(
        r.dup.groups[0].copies.iter().filter(|c| c.keep).count(),
        1,
        "exactly one kept copy, excluded from the number"
    );
    let _ = fs::remove_dir_all(&root);
}

#[cfg(target_os = "macos")]
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
