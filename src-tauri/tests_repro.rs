// TEMPORARY defect-reproduction tests against the BASELINE scanner.
// Appended to scanner.rs as `mod tests_repro` via include!. Each test asserts
// the CURRENT (buggy) behavior so we have evidence the defect is real before
// fixing it. These get replaced by real tests asserting the fixed behavior.

#[cfg(test)]
mod tests_repro {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn noop_progress() -> ScanProgress {
        ScanProgress {
            files: Arc::new(AtomicU64::new(0)),
            dirs: Arc::new(AtomicU64::new(0)),
            bytes: Arc::new(AtomicU64::new(0)),
            errors: Arc::new(AtomicU64::new(0)),
            last_emit_ms: Arc::new(AtomicU64::new(u64::MAX / 2)), // suppress emits
            on_tick: Arc::new(|_, _, _, _, _| {}),
        }
    }

    fn tmp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("diskaudit-repro-{}", name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn dir_node(path: &str, children: Vec<TreeNode>) -> TreeNode {
        let size = children.iter().map(|c| c.size).sum();
        TreeNode {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            size,
            is_dir: true,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            aggregated: false,
            aggregated_count: 0,
            aggregated_parent: None,
            external: false,
            children,
        }
    }

    fn file_node(path: &str, size: u64) -> TreeNode {
        TreeNode {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.to_string(),
            size,
            is_dir: false,
            file_count: 0,
            dir_count: 0,
            error_count: 0,
            aggregated: false,
            aggregated_count: 1,
            aggregated_parent: None,
            external: false,
            children: Vec::new(),
        }
    }

    // DEFECT: prune_to_budget only removes files, never directories, so
    // MAX_TOTAL_NODES is not a real bound on directory-heavy trees.
    #[test]
    fn repro_budget_not_enforced_on_dir_heavy_tree() {
        // 30_000 dirs, one 1-byte file each -> 60_001 nodes.
        let mut dirs = Vec::with_capacity(30_000);
        for i in 0..30_000 {
            let p = format!("/r/d{}", i);
            dirs.push(dir_node(&p, vec![file_node(&format!("{}/f", p), 1)]));
        }
        let mut root = dir_node("/r", dirs);
        let total = root.size;
        prune_to_budget(&mut root, total);
        let n = count_nodes(&root);
        println!("node count after prune: {} (budget {})", n, MAX_TOTAL_NODES);
        assert!(
            n > MAX_TOTAL_NODES,
            "expected budget violation to reproduce; got {} nodes",
            n
        );
    }

    // DEFECT: expand_aggregate floor derived from files-only total while
    // prune_tree used the full dir size (files + subdirs) -> expanded set
    // does not match the rollup the user clicked.
    #[test]
    fn repro_aggregate_expansion_mismatch() {
        // Parent: 900 MB subdir + files: one 2 MB file and 40 files of 300 KB.
        // prune floor = max(0.1% of ~914MB, 64K, global) ≈ 914KB -> the 300KB
        // files roll up (40 files). expand_aggregate recomputes the floor from
        // files-only total (~14MB -> floor 64KB) -> 300KB files DON'T qualify,
        // so the expansion shows a different set than was rolled up.
        let sub = dir_node("/p/sub", vec![file_node("/p/sub/big", 900_000_000)]);
        let mut files: Vec<(String, u64)> = vec![("big2.dat".to_string(), 2_000_000)];
        let mut children = vec![sub, file_node("/p/big2.dat", 2_000_000)];
        for i in 0..40 {
            let name = format!("small{}.dat", i);
            files.push((name.clone(), 300_000));
            children.push(file_node(&format!("/p/{}", name), 300_000));
        }
        let mut parent = dir_node("/p", children);
        let total_bytes = parent.size;
        prune_tree(&mut parent, global_floor_for(total_bytes));

        let rollup = parent
            .children
            .iter()
            .find(|c| c.aggregated)
            .expect("prune should have produced a rollup node");
        let rolled_count = rollup.aggregated_count;
        let rolled_size = rollup.size;

        // Now expand the way lib.rs::expand_aggregate does: files-only total.
        let files_total: u64 = files.iter().map(|(_, s)| s).sum();
        let expanded = expand_aggregate(
            Path::new("/p"),
            &files,
            files_total,
            global_floor_for(total_bytes),
        );
        println!(
            "rolled: count={} size={} | expanded: count={} size={}",
            rolled_count, rolled_size, expanded.aggregated_count, expanded.size
        );
        assert_ne!(
            (rolled_count, rolled_size),
            (expanded.aggregated_count, expanded.size),
            "expected mismatch to reproduce"
        );
    }

    // DEFECT: permission errors counted twice (process_read_dir local_errors
    // + outer walker loop).
    #[test]
    fn repro_permission_error_counting() {
        let root = tmp_root("perm");
        let locked = root.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("hidden.dat"), vec![0u8; 1000]).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let progress = noop_progress();
        let out = scan(&root, progress, ScanCancelToken::new()).unwrap();

        // restore so cleanup works
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&root);

