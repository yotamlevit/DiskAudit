// Dev-only Tauri IPC mock: lets the UI run in a plain browser (vite dev
// server) against a synthetic filesystem, for visual testing without a scan.
// Mirrors the real backend's contracts loosely: bounded views with tail
// aggregates, listings, search, progress events, cancellation.
// Never bundled into production (see ipc.ts).

import type {
  DirListing,
  DirEntry,
  ProgressPayload,
  ScanDone,
  SearchHit,
  ViewNode,
  ViewPayload,
} from "./types";

interface MockNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink?: boolean;
  skip_reason?: "cloud_storage" | "other_volume" | "firmlink_alias";
  children: MockNode[];
}

// Deterministic PRNG so screenshots are reproducible.
let seed = 42;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const EXTS = [
  "mp4", "mov", "jpg", "png", "heic", "mp3", "zip", "dmg", "pdf", "docx",
  "ts", "rs", "json", "txt", "log", "db", "dylib", "ttf", "", "dat",
];

function makeTree(): MockNode {
  const root: MockNode = {
    name: "you",
    path: "/Users/you",
    size: 0,
    is_dir: true,
    children: [],
  };
  const topDirs = [
    ["Movies", 48e9, 3, 14],
    ["Pictures", 22e9, 4, 40],
    ["Library", 31e9, 4, 60],
    ["Code", 8e9, 4, 80],
    ["Downloads", 15e9, 2, 30],
    ["Documents", 4e9, 3, 25],
    ["Music", 9e9, 3, 30],
    ["Desktop", 0.8e9, 2, 12],
  ] as const;
  for (const [name, budget, depth, breadth] of topDirs) {
    root.children.push(makeDir(`${root.path}/${name}`, name, budget, depth, breadth));
  }
  // Skipped territory + symlink examples.
  const lib = root.children.find((c) => c.name === "Library")!;
  lib.children.push({
    name: "CloudStorage",
    path: `${lib.path}/CloudStorage`,
    size: 0,
    is_dir: true,
    skip_reason: "cloud_storage",
    children: [],
  });
  root.children.push({
    name: "ExternalBackup",
    path: `${root.path}/ExternalBackup`,
    size: 0,
    is_dir: true,
    skip_reason: "other_volume",
    children: [],
  });
  root.children.push({
    name: "latest → ./Downloads",
    path: `${root.path}/latest`,
    size: 0,
    is_dir: false,
    is_symlink: true,
    children: [],
  });
  fixSizes(root);
  return root;
}

function makeDir(
  path: string,
  name: string,
  budget: number,
  depth: number,
  breadth: number
): MockNode {
  const node: MockNode = { name, path, size: 0, is_dir: true, children: [] };
  const nFiles = Math.floor(breadth * (0.5 + rnd()));
  let remaining = budget;
  // A few dominant files, then a long tail (realistic skew).
  for (let i = 0; i < nFiles; i++) {
    const frac = i === 0 ? 0.35 * rnd() : rnd() * rnd() * 0.12;
    const size = Math.max(1024, Math.floor(remaining * frac));
    remaining -= size;
    const ext = EXTS[Math.floor(rnd() * EXTS.length)];
    const fname = `${name.toLowerCase()}-${String(i).padStart(3, "0")}${ext ? "." + ext : ""}`;
    node.children.push({
      name: fname,
      path: `${path}/${fname}`,
      size,
      is_dir: false,
      children: [],
    });
  }
  if (depth > 1) {
    const nDirs = Math.max(1, Math.floor(breadth / 6));
    for (let i = 0; i < nDirs; i++) {
      const share = (remaining * (0.3 + rnd() * 0.5)) / nDirs;
      const dname = `${name.toLowerCase()}-sub${i}`;
      node.children.push(
        makeDir(`${path}/${dname}`, dname, share, depth - 1, breadth)
      );
    }
  }
  return node;
}

function fixSizes(n: MockNode): number {
  if (n.is_dir) {
    n.size = n.children.reduce((s, c) => s + fixSizes(c), 0);
  }
  return n.size;
}

function countRec(n: MockNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const c of n.children) {
    if (c.is_dir) {
      dirs += 1;
      const r = countRec(c);
      files += r.files;
      dirs += r.dirs;
    } else if (!c.is_symlink) {
      files += 1;
    }
  }
  return { files, dirs };
}

function findNode(root: MockNode, path: string): MockNode | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    if (c.is_dir && (path === c.path || path.startsWith(c.path + "/"))) {
      return findNode(c, path);
    }
  }
  return null;
}

