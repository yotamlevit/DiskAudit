// Dev-only harness: run the scanner against a real path and print the
// summary, for eyeballing correctness/perf against `du`. Not part of the app.
//
//   cargo run --release --example scan_summary -- <path>

use diskaudit_lib::devtool;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    devtool::scan_and_print(&path);
}