        println!("permission_errors reported: {}", out.permission_errors);
        // One unreadable dir. Anything >1 means double counting.
        assert!(out.permission_errors != 1, "expected miscount to reproduce; got 1");
    }

    // DEFECT: file_count / dir_count are direct children only, presented as
    // recursive "Contains" in the UI.
    #[test]
    fn repro_counts_are_direct_children_only() {
        let root = tmp_root("counts");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/f1"), b"x").unwrap();
        fs::write(root.join("a/b/f2"), b"y").unwrap();

        let out = scan(&root, noop_progress(), ScanCancelToken::new()).unwrap();
        let _ = fs::remove_dir_all(&root);

        let rn = &out.root;
        println!(
            "root: file_count={} dir_count={} (recursive would be 2 files, 2 dirs)",
            rn.file_count, rn.dir_count
        );
        assert_eq!(rn.file_count, 0, "root has no direct files");
        assert_eq!(rn.dir_count, 1, "root sees only direct child dir");
    }

    // DEFECT: symlinks skipped silently — not counted anywhere.
    #[test]
    fn repro_symlinks_invisible() {
        let root = tmp_root("symlink");
        fs::write(root.join("real.dat"), vec![0u8; 5000]).unwrap();
        std::os::unix::fs::symlink(root.join("real.dat"), root.join("link")).unwrap();

        let out = scan(&root, noop_progress(), ScanCancelToken::new()).unwrap();
        let _ = fs::remove_dir_all(&root);

        println!("total_files={} (symlink not represented anywhere)", out.total_files);
        assert_eq!(out.total_files, 1);
    }

    // DEFECT: md.len() logical size — a sparse file counts at its logical
    // size even though it occupies ~0 blocks on disk.
    #[test]
    fn repro_sparse_file_counted_logical() {
        let root = tmp_root("sparse");
        let p = root.join("sparse.bin");
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut f = fs::File::create(&p).unwrap();
            f.seek(SeekFrom::Start(50_000_000)).unwrap(); // 50 MB hole
            f.write_all(b"end").unwrap();
        }
        let md = fs::metadata(&p).unwrap();
        let allocated = md.blocks() * 512;
        let out = scan(&root, noop_progress(), ScanCancelToken::new()).unwrap();
        let _ = fs::remove_dir_all(&root);

        println!(
            "logical={} allocated={} scan_total={}",
            md.len(),
            allocated,
            out.total_bytes
        );
        assert_eq!(out.total_bytes, md.len(), "scan uses logical size");
        assert!(allocated < md.len() / 2, "sparse file allocates far less");
    }

    // DEFECT: hardlinked files double-counted (no inode dedup).
    #[test]
    fn repro_hardlinks_double_counted() {
        let root = tmp_root("hardlink");
        fs::write(root.join("orig.dat"), vec![0u8; 100_000]).unwrap();
        fs::hard_link(root.join("orig.dat"), root.join("copy.dat")).unwrap();

        let out = scan(&root, noop_progress(), ScanCancelToken::new()).unwrap();
        let _ = fs::remove_dir_all(&root);

        println!("total_bytes={} (one 100KB inode, two links)", out.total_bytes);
        assert_eq!(out.total_bytes, 200_000, "expected double count to reproduce");
    }
}
