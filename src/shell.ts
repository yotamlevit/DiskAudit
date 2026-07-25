// Shell-quoting, findings-export, and deletion-script generation.
//
// DiskAudit NEVER runs these commands or scripts, and never writes them to
// disk — everything produced here is plain text placed on the clipboard for
// the USER to review, paste, and run themselves. There is no code path in
// the app that executes a shell command or a generated script, and none may
// be added (see the SECURITY INVARIANT in src-tauri/src/lib.rs).
//
// All command-text generation goes through this module; do not grow a
// second quoting path elsewhere.

import { formatBytes } from "./format";
import { isWithin } from "./nav";

/** Quote a path for POSIX shells: wrap in single quotes, escaping embedded
 * single quotes as '\''. Survives spaces, quotes, $, backticks, globs,
 * newlines and non-ASCII intact. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The single-item delete command placed on the clipboard. `-rf` for
 * folders, `-f` for single files — communicates intent and limits blast
 * radius. */
export function deleteCommand(path: string, isDir: boolean): string {
  return `${isDir ? "rm -rf" : "rm -f"} ${shellQuote(path)}`;
}

// ----- Findings export -----------------------------------------------------

/** One exportable finding (a Reclaimable-tab row). */
export interface ReclaimExportItem {
  path: string;
  /** Allocated bytes deleting it would free. */
  size: number;
  isDir: boolean;
  /** Group kind ("app_cache", "build_artifact", "duplicate", …). */
  category: string;
  confidence: string;
  /** One-line explanation (what regenerates it / what is lost). */
  reason: string;
}

/** Provenance stamped into every export and script — a list with no
 * provenance is dangerous six months later. */
export interface ExportMeta {
  root: string;
  generatedAt: string;
  appVersion: string;
  /** The user's home directory, for the protected-path checks. */
  home?: string;
}

function totalOf(items: ReclaimExportItem[]): number {
  return items.reduce((s, i) => s + i.size, 0);
}

/** Plain text: one path per line. Header lines start with '#' so they can
 * never collide with the absolute paths below them. */
export function exportPlain(items: ReclaimExportItem[], meta: ExportMeta): string {
  const total = totalOf(items);
  const lines = [
    `# DiskAudit reclaimable findings (plain paths)`,
    `# Scan root: ${meta.root.replace(/[\r\n]+/g, " ")}`,
    `# Generated: ${meta.generatedAt} by DiskAudit ${meta.appVersion}`,
    `# Items: ${items.length}  Total: ${total} bytes (${formatBytes(total)})`,
    ...items.map((i) => i.path),
  ];
  return lines.join("\n") + "\n";
}

function csvField(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replaceAll(`"`, `""`)}"`;
  }
  return s;
}

/** CSV — the default export: it's the format that gets the list into a
 * spreadsheet where someone actually looks at it before deleting. */
export function exportCsv(items: ReclaimExportItem[], meta: ExportMeta): string {
  const total = totalOf(items);
  const rows = [
    `# DiskAudit reclaimable findings`,
    `# Scan root: ${meta.root.replace(/[\r\n]+/g, " ")}`,
    `# Generated: ${meta.generatedAt} by DiskAudit ${meta.appVersion}`,
    `# Items: ${items.length}  Total: ${total} bytes (${formatBytes(total)})`,
    `path,bytes,size,kind,category,confidence,reason`,
    ...items.map((i) =>
      [
        csvField(i.path),
        String(i.size),
        csvField(formatBytes(i.size)),
        i.isDir ? "folder" : "file",
        csvField(i.category),
        csvField(i.confidence),
        csvField(i.reason),
      ].join(",")
    ),
  ];
  return rows.join("\n") + "\n";
}

