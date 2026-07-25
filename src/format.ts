export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const rs = (s - m * 60).toFixed(0);
  return `${m}m ${rs}s`;
}