function toView(n: MockNode, depth: number, budgetRef: { left: number }): ViewNode {
  const rec = n.is_dir ? countRec(n) : { files: 0, dirs: 0 };
  const out: ViewNode = {
    name: n.name,
    path: n.path,
    size: n.size,
    is_dir: n.is_dir,
    file_count: rec.files,
    dir_count: rec.dirs,
    is_symlink: n.is_symlink,
    skip_reason: n.skip_reason,
  };
  if (!n.is_dir || n.skip_reason) return out;
  if (depth <= 0 || budgetRef.left <= 0) {
    out.has_hidden_children = n.children.length > 0;
    return out;
  }
  const sorted = [...n.children].sort((a, b) => b.size - a.size);
  const floor = Math.max(1024, n.size * 0.002);
  const kept: ViewNode[] = [];
  let aggSize = 0;
  let aggCount = 0;
  let placed = 0;
  sorted.forEach((c, i) => {
    const remainderLarge = n.size - placed > n.size / 5;
    if (budgetRef.left > 0 && kept.length < 300 && (i < 10 || c.size >= floor || remainderLarge)) {
      budgetRef.left -= 1;
      placed += c.size;
      kept.push(toView(c, depth - 1, budgetRef));
    } else {
      aggSize += c.size;
      aggCount += 1;
    }
  });
  if (aggCount > 0) {
    kept.push({
      name: `${aggCount} smaller items`,
      path: `${n.path}/\u{f8ff}aggregate`,
      size: aggSize,
      is_dir: false,
      aggregated: true,
      aggregated_count: aggCount,
      aggregated_parent: n.path,
    });
  }
  out.children = kept;
  return out;
}

// ----- Mock state ----------------------------------------------------------

const TREE = makeTree();
let scanId = 0;
let scanDone = false;
let cancelled = false;
let listeners: Array<(e: { payload: ProgressPayload }) => void> = [];

function summary(): ScanDone {
  const rec = countRec(TREE);
  return {
    scan_id: scanId,
    root_path: TREE.path,
    root_name: TREE.name,
    cancelled,
    elapsed_ms: 2340,
    total_files: rec.files,
    total_dirs: rec.dirs,
    total_symlinks: 1,
    allocated_bytes: TREE.size,
    logical_bytes: Math.floor(TREE.size * 1.04),
    hardlink_saved_bytes: 210534400,
    permission_errors: 12,
    skipped: [
      { path: "/Users/you/Library/CloudStorage", reason: "cloud_storage" },
      { path: "/Users/you/ExternalBackup", reason: "other_volume" },
    ],
    skipped_total: 2,
    stats: mockStats(),
  };
}

