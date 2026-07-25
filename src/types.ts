// Hand-maintained mirror of the Rust serde payloads in src-tauri/src/scanner.rs
// and src-tauri/src/lib.rs. Field names cross the IPC boundary as snake_case
// (no serde rename). If you change a #[derive(Serialize)] struct there, update
// this file in the same change — nothing checks it automatically.

export type SkipReason = "cloud_storage" | "other_volume" | "firmlink_alias";

/** One node of an on-demand treemap view (scanner::ViewNode). Optional fields
 * are skipped by serde when zero/false/absent. */
export interface ViewNode {
  name: string;
  path: string;
  /** Allocated bytes, recursive for directories. */
  size: number;
  is_dir: boolean;
  /** Recursive counts (directories only). */
  file_count?: number;
  dir_count?: number;
  error_count?: number;
  is_symlink?: boolean;
  /** Synthetic tail rollup of a directory's smaller children (files AND
   * folders). Click → list the parent directory. */
  aggregated?: boolean;
  aggregated_count?: number;
  aggregated_parent?: string;
  skip_reason?: SkipReason;
  /** Directory has content this view doesn't include (depth cap or node
   * budget). Drill in to fetch it. */
  has_hidden_children?: boolean;
  children?: ViewNode[];
}

export interface ViewPayload {
  scan_id: number;
  complete: boolean;
  cancelled: boolean;
  root: ViewNode;
}

export interface DirEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink?: boolean;
  skip_reason?: SkipReason;
  file_count?: number;
  dir_count?: number;
}

export interface DirListing {
  path: string;
  dir_size: number;
  total: number;
  offset: number;
  entries: DirEntry[];
}

export interface SearchHit {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
}

export interface ExtStat {
  ext: string;
  count: number;
  size: number;
}

export interface CatStat {
  category: string;
  count: number;
  size: number;
}

export interface ExtOtherStat {
  distinct: number;
  count: number;
  size: number;
}

export interface TopFile {
  name: string;
  path: string;
  size: number;
}

export interface Stats {
  /** Complete category totals over ALL files. Non-zero categories only. */
  by_category: CatStat[];
  /** Top extensions by size; ext_other aggregates the rest. */
  by_extension: ExtStat[];
  ext_other?: ExtOtherStat;
  top_files: TopFile[];
}

export interface SkippedEntry {
  path: string;
  reason: SkipReason;
}

export interface ScanDone {
  scan_id: number;
  root_path: string;
  root_name: string;
  root_note?: string;
  cancelled: boolean;
  elapsed_ms: number;
  total_files: number;
  total_dirs: number;
  total_symlinks: number;
  /** Allocated bytes (hardlink-deduplicated) — the headline number. */
  allocated_bytes: number;
  /** Sum of logical file lengths (what the files claim to contain). */
  logical_bytes: number;
  hardlink_saved_bytes: number;
  permission_errors: number;
  skipped: SkippedEntry[];
  skipped_total: number;
  stats: Stats;
}

export interface ProgressPayload {
  scan_id: number;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  current: string;
}

// ----- Reclaimable-space payloads (src-tauri/src/reclaim.rs) ---------------

/** Why a finding is reclaimable — determines how safe acting on it is. */
export type ReclaimClass = "regenerable" | "disposable" | "duplicate" | "stale";
export type ReclaimConfidence = "safe" | "careful" | "hint";

export type ReclaimGroupKind =
  | "app_cache"
  | "tool_cache"
  | "xcode"
  | "build_artifact"
  | "trash"
  | "installer"
  | "ios_backup"
  | "xcode_archive"
  | "stale";

export interface ReclaimItem {
  name: string;
  path: string;
  /** Allocated bytes (recursive for directories) — what deleting frees. */
  size: number;
  is_dir: boolean;
  /** Unix seconds, when meaningful for this item. */
  mtime?: number;
  /** One line: what regenerates it, or what is lost. */
  reason: string;
}

export interface ReclaimGroup {
  kind: ReclaimGroupKind;
  label: string;
  blurb: string;
  class: ReclaimClass;
  confidence: ReclaimConfidence;
  /** Total over ALL findings of this kind, including truncated ones. */
  total: number;
  count: number;
  items: ReclaimItem[];
  more_count?: number;
  more_bytes?: number;
}

export interface DupCopy {
  path: string;
  /** Allocated bytes this copy occupies (freed if deleted). */
  size: number;
  mtime: number;
  /** The copy the accounting keeps — never part of the number. */
  keep?: boolean;
  /** Lives inside another finding; counted there, shown for context only. */
  in_finding?: boolean;
}

export interface DupGroup {
  name: string;
  /** Logical size of one copy. */
  logical: number;
  /** Freed by deleting every copy except the kept one. */
  reclaimable: number;
  copies: DupCopy[];
}

export type DupStatus =
  | "not_started"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export interface DupSummary {
  status: DupStatus;
  class?: ReclaimClass;
  confidence?: ReclaimConfidence;
  /** Reclaimable across ALL groups (incl. beyond the payload cap). */
  reclaimable: number;
  group_count: number;
  groups: DupGroup[];
  more_groups?: number;
  more_bytes?: number;
  /** Real I/O the pass performed. */
  bytes_read: number;
  files_hashed: number;
  errors?: number;
}

export interface ReclaimReport {
  scan_id: number;
  /** False = scan still running; findings are partial and still growing. */
  complete: boolean;
  root: string;
  /** Deduplicated union — the headline number. */
  total: number;
  groups: ReclaimGroup[];
  dup: DupSummary;
}

export interface ReclaimProgress {
  scan_id: number;
  phase: "collecting" | "sampling" | "hashing";
  done: number;
  total: number;
  bytes_read: number;
}
