// Byte sizes follow the HOST's convention so DiskAudit's numbers line up
// with the file manager next to it:
//   * macOS and Linux desktops: DECIMAL units (1 KB = 1000 bytes), as Finder
//     and GNOME Files show them;
//   * Windows: 1024-based units under the KB/MB/GB labels, as File Explorer
//     shows them.
// (The app measures allocated blocks, so totals can still differ from a file
// manager's logical sizes — see README — but the unit convention matches.)
let unitBase: 1000 | 1024 = 1000;

/** Set once at startup from the host OS (see App.tsx). */
export function setByteUnits(os: "macos" | "windows" | "linux"): void {
  unitBase = os === "windows" ? 1024 : 1000;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < unitBase) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = bytes / unitBase;
  let i = 0;
  while (v >= unitBase && i < units.length - 1) {
    v /= unitBase;
    i++;
  }
  // Rounding can carry a value up to the next unit ("1000 KB" → "1.00 MB").
  let decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  if (Number(v.toFixed(decimals)) >= unitBase && i < units.length - 1) {
    v /= unitBase;
    i++;
    decimals = 2;
  }
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
