// Dev-only helper backing examples/scan_summary.rs: scan a real path and
// print totals for comparison with `du`. Read-only like everything else.

use crate::platform::ScanPolicy;
use crate::reclaim;
use crate::scanner;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

pub fn scan_and_print(path: &str) {
    scan_and_report(path, false, false);
}

/// Like scan_and_print, optionally appending the reclaimable-space report
/// (and, on request, the duplicate pass — reads file contents, still
/// read-only).
pub fn scan_and_report(path: &str, show_reclaim: bool, run_dups: bool) {
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

    if !show_reclaim {
        return;
    }
    if run_dups {
        eprintln!("running duplicate pass (reads file contents, read-only)…");
        let dup_started = Instant::now();
        assert!(reclaim::try_begin_dup_scan(&shared));
        reclaim::run_dup_scan(
            &shared,
            Arc::new(|phase, done, total, bytes| {
                eprint!(
                    "\r  {phase}: {done}/{total}  ({:.2} GB read)   ",
                    bytes as f64 / 1e9
                );
            }),
        );
        eprintln!("\n  duplicate pass took {:?}", dup_started.elapsed());
    }
    let report = reclaim::build_report(&shared);
    println!();
    println!("== Reclaimable ==");
    println!(
        "headline:        {} bytes ({:.2} GB) — deduplicated union",
        report.total,
        report.total as f64 / 1e9
    );
    for g in &report.groups {
        println!(
            "  [{:?}/{:?}] {:24} {:>10.2} MB  {} items",
            g.class,
            g.confidence,
            g.label,
            g.total as f64 / 1e6,
            g.count
        );
        for item in g.items.iter().take(8) {
            println!(
                "      {:>10.2} MB  {}  — {}",
                item.size as f64 / 1e6,
                item.path,
                item.reason
            );
        }
        if g.items.len() > 8 {
            println!("      … {} more", g.items.len() - 8);
        }
    }
    println!(
        "  duplicates: status={} groups={} reclaimable={:.2} MB bytes_read={:.2} MB errors={}",
        report.dup.status,
        report.dup.group_count,
        report.dup.reclaimable as f64 / 1e6,
        report.dup.bytes_read as f64 / 1e6,
        report.dup.errors,
    );
    for g in report.dup.groups.iter().take(10) {
        println!(
            "      {:>10.2} MB reclaimable — {} ({} copies)",
            g.reclaimable as f64 / 1e6,
            g.name,
            g.copies.len()
        );
        for c in &g.copies {
            let tag = if c.keep {
                " [kept]"
            } else if c.in_finding {
                " [inside another finding]"
            } else {
                ""
            };
            println!("          {}{}", c.path, tag);
        }
    }
}

fn count_nodes(n: &scanner::ViewNode) -> usize {
    1 + n.children.iter().map(count_nodes).sum::<usize>()
}
