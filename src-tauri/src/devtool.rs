// Dev-only helper backing examples/scan_summary.rs: scan a real path and
// print totals for comparison with `du`. Read-only like everything else.

use crate::platform::ScanPolicy;
use crate::scanner;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

pub fn scan_and_print(path: &str) {
    let root = PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    let shared = Arc::new(scanner::ScanShared::new(1, root.clone()));
    let policy = Arc::new(ScanPolicy::for_root(&root));

    let started = Instant::now();
    scanner::walk(
        &shared,
        policy,
        Arc::new(|files, _dirs, bytes, _errors, _cur| {
            eprint!("\r{} files, {:.1} GB   ", files, bytes as f64 / 1e9);
        }),
    );
    let walk_t = started.elapsed();
    let fin_started = Instant::now();
    scanner::finalize(&shared);
    let fin_t = fin_started.elapsed();
    let stats = scanner::compute_stats(&shared);
    let (skipped, skipped_total) = scanner::collect_skipped(&shared);
    let t = scanner::root_totals(&shared);
    let c = &shared.counters;

    eprintln!();
    println!("root:            {}", root.display());
    println!("walk time:       {:?}", walk_t);
    println!("finalize time:   {:?}", fin_t);
    println!(
        "allocated:       {} bytes ({:.2} GB)  [du -sk equiv: {} KB]",
        t.size,
        t.size as f64 / 1e9,
        t.size / 1024
    );
    println!(
        "logical:         {} bytes ({:.2} GB)",
        c.logical_bytes.load(Ordering::Relaxed),
        c.logical_bytes.load(Ordering::Relaxed) as f64 / 1e9
    );
    println!(
        "hardlink saved:  {} bytes",
        c.hardlink_saved.load(Ordering::Relaxed)
    );
    println!("files:           {}", t.files);
    println!("dirs:            {}", t.dirs);
    println!("symlinks:        {}", t.symlinks);
    println!("errors:          {}", t.errors);
    println!("skipped:         {} dirs", skipped_total);
    for s in skipped.iter().take(10) {
        println!("   [{:?}] {}", s.reason, s.path);
    }
    println!("top categories:");
    for cat in stats.by_category.iter().take(5) {
        println!(
            "   {:12} {:>10.2} MB  {} files",
            cat.category,
            cat.size as f64 / 1e6,
            cat.count
        );
    }

    let view_started = Instant::now();
    let view = scanner::build_view(&shared, &root, 4, 3000);
    match view {
        Ok(v) => println!(
            "view:            {} nodes in {:?}",
            count_nodes(&v),
            view_started.elapsed()
        ),
        Err(e) => println!("view error: {e}"),
    }
}

fn count_nodes(n: &scanner::ViewNode) -> usize {
    1 + n.children.iter().map(count_nodes).sum::<usize>()
}
