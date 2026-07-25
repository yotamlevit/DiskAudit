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
