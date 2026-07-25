// Dev-only harness: run the scanner against a real path and print the
// summary, for eyeballing correctness/perf against `du`. Not part of the app.
//
//   cargo run --release --example scan_summary -- [--reclaim] [--dups] <path>
//
// --reclaim appends the reclaimable-space report; --dups also runs the
// duplicate pass (reads file contents — still strictly read-only).

use diskaudit_lib::devtool;

fn main() {
    let mut show_reclaim = false;
    let mut run_dups = false;
    let mut path = ".".to_string();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--reclaim" => show_reclaim = true,
            "--dups" => {
                show_reclaim = true;
                run_dups = true;
            }
            other => path = other.to_string(),
        }
    }
    devtool::scan_and_report(&path, show_reclaim, run_dups);
}