/** JSON: the structured findings, for anyone scripting on top. */
export function exportJson(items: ReclaimExportItem[], meta: ExportMeta): string {
  return (
    JSON.stringify(
      {
        tool: "DiskAudit",
        version: meta.appVersion,
        generated: meta.generatedAt,
        scan_root: meta.root,
        item_count: items.length,
        total_bytes: totalOf(items),
        items: items.map((i) => ({
          path: i.path,
          bytes: i.size,
          kind: i.isDir ? "folder" : "file",
          category: i.category,
          confidence: i.confidence,
          reason: i.reason,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

// ----- Deletion-script generation ------------------------------------------

export type ScriptMode = "trash" | "rm";

export interface RejectedItem {
  item: ReclaimExportItem;
  reason: string;
}

export interface ScriptResult {
  script: string;
  included: ReclaimExportItem[];
  rejected: RejectedItem[];
}

/** Exact paths that must never appear in a deletion script, regardless of
 * what upstream produced. Defense in depth: detection should never emit
 * them; the validator refuses them anyway. */
function protectedPaths(home: string): Set<string> {
  const set = new Set<string>([
    "/",
    "/Users",
    "/System",
    "/Library",
    "/Applications",
    "/private",
    "/var",
    "/tmp",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/Volumes",
  ]);
  if (home && home !== "/") {
    const h = home.endsWith("/") ? home.slice(0, -1) : home;
    for (const sub of [
      "",
      "/Library",
      "/Desktop",
      "/Documents",
      "/Downloads",
      "/Pictures",
      "/Movies",
      "/Music",
      "/Applications",
    ]) {
      set.add(h + sub);
    }
  }
  return set;
}

function isInTrash(path: string): boolean {
  return /\/\.Trash(\/|$)|\/\.Trashes(\/|$)/.test(path);
}

/** Validate a selection before any command text is generated. Rather than
 * emitting something destructive, unsafe entries are dropped — each with a
 * reason the caller must surface. When two selected paths nest, the
 * ANCESTOR is dropped (deleting less is the conservative resolution). */
export function validateSelection(
  items: ReclaimExportItem[],
  scanRoot: string,
  home: string,
  mode?: ScriptMode
): { ok: ReclaimExportItem[]; rejected: RejectedItem[] } {
  const rejected: RejectedItem[] = [];
  const protectedSet = protectedPaths(home);
  const seen = new Set<string>();
  const candidates: ReclaimExportItem[] = [];

  for (const item of items) {
    const p = item.path;
    if (!p || p.trim() === "") {
      rejected.push({ item, reason: "empty path" });
    } else if (!p.startsWith("/")) {
      rejected.push({ item, reason: "not an absolute path" });
    } else if (/(^|\/)\.\.(\/|$)/.test(p)) {
      rejected.push({ item, reason: "path contains '..'" });
    } else if (p === "/" || protectedSet.has(p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p)) {
      rejected.push({ item, reason: "protected system location" });
    } else if (!scanRoot || p === scanRoot || !isWithin(scanRoot, p)) {
      rejected.push({ item, reason: "outside the scanned folder" });
    } else if (p.split("/").filter(Boolean).length < 2) {
      rejected.push({ item, reason: "top-level directory" });
    } else if (mode === "trash" && isInTrash(p)) {
      rejected.push({
        item,
        reason:
          "already in the Trash — empty the Trash from Finder, or use the permanent script",
      });
    } else if (seen.has(p)) {
      // silently drop exact duplicates
    } else {
      seen.add(p);
      candidates.push(item);
    }
  }

  // Ancestor check: a path that contains another selected path is dropped.
  const ok: ReclaimExportItem[] = [];
  for (const item of candidates) {
    const isAncestor = candidates.some(
      (other) => other !== item && isWithin(item.path, other.path)
    );
    if (isAncestor) {
      rejected.push({
        item,
        reason: "contains another selected item — keeping the smaller one",
      });
    } else {
      ok.push(item);
    }
  }
  return { ok, rejected };
}

/** Comment-safe text: newlines in a path must never break out of a shell
 * comment line. */
function commentSafe(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Generate the deletion script (clipboard text — the app never writes or
 * runs it). Dry-run by default: the script previews and exits unless the
 * user passes --yes. `trash` mode (the default in the UI) moves items into
 * ~/.Trash so the action stays recoverable; `rm` is the explicit,
 * clearly-labeled permanent variant. */
export function deletionScript(
  items: ReclaimExportItem[],
  meta: ExportMeta,
  mode: ScriptMode
): ScriptResult {
  const { ok, rejected } = validateSelection(items, meta.root, meta.home ?? "", mode);
  const included = [...ok].sort((a, b) => b.size - a.size);
  const total = totalOf(included);

  const header = [
    `#!/bin/bash`,
    `# ============================================================`,
    mode === "trash"
      ? `# DiskAudit deletion script — mode: MOVE TO TRASH (recoverable)`
      : `# DiskAudit deletion script — mode: PERMANENT DELETE (rm -rf)`,
    `# Generated: ${meta.generatedAt} by DiskAudit ${meta.appVersion}`,
    `# Scan root: ${commentSafe(meta.root)}`,
    `# Items: ${included.length}   Estimated total: ${formatBytes(total)} (${total} bytes)`,
    `#`,
    `# SAFETY`,
    `#  * DRY RUN by default: running this script only PREVIEWS what it`,
    `#    would do. Nothing is touched until you re-run it with --yes.`,
    `#  * Every step re-checks that the path still exists; missing items`,
    `#    are skipped and reported, and one failure never aborts the rest.`,
    ...(mode === "trash"
      ? [
          `#  * Items go to ~/.Trash — recoverable until you empty the Trash.`,
          `#    (Items on OTHER volumes are physically copied there by mv;`,
          `#    for those, prefer the permanent variant.)`,
        ]
      : [
          `#  * PERMANENT: rm -rf does not use the Trash. There is NO undo.`,
        ]),
    `# ============================================================`,
    `set -euo pipefail`,
    ``,
    `APPLY=0`,
    `if [ "\${1:-}" = "--yes" ]; then APPLY=1; fi`,
    `if [ "$APPLY" -eq 0 ]; then`,
    `  echo "DRY RUN — nothing will be ${mode === "trash" ? "moved" : "deleted"}. Re-run with --yes to apply."`,
    `  echo`,
    `fi`,
    ``,
    `done_bytes=0`,
    `done_count=0`,
    `skip_count=0`,
    `fail_count=0`,
    `seq=0`,
    ``,
    `process() {`,
    `  local p="$1"`,
    `  seq=$((seq + 1))`,
    `  # Re-check reality before acting.`,
    `  if [ ! -e "$p" ] && [ ! -L "$p" ]; then`,
    `    echo "SKIP (no longer exists): $p"`,
    `    skip_count=$((skip_count + 1))`,
    `    return 0`,
    `  fi`,
    `  local kb bytes`,
    `  # digits-only, first line: du output must NEVER reach arithmetic raw`,
    `  # (a filename containing a newline would end up inside $(( )) )`,
    `  kb=$(du -sk -- "$p" 2>/dev/null | head -n 1 | cut -f1 | tr -cd '0-9') || kb=0`,
    `  bytes=$(( \${kb:-0} * 1024 ))`,
    `  if [ "$APPLY" -eq 0 ]; then`,
    `    echo "would ${mode === "trash" ? "trash" : "delete"}: $p  ($bytes bytes)"`,
    `    done_bytes=$((done_bytes + bytes))`,
    `    done_count=$((done_count + 1))`,
    `    return 0`,
    `  fi`,
    ...(mode === "trash"
      ? [
          `  local dest="$HOME/.Trash/$(basename -- "$p")"`,
          `  if [ -e "$dest" ] || [ -L "$dest" ]; then`,
          `    dest="$dest $(date +%s)-$$-$seq"`,
          `  fi`,
          `  if mv -- "$p" "$dest"; then`,
          `    echo "trashed: $p  ($bytes bytes)"`,
          `    done_bytes=$((done_bytes + bytes))`,
          `    done_count=$((done_count + 1))`,
          `  else`,
          `    echo "FAILED (left in place): $p"`,
          `    fail_count=$((fail_count + 1))`,
          `  fi`,
        ]
      : [
          `  if rm -rf -- "$p"; then`,
          `    echo "deleted: $p  ($bytes bytes)"`,
          `    done_bytes=$((done_bytes + bytes))`,
          `    done_count=$((done_count + 1))`,
          `  else`,
          `    echo "FAILED (may be partially deleted): $p"`,
          `    fail_count=$((fail_count + 1))`,
          `  fi`,
        ]),
    `  return 0`,
    `}`,
    ``,
  ];

  const body: string[] = [];
  included.forEach((item, idx) => {
    const name = item.path.split("/").filter(Boolean).pop() ?? item.path;
    body.push(
      `# --- ${idx + 1}. ${commentSafe(name)} — ${formatBytes(item.size)} — ` +
        `${commentSafe(item.category)} (${commentSafe(item.confidence)})`
    );
    body.push(`#     ${commentSafe(item.reason)}`);
    body.push(`process ${shellQuote(item.path)}`);
    body.push(``);
  });

  if (rejected.length > 0) {
    body.push(`# NOT INCLUDED (refused by DiskAudit's safety checks):`);
    for (const r of rejected) {
      body.push(`#   ${commentSafe(r.item.path)} — ${commentSafe(r.reason)}`);
    }
    body.push(``);
  }

  const doneWord = mode === "trash" ? "moved to Trash" : "deleted";
  const footer = [
    `echo`,
    `if [ "$APPLY" -eq 0 ]; then`,
    `  echo "DRY RUN complete: $done_count items, $done_bytes bytes would be ${doneWord}."`,
    `  echo "Re-run with --yes to apply."`,
    `else`,
    `  echo "Done: $done_count ${doneWord}, $skip_count skipped, $fail_count failed."`,
    mode === "trash"
      ? `  echo "Measured total: $done_bytes bytes — space frees when you empty the Trash."`
      : `  echo "Measured total freed: $done_bytes bytes."`,
    `fi`,
    `echo "DiskAudit's estimate was ${total} bytes (${formatBytes(total)})."`,
    ``,
  ];

  return {
    script: [...header, ...body, ...footer].join("\n"),
    included,
    rejected,
  };
}
