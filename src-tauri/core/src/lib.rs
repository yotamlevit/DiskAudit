// DiskAudit core — the read-only scanner, the session store it fills, and
// the reclaimable-space detector. No UI or Tauri dependency, so it compiles
// and is tested on every target on its own; the app crate (../src/lib.rs)
// is a thin command layer over it.
//
// The SECURITY INVARIANT at the top of ../src/lib.rs governs this crate:
// nothing here may write, move, delete or execute anything.

mod categories;
#[doc(hidden)]
pub mod devtool;
pub mod platform;
pub mod reclaim;
pub mod scanner;
