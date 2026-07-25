// Dev-only Tauri IPC mock: lets the UI run in a plain browser (vite dev
// server) against a synthetic filesystem, for visual testing without a scan.
// Mirrors the real backend's contracts loosely: bounded views with tail
// aggregates, listings, search, progress events, cancellation.
// Never bundled into production (see ipc.ts).

import type {
  DirListing,
  DirEntry,
  ProgressPayload,
  ReclaimProgress,
  ReclaimReport,
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
  // Deterministic reclaimable territory (fixed sizes; the mock reclaim
  // report below points at exactly these nodes).
  const dir = (parent: MockNode, name: string): MockNode => {
    const d: MockNode = {
      name,
      path: `${parent.path}/${name}`,
      size: 0,
      is_dir: true,
      children: [],
    };
    parent.children.push(d);
    return d;
  };
  const fileIn = (parent: MockNode, name: string, size: number) => {
    parent.children.push({
      name,
      path: `${parent.path}/${name}`,
      size,
      is_dir: false,
      children: [],
    });
  };
  const lib = root.children.find((c) => c.name === "Library")!;
  const caches = dir(lib, "Caches");
  fileIn(dir(caches, "com.apple.Safari"), "Cache.db", 3.2e9);
  fileIn(dir(caches, "Google"), "chrome-cache.bin", 1.4e9);
  fileIn(dir(caches, "Homebrew"), "downloads.tar", 0.9e9);
  const code = root.children.find((c) => c.name === "Code")!;
  const webapp = dir(code, "webapp");
  fileIn(webapp, "package.json", 2048);
  fileIn(dir(webapp, "node_modules"), "blobs.bin", 2.6e9);
  const rustproj = dir(code, "rustproj");
  fileIn(rustproj, "Cargo.toml", 512);
  fileIn(dir(rustproj, "target"), "artifacts.bin", 1.9e9);
  const trash = dir(root, ".Trash");
  fileIn(trash, "old-project.zip", 0.9e9);
  fileIn(trash, "screen-recording.mov", 0.3e9);
  const downloads = root.children.find((c) => c.name === "Downloads")!;
  fileIn(downloads, "Xcode_15.4.xip", 3.4e9);
  fileIn(downloads, "OldTool.dmg", 0.8e9);
  const movies = root.children.find((c) => c.name === "Movies")!;
  fileIn(movies, "archive-2019.mov", 2.2e9);
  fileIn(root.children.find((c) => c.name === "Pictures")!, "export-final.jpg", 0.6e9);
  fileIn(root.children.find((c) => c.name === "Documents")!, "export-final.jpg", 0.6e9);
  fileIn(root.children.find((c) => c.name === "Desktop")!, "export-final (copy).jpg", 0.6e9);

  // Skipped territory + symlink examples.
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

function nodeShell(n: MockNode): ViewNode {
  const rec = n.is_dir ? countRec(n) : { files: 0, dirs: 0 };
  return {
    name: n.name,
    path: n.path,
    size: n.size,
    is_dir: n.is_dir,
    file_count: rec.files,
    dir_count: rec.dirs,
    is_symlink: n.is_symlink,
    skip_reason: n.skip_reason,
  };
}

/** Bounded view, breadth-first with a node budget — mirrors the real
 * backend's build_view so screenshots/tests are representative. */
function toView(root: MockNode, maxDepth: number, budget: number): ViewNode {
  const rootView = nodeShell(root);
  let budgetLeft = budget - 1;
  const queue: Array<{ node: MockNode; view: ViewNode; depth: number }> = [
    { node: root, view: rootView, depth: 0 },
  ];
  while (queue.length > 0) {
    const { node, view, depth } = queue.shift()!;
    if (!node.is_dir || node.skip_reason) continue;
    if (depth >= maxDepth || budgetLeft <= 0) {
      view.has_hidden_children = node.children.length > 0;
      continue;
    }
    const sorted = [...node.children].sort((a, b) => b.size - a.size);
    const floor = Math.max(1024, node.size * 0.002);
    const kept: ViewNode[] = [];
    let aggSize = 0;
    let aggCount = 0;
    let placed = 0;
    sorted.forEach((c, i) => {
      const remainderLarge = node.size - placed > node.size / 5;
      if (
        budgetLeft > 0 &&
        kept.length < 300 &&
        (i < 10 || c.size >= floor || remainderLarge)
      ) {
        budgetLeft -= 1;
        placed += c.size;
        const cv = nodeShell(c);
        kept.push(cv);
        queue.push({ node: c, view: cv, depth: depth + 1 });
      } else {
        aggSize += c.size;
        aggCount += 1;
      }
    });
    if (aggCount > 0) {
      kept.push({
        name: `${aggCount} smaller items`,
        path: `${node.path}/\u{f8ff}aggregate`,
        size: aggSize,
        is_dir: false,
        aggregated: true,
        aggregated_count: aggCount,
        aggregated_parent: node.path,
      });
    }
    view.children = kept;
  }
  return rootView;
}

// ----- Mock state ----------------------------------------------------------

const TREE = makeTree();
let scanId = 0;
let scanDone = false;
let cancelled = false;
let listeners: Array<(e: { payload: ProgressPayload }) => void> = [];
let reclaimListeners: Array<(e: { payload: ReclaimProgress }) => void> = [];
let dupStatus: "not_started" | "running" | "done" | "cancelled" = "not_started";
let dupCancelRequested = false;

const HOME = "/Users/you";

/** The mock reclaim report: hand-built, pointing at the fixed nodes above. */
function mockReclaim(): ReclaimReport {
  const item = (
    path: string,
    size: number,
    isDir: boolean,
    reason: string,
    mtime?: number
  ) => ({
    name: path.split("/").pop()!,
    path,
    size,
    is_dir: isDir,
    mtime,
    reason,
  });
  const yearAgo = Math.floor(Date.now() / 1000) - 500 * 86400;
  const groups: ReclaimReport["groups"] = [
    {
      kind: "app_cache",
      label: "App caches",
      blurb:
        "Apps rebuild these as needed. Deleting costs a slower first launch, not data.",
      class: "regenerable",
      confidence: "safe",
      total: 5.5e9,
      count: 3,
      items: [
        item(`${HOME}/Library/Caches/com.apple.Safari`, 3.2e9, true, "Cache — rebuilt automatically as needed"),
        item(`${HOME}/Library/Caches/Google`, 1.4e9, true, "Cache — rebuilt automatically as needed"),
        item(`${HOME}/Library/Caches/Homebrew`, 0.9e9, true, "Cache — rebuilt automatically as needed"),
      ],
    },
    {
      kind: "build_artifact",
      label: "Build artifacts",
      blurb: "Recreated by each project's own install or build step.",
      class: "regenerable",
      confidence: "safe",
      total: 4.5e9,
      count: 2,
      items: [
        item(`${HOME}/Code/webapp/node_modules`, 2.6e9, true, "Recreate with npm / yarn / pnpm install"),
        item(`${HOME}/Code/rustproj/target`, 1.9e9, true, "Recreate with cargo build"),
      ],
    },
    {
      kind: "installer",
      label: "Used installers",
      blurb:
        "Installers in Downloads older than 30 days. Most can be re-downloaded; old versions maybe not.",
      class: "disposable",
      confidence: "careful",
      total: 4.2e9,
      count: 2,
      items: [
        item(`${HOME}/Downloads/Xcode_15.4.xip`, 3.4e9, false, "Installer sitting in Downloads for 30+ days — likely already used", yearAgo),
        item(`${HOME}/Downloads/OldTool.dmg`, 0.8e9, false, "Installer sitting in Downloads for 30+ days — likely already used", yearAgo),
      ],
    },
    {
      kind: "stale",
      label: "Stale large files",
      blurb:
        "Big files untouched for over a year — judged by modification time, because access times are unreliable on macOS. Review before acting.",
      class: "stale",
      confidence: "hint",
      total: 2.2e9,
      count: 1,
      items: [
        item(`${HOME}/Movies/archive-2019.mov`, 2.2e9, false, "Large and not modified in over a year (by modification time)", yearAgo),
      ],
    },
    {
      kind: "trash",
      label: "Trash",
      blurb: "Already deleted once. Emptying is permanent.",
      class: "disposable",
      confidence: "careful",
      total: 1.2e9,
      count: 1,
      items: [
        item(`${HOME}/.Trash`, 1.2e9, true, "Already sent to the Trash — emptying is permanent"),
      ],
    },
  ];
  const dupDone = dupStatus === "done";
  const dupReclaim = dupDone ? 1.2e9 : 0;
  return {
    scan_id: scanId,
    complete: scanDone,
    root: HOME,
    total: 17.6e9 + dupReclaim,
    groups,
    dup: {
      status: dupStatus,
      class: "duplicate",
      confidence: "careful",
      reclaimable: dupReclaim,
      group_count: dupDone ? 1 : 0,
      groups: dupDone
        ? [
            {
              name: "export-final.jpg",
              logical: 0.6e9,
              reclaimable: 1.2e9,
              copies: [
                { path: `${HOME}/Pictures/export-final.jpg`, size: 0.6e9, mtime: yearAgo, keep: true },
                { path: `${HOME}/Documents/export-final.jpg`, size: 0.6e9, mtime: yearAgo },
                { path: `${HOME}/Desktop/export-final (copy).jpg`, size: 0.6e9, mtime: yearAgo },
              ],
            },
          ]
        : [],
      bytes_read: dupDone ? 1.9e9 : 0,
      files_hashed: dupDone ? 4 : 0,
    },
  };
}

async function mockDupScan(): Promise<void> {
  dupStatus = "running";
  dupCancelRequested = false;
  const phases: Array<ReclaimProgress["phase"]> = ["sampling", "hashing"];
  for (const phase of phases) {
    for (let i = 1; i <= 4; i++) {
      if (dupCancelRequested) {
        dupStatus = "cancelled";
        return;
      }
      await new Promise((r) => setTimeout(r, 60));
      const payload: ReclaimProgress = {
        scan_id: scanId,
        phase,
        done: i,
        total: 4,
        bytes_read: phase === "hashing" ? i * 0.4e9 : i * 0.1e6,
      };
      reclaimListeners.forEach((l) => l({ payload }));
    }
  }
  dupStatus = "done";
}

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
      dupStatus = "not_started";
      dupCancelRequested = false;
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
    case "get_reclaim":
      if (scanId === 0) throw "no scan in progress or cached; start a scan first";
      return mockReclaim() as unknown as T;
    case "start_dup_scan": {
      if (!scanDone) throw "duplicate detection needs a finished scan";
      if (dupStatus === "running") throw "duplicate detection is already running";
      await mockDupScan();
      return undefined as unknown as T;
    }
    case "cancel_dup_scan":
      dupCancelRequested = true;
      return undefined as unknown as T;
    case "get_view": {
      const p = (args?.path as string | null) ?? TREE.path;
      const node = findNode(TREE, p);
      if (!node) throw `path is not part of this scan: ${p}`;
      const payload: ViewPayload = {
        scan_id: scanId,
        complete: scanDone,
        cancelled,
        root: toView(
          node,
          (args?.depth as number) ?? 4,
          (args?.budget as number) ?? 3000
        ),
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
  revealItem: async (path: string) => {
    console.log("[mock] reveal in Finder:", path);
  },
  copyText: async (text: string) => {
    console.log("[mock] copy to clipboard:", text);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable in the browser; log is enough */
    }
  },
  openFdaSettings: async () => {
    console.log("[mock] open Full Disk Access settings");
  },
  onDragDrop: async () => () => {},
  invoke: mockInvoke,
  listen: async <T>(event: string, handler: (e: { payload: T }) => void) => {
    if (event === "scan://progress") {
      const h = handler as unknown as (e: { payload: ProgressPayload }) => void;
      listeners.push(h);
      return () => {
        listeners = listeners.filter((l) => l !== h);
      };
    }
    if (event === "reclaim://progress") {
      const h = handler as unknown as (e: { payload: ReclaimProgress }) => void;
      reclaimListeners.push(h);
      return () => {
        reclaimListeners = reclaimListeners.filter((l) => l !== h);
      };
    }
    return () => {};
  },
  openDialog: async () => {
    const p = window.prompt("Mock folder picker — enter a path:", "/Users/you");
    return p || null;
  },
};
