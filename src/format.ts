// Sizes are formatted the way macOS does: DECIMAL units (1 KB = 1000 bytes),
// so DiskAudit's numbers line up with Finder and Get Info. (The app measures
// allocated blocks, so totals can still differ from Finder's logical sizes —
// see README — but the unit convention matches.)
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Unix seconds → "Mar 12, 2024" (viewer's locale). */
export function formatDate(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Unix seconds → rough age like "8 months" or "2.5 years". */
export function formatAge(unixSecs: number): string {
  const days = Math.max(0, (Date.now() / 1000 - unixSecs) / 86400);
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 365) return `${Math.round(days / 30.44)} months`;
  const years = days / 365.25;
  return `${years >= 10 ? Math.round(years) : years.toFixed(1)} years`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const rs = (s - m * 60).toFixed(0);
  return `${m}m ${rs}s`;
}