function mockStats() {
  const byExt = new Map<string, { count: number; size: number }>();
  const byCat = new Map<string, { count: number; size: number }>();
  const top: { name: string; path: string; size: number }[] = [];
  const visit = (n: MockNode) => {
    for (const c of n.children) {
      if (c.is_dir) {
        if (!c.skip_reason) visit(c);
      } else if (!c.is_symlink) {
        const dot = c.name.lastIndexOf(".");
        const ext = dot > 0 ? c.name.slice(dot + 1) : "";
        const e = byExt.get(ext) ?? { count: 0, size: 0 };
        e.count += 1;
        e.size += c.size;
        byExt.set(ext, e);
        top.push({ name: c.name, path: c.path, size: c.size });
      }
    }
  };
  visit(TREE);
  top.sort((a, b) => b.size - a.size);
  // Categories roughly via extension buckets (good enough for the mock).
  const catOf: Record<string, string> = {
    mp4: "video", mov: "video", jpg: "image", png: "image", heic: "image",
    mp3: "audio", zip: "archive", dmg: "diskimage", pdf: "document",
    docx: "document", ts: "code", rs: "code", json: "text", txt: "text",
    log: "text", db: "data", dylib: "binary", ttf: "font", "": "noext",
    dat: "other",
  };
  for (const [ext, v] of byExt) {
    const cat = catOf[ext] ?? "other";
    const c = byCat.get(cat) ?? { count: 0, size: 0 };
    c.count += v.count;
    c.size += v.size;
    byCat.set(cat, c);
  }
  return {
    by_category: [...byCat.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.size - a.size),
    by_extension: [...byExt.entries()]
      .map(([ext, v]) => ({ ext, ...v }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 80),
    top_files: top.slice(0, 100),
  };
}

async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "home_dir":
      return "/Users/you" as unknown as T;
    case "start_scan": {
      scanId += 1;
      scanDone = false;
      cancelled = false;
      const total = countRec(TREE);
      // Simulated progressive scan: ~3s of progress events.
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, 125));
        const frac = i / steps;
        const payload: ProgressPayload = {
          scan_id: scanId,
          files: Math.floor(total.files * frac),
          dirs: Math.floor(total.dirs * frac),
          bytes: Math.floor(TREE.size * frac),
          errors: frac > 0.6 ? 12 : 0,
          current: `/Users/you/Library/Caches/step-${i}`,
        };
        listeners.forEach((l) => l({ payload }));
      }
      scanDone = true;
      return summary() as unknown as T;
    }
    case "cancel_scan":
      cancelled = true;
      return undefined as unknown as T;
    case "get_summary":
      return (scanDone ? summary() : null) as unknown as T;
    case "get_view": {
      const p = (args?.path as string | null) ?? TREE.path;
      const node = findNode(TREE, p);
      if (!node) throw `path is not part of this scan: ${p}`;
      const budgetRef = { left: (args?.budget as number) ?? 3000 };
      const payload: ViewPayload = {
        scan_id: scanId,
        complete: scanDone,
        cancelled,
        root: toView(node, (args?.depth as number) ?? 4, budgetRef),
      };
      return payload as unknown as T;
    }
    case "list_dir": {
      const p = args?.path as string;
      const node = findNode(TREE, p);
      if (!node) throw `path is not part of this scan: ${p}`;
      const offset = (args?.offset as number) ?? 0;
      const limit = (args?.limit as number) ?? 500;
      const entries: DirEntry[] = [...node.children]
        .sort((a, b) => b.size - a.size)
        .map((c) => {
          const rec = c.is_dir ? countRec(c) : { files: 0, dirs: 0 };
          return {
            name: c.name,
            path: c.path,
            size: c.size,
            is_dir: c.is_dir,
            is_symlink: c.is_symlink,
            skip_reason: c.skip_reason,
            file_count: rec.files,
            dir_count: rec.dirs,
          };
        });
      const listing: DirListing = {
        path: p,
        dir_size: node.size,
        total: entries.length,
        offset,
        entries: entries.slice(offset, offset + limit),
      };
      return listing as unknown as T;
    }
    case "search_files": {
      const q = ((args?.query as string) ?? "").toLowerCase();
      const minSize = (args?.minSize as number) ?? 0;
      const extFilter = (args?.ext as string | null) ?? null;
      const catFilter = (args?.category as string | null) ?? null;
      const catOfExt: Record<string, string> = {
        mp4: "video", mov: "video", jpg: "image", png: "image", heic: "image",
        mp3: "audio", zip: "archive", dmg: "diskimage", pdf: "document",
        docx: "document", ts: "code", rs: "code", json: "text", txt: "text",
        log: "text", db: "data", dylib: "binary", ttf: "font", "": "noext",
      };
      const hits: SearchHit[] = [];
      const visit = (n: MockNode) => {
        for (const c of n.children) {
          if (c.skip_reason) continue;
          const dot = c.name.lastIndexOf(".");
          const cext = !c.is_dir && dot > 0 ? c.name.slice(dot + 1) : "";
          const matches =
            c.size >= minSize &&
            (!q || c.name.toLowerCase().includes(q)) &&
            (!extFilter || (!c.is_dir && cext === extFilter)) &&
            (!catFilter || (!c.is_dir && (catOfExt[cext] ?? "other") === catFilter)) &&
            (!c.is_dir || (!extFilter && !catFilter));
          if (matches) {
            hits.push({ name: c.name, path: c.path, size: c.size, is_dir: c.is_dir });
          }
          if (c.is_dir) visit(c);
        }
      };
      visit(TREE);
      hits.sort((a, b) => b.size - a.size);
      return hits.slice(0, (args?.limit as number) ?? 200) as unknown as T;
    }
    default:
      throw `mock: unknown command ${cmd}`;
  }
}

export const mockIpc = {
  invoke: mockInvoke,
  listen: async <T>(event: string, handler: (e: { payload: T }) => void) => {
    if (event === "scan://progress") {
      const h = handler as unknown as (e: { payload: ProgressPayload }) => void;
      listeners.push(h);
      return () => {
        listeners = listeners.filter((l) => l !== h);
      };
    }
    return () => {};
  },
  openDialog: async () => {
    const p = window.prompt("Mock folder picker — enter a path:", "/Users/you");
    return p || null;
  },
};
