export interface TreeNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  file_count: number;
  dir_count: number;
  error_count: number;
  aggregated?: boolean;
  aggregated_count: number;
  aggregated_parent?: string;
  external?: boolean;
  children?: TreeNode[];
}

export interface ExtStat {
  ext: string;
  count: number;
  size: number;
}

export interface TopFile {
  name: string;
  path: string;
  size: number;
}

export interface Stats {
  by_extension: ExtStat[];
  top_files: TopFile[];
}

export interface ScanResult {
  root: TreeNode;
  elapsed_ms: number;
  total_files: number;
  total_dirs: number;
  total_bytes: number;
  permission_errors: number;
  stats: Stats;
}

export interface ProgressPayload {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  current: string;
}
