// Recent-scan history, persisted in localStorage.

export interface RecentScan {
  path: string;
  at: number;
  bytes?: number;
}

const KEY = "diskaudit.recents";
const MAX = 8;

export function loadRecents(): RecentScan[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentScan => typeof r?.path === "string" && typeof r?.at === "number"
    );
  } catch {
    return [];
  }
}

export function saveRecent(path: string, bytes?: number): RecentScan[] {
  const now = Date.now();
  const rest = loadRecents().filter((r) => r.path !== path);
  const next = [{ path, at: now, bytes }, ...rest].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — history is best-effort */
  }
  return next;
}
