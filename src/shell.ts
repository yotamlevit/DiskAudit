// Quoting, findings-export, and deletion-script generation — for POSIX
// shells (macOS, Linux) and PowerShell (Windows).
//
// DiskAudit NEVER runs these commands or scripts, and never writes them to
// disk — everything produced here is plain text placed on the clipboard for
// the USER to review, paste, and run themselves. There is no code path in
// the app that executes a shell command or a generated script, and none may
// be added (see the SECURITY INVARIANT in src-tauri/src/lib.rs).
//
// All command-text generation goes through this module; do not grow a
// second quoting path elsewhere. Each target shell has exactly ONE way for
// a path to reach command text: shellQuote for bash, psLiteral (built on
// psQuote) for PowerShell.

import { formatBytes } from "./format";
import { baseName, isWindowsPath, isWithin } from "./nav";
import type { OsId } from "./types";

/** Quote a path for POSIX shells: wrap in single quotes, escaping embedded
 * single quotes as '\''. Survives spaces, quotes, $, backticks, globs,
 * newlines and non-ASCII intact. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Quote a path as a PowerShell single-quoted (verbatim) string. Nothing is
 * expanded inside one; the only special character is the quote itself,
 * doubled to escape. PowerShell ALSO accepts the typographic quotes
 * U+2018/2019/201A/201B as single-quote delimiters, so those are doubled
 * too — otherwise a folder named with a curly apostrophe ends the string. */
export function psQuote(path: string): string {
  return `'${path.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/** A path as a PowerShell expression made of ASCII characters ONLY.
 *
 * Windows PowerShell 5.1 reads a .ps1 file without a byte-order mark in the
 * machine's legacy code page, not UTF-8. A UTF-8 script would then show a
 * non-ASCII file name as different characters — and some of those bytes
 * decode to the typographic quotes PowerShell accepts as string delimiters
 * (in Windows-1252, "Ò" is the bytes C3 92, and 92 is ’). That would end the
 * string early and let the rest of a file NAME be parsed as code. So nothing
 * outside printable ASCII is ever emitted inside a string: ASCII runs are
 * psQuote()d and every other UTF-16 code unit is spelled as [char]0xNNNN,
 * which means the same thing in every encoding. */
export function psLiteral(path: string): string {
  const parts: string[] = [];
  let run = "";
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      run += path[i];
      continue;
    }
    if (run !== "" || parts.length === 0) {
      // A leading '' keeps `+` a string concatenation from the first term.
      parts.push(psQuote(run));
    }
    run = "";
    parts.push(`[char]0x${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  if (run !== "" || parts.length === 0) parts.push(psQuote(run));
  return parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
}

/** The single-item delete command placed on the clipboard.
 *   POSIX: `rm -rf` for folders, `rm -f` for single files — communicates
 *   intent and limits blast radius.
 *   Windows: .NET's recursive Directory.Delete, which removes a junction or
 *   symlink it meets as a link instead of emptying its target (Remove-Item
 *   -Recurse has not always been that careful). */
export function deleteCommand(path: string, isDir: boolean, os: OsId = "macos"): string {
  if (os === "windows") {
    return isDir
      ? `[System.IO.Directory]::Delete(${psLiteral(path)}, $true)`
      : `Remove-Item -LiteralPath ${psLiteral(path)} -Force`;
  }
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
  /** Host OS: selects the script dialect and the protected locations.
   * Defaults to macOS. */
  os?: OsId;
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

const MAC_SYSTEM = [
  "/", "/Users", "/System", "/Library", "/Applications", "/private", "/var",
  "/tmp", "/etc", "/usr", "/bin", "/sbin", "/opt", "/Volumes",
];
const MAC_HOME = [
  "", "/Library", "/Desktop", "/Documents", "/Downloads", "/Pictures",
  "/Movies", "/Music", "/Applications",
];
const LINUX_SYSTEM = [
  "/", "/home", "/root", "/usr", "/var", "/etc", "/bin", "/sbin", "/lib",
  "/lib32", "/lib64", "/opt", "/boot", "/dev", "/proc", "/sys", "/run",
  "/tmp", "/srv", "/mnt", "/media", "/snap", "/var/cache", "/var/lib",
];
const LINUX_HOME = [
  "", "/Desktop", "/Documents", "/Downloads", "/Pictures", "/Videos",
  "/Music", "/.config", "/.local", "/.local/share", "/.cache", "/.var",
  "/.ssh", "/.gnupg",
];
/** Relative to a drive root (`C:\`). */
const WINDOWS_DRIVE = [
  "", "Users", "Windows", "Program Files", "Program Files (x86)",
  "ProgramData", "$Recycle.Bin", "System Volume Information",
];
const WINDOWS_HOME = [
  "", "\\Desktop", "\\Documents", "\\Downloads", "\\Pictures", "\\Videos",
  "\\Music", "\\AppData", "\\AppData\\Local", "\\AppData\\LocalLow",
  "\\AppData\\Roaming", "\\AppData\\Local\\Temp", "\\OneDrive",
];

/** Comparison key: trailing separators dropped; Windows compared without
 * regard to case. */
function pathKey(p: string, os: OsId): string {
  const sep = os === "windows" ? "\\" : "/";
  let out = p;
  while (out.length > 1 && out.endsWith(sep) && !/^[A-Za-z]:\\$/.test(out)) {
    out = out.slice(0, -1);
  }
  return os === "windows" ? out.toLowerCase() : out;
}

/** Exact paths that must never appear in a deletion script, regardless of
 * what upstream produced. Defense in depth: detection should never emit
 * them; the validator refuses them anyway. */
function protectedPaths(home: string, os: OsId, path: string): Set<string> {
  const set = new Set<string>();
  const add = (p: string) => set.add(pathKey(p, os));
  if (os === "windows") {
    const drive = /^[A-Za-z]:/.exec(path)?.[0];
    if (drive) for (const rel of WINDOWS_DRIVE) add(`${drive}\\${rel}`);
    if (home) for (const sub of WINDOWS_HOME) add(pathKey(home, os) + sub);
    return set;
  }
  for (const p of os === "linux" ? LINUX_SYSTEM : MAC_SYSTEM) add(p);
  if (home && home !== "/") {
    for (const sub of os === "linux" ? LINUX_HOME : MAC_HOME) add(pathKey(home, os) + sub);
  }
  return set;
}

function isAbsoluteFor(p: string, os: OsId): boolean {
  return os === "windows" ? /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p) : p.startsWith("/");
}

/** Path components below the filesystem root. */
function segmentsOf(p: string, os: OsId): string[] {
  if (os !== "windows") return p.split("/").filter(Boolean);
  const rest = p.replace(/^[A-Za-z]:/, "").replace(/^\\\\[^\\]+\\[^\\]+/, "");
  return rest.split("\\").filter(Boolean);
}

function isInTrash(path: string, os: OsId): boolean {
  if (os === "windows") return /\\\$Recycle\.Bin(\\|$)/i.test(path);
  if (os === "linux") return /\/\.local\/share\/Trash(\/|$)|\/\.Trash-\d+(\/|$)/.test(path);
  return /\/\.Trash(\/|$)|\/\.Trashes(\/|$)/.test(path);
}

function trashNameFor(os: OsId): string {
  return os === "windows" ? "Recycle Bin" : "Trash";
}

/** Validate a selection before any command text is generated. Rather than
 * emitting something destructive, unsafe entries are dropped — each with a
 * reason the caller must surface. When two selected paths nest, the
 * ANCESTOR is dropped (deleting less is the conservative resolution). */
export function validateSelection(
  items: ReclaimExportItem[],
  scanRoot: string,
  home: string,
  mode?: ScriptMode,
  os: OsId = "macos"
): { ok: ReclaimExportItem[]; rejected: RejectedItem[] } {
  const rejected: RejectedItem[] = [];
  const seen = new Set<string>();
  const candidates: ReclaimExportItem[] = [];
  const trash = trashNameFor(os);

  for (const item of items) {
    const p = item.path;
    const key = pathKey(p, os);
    if (!p || p.trim() === "") {
      rejected.push({ item, reason: "empty path" });
    } else if (!isAbsoluteFor(p, os) || (os !== "windows" && isWindowsPath(p))) {
      rejected.push({ item, reason: "not an absolute path" });
    } else if (segmentsOf(p, os).includes("..")) {
      rejected.push({ item, reason: "path contains '..'" });
    } else if (os === "windows" && /[\u0000-\u001f"<>|*?]/.test(p.replace(/^\\\\\?\\/, ""))) {
      // None of these can occur in a real Windows file name.
      rejected.push({ item, reason: "path contains characters Windows does not allow" });
    } else if (protectedPaths(home, os, p).has(key)) {
      rejected.push({ item, reason: "protected system location" });
    } else if (!scanRoot || key === pathKey(scanRoot, os) || !isWithin(scanRoot, p)) {
      rejected.push({ item, reason: "outside the scanned folder" });
    } else if (segmentsOf(p, os).length < 2) {
      rejected.push({ item, reason: "top-level directory" });
    } else if (item.category === "package_cache") {
      rejected.push({
        item,
        reason:
          os === "windows"
            ? "system-managed — clear it with Windows Disk Cleanup instead"
            : "system-managed — clear it with your package manager instead",
      });
    } else if (os === "windows" && isInTrash(p, os)) {
      rejected.push({
        item,
        reason: "inside the Recycle Bin — empty it from the desktop instead",
      });
    } else if (mode === "trash" && isInTrash(p, os)) {
      rejected.push({
        item,
        reason: `already in the ${trash} — empty the ${trash} from your file manager, or use the permanent script`,
      });
    } else if (seen.has(key)) {
      // silently drop exact duplicates
    } else {
      seen.add(key);
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

/** Comment-safe text: newlines in a path must never break out of a comment
 * line (true for `#` comments in both bash and PowerShell). */
function commentSafe(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** Generate the deletion script (clipboard text — the app never writes or
 * runs it). Dry-run by default: the script previews and exits unless the
 * user passes --yes. `trash` mode (the default in the UI) keeps the action
 * recoverable; `rm` is the explicit, clearly-labeled permanent variant.
 * The dialect follows `meta.os`: bash for macOS and Linux, PowerShell for
 * Windows. */
export function deletionScript(
  items: ReclaimExportItem[],
  meta: ExportMeta,
  mode: ScriptMode
): ScriptResult {
  const os = meta.os ?? "macos";
  const { ok, rejected } = validateSelection(items, meta.root, meta.home ?? "", mode, os);
  const included = [...ok].sort((a, b) => b.size - a.size);
  return { script: scriptText(included, rejected, meta, mode), included, rejected };
}

/** Render ALREADY-VALIDATED items in the dialect of `meta.os`. Exported so
 * the PowerShell text can be executed by the test suite on any OS (pwsh
 * runs everywhere; Windows-shaped paths do not). App code must go through
 * deletionScript, which validates first. */
export function scriptText(
  included: ReclaimExportItem[],
  rejected: RejectedItem[],
  meta: ExportMeta,
  mode: ScriptMode
): string {
  const os = meta.os ?? "macos";
  return os === "windows"
    ? powershellScript(included, rejected, meta, mode)
    : posixScript(included, rejected, meta, mode, os);
}

/** Review comment above every entry, shared by both dialects. */
function entryComments(item: ReclaimExportItem, idx: number): string[] {
  return [
    `# --- ${idx + 1}. ${commentSafe(baseName(item.path))} — ${formatBytes(item.size)} — ` +
      `${commentSafe(item.category)} (${commentSafe(item.confidence)})`,
    `#     ${commentSafe(item.reason)}`,
  ];
}

function rejectedComments(rejected: RejectedItem[]): string[] {
  if (rejected.length === 0) return [];
  return [
    `# NOT INCLUDED (refused by DiskAudit's safety checks):`,
    ...rejected.map((r) => `#   ${commentSafe(r.item.path)} — ${commentSafe(r.reason)}`),
    ``,
  ];
}

// ----- bash (macOS, Linux) -------------------------------------------------

function posixScript(
  included: ReclaimExportItem[],
  rejected: RejectedItem[],
  meta: ExportMeta,
  mode: ScriptMode,
  os: OsId
): string {
  const total = totalOf(included);
  // macOS has no trash command, so the script moves into ~/.Trash itself.
  // Linux desktops implement the freedesktop.org trash spec, which needs
  // bookkeeping files beside each item — `gio trash` (GLib, present on
  // every GNOME/KDE/XFCE install) does that correctly.
  const linuxTrash = mode === "trash" && os === "linux";

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
    ...(mode === "rm"
      ? [`#  * PERMANENT: rm -rf does not use the Trash. There is NO undo.`]
      : linuxTrash
      ? [
          `#  * Items go to the desktop Trash via 'gio trash' — recoverable`,
          `#    from your file manager until you empty the Trash.`,
        ]
      : [
          `#  * Items go to ~/.Trash — recoverable until you empty the Trash.`,
          `#    (Items on OTHER volumes are physically copied there by mv;`,
          `#    for those, prefer the permanent variant.)`,
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
    ...(linuxTrash
      ? [
          `if [ "$APPLY" -eq 1 ] && ! command -v gio >/dev/null 2>&1; then`,
          `  echo "This script moves items to the Trash with 'gio', which is not installed." >&2`,
          `  echo "Install GLib's command-line tools (libglib2.0-bin / glib2), or generate" >&2`,
          `  echo "the permanent-delete variant in DiskAudit instead." >&2`,
          `  exit 1`,
          `fi`,
        ]
      : []),
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
    ...(mode === "rm"
      ? [
          `  if rm -rf -- "$p"; then`,
          `    echo "deleted: $p  ($bytes bytes)"`,
          `    done_bytes=$((done_bytes + bytes))`,
          `    done_count=$((done_count + 1))`,
          `  else`,
          `    echo "FAILED (may be partially deleted): $p"`,
          `    fail_count=$((fail_count + 1))`,
          `  fi`,
        ]
      : linuxTrash
      ? [
          `  if gio trash -- "$p"; then`,
          `    echo "trashed: $p  ($bytes bytes)"`,
          `    done_bytes=$((done_bytes + bytes))`,
          `    done_count=$((done_count + 1))`,
          `  else`,
          `    echo "FAILED (left in place): $p"`,
          `    fail_count=$((fail_count + 1))`,
          `  fi`,
        ]
      : [
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
        ]),
    `  return 0`,
    `}`,
    ``,
  ];

  const body: string[] = [];
  included.forEach((item, idx) => {
    body.push(...entryComments(item, idx));
    body.push(`process ${shellQuote(item.path)}`);
    body.push(``);
  });
  body.push(...rejectedComments(rejected));

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

  return [...header, ...body, ...footer].join("\n");
}

// ----- PowerShell (Windows) ------------------------------------------------
//
// Runs on Windows PowerShell 5.1 (preinstalled) and PowerShell 7. Same
// contract as the bash script: dry run unless --yes, re-check every path,
// one failure never aborts the rest, measured totals at the end.
//
// Two deliberate choices:
//   * Only fixed text, comments and psLiteral() paths are emitted. No path
//     is ever interpolated into a double-quoted string in the generator —
//     at run time the script's own "$p" expansions are plain variable reads.
//   * The whole script is printable ASCII (see psLiteral for why), so it
//     means the same thing however the user's editor saves it.
//   * Nothing recursive is delegated to Remove-Item. The script walks trees
//     itself and treats every reparse point (junction, symlink) as a leaf,
//     so deleting a folder can never empty something it merely links to.

/** ASCII-only text for a PowerShell `#` comment. Names lose their accents
 * here (the comment is for the reader; the real path is the psLiteral on
 * the next line). */
function psComment(s: string): string {
  return commentSafe(s)
    .replace(/[\u2012-\u2015]/g, "-")
    .replace(/[^\x20-\x7e]/g, "?");
}

function powershellScript(
  included: ReclaimExportItem[],
  rejected: RejectedItem[],
  meta: ExportMeta,
  mode: ScriptMode
): string {
  const total = totalOf(included);
  const verb = mode === "trash" ? "recycle" : "delete";
  const done = mode === "trash" ? "moved to the Recycle Bin" : "deleted";

  const header = [
    `# ============================================================`,
    mode === "trash"
      ? `# DiskAudit deletion script - mode: MOVE TO RECYCLE BIN (recoverable)`
      : `# DiskAudit deletion script - mode: PERMANENT DELETE`,
    `# Generated: ${psComment(meta.generatedAt)} by DiskAudit ${psComment(meta.appVersion)}`,
    `# Scan root: ${psComment(meta.root)}`,
    `# Items: ${included.length}   Estimated total: ${formatBytes(total)} (${total} bytes)`,
    `#`,
    `# HOW TO RUN`,
    `#  Save this text as a .ps1 file (for example cleanup.ps1), then in`,
    `#  PowerShell:`,
    `#      powershell -ExecutionPolicy Bypass -File .\\cleanup.ps1`,
    `#  to preview, and the same command followed by  --yes  to apply.`,
    `#`,
    `# SAFETY`,
    `#  * DRY RUN by default: running this script only PREVIEWS what it`,
    `#    would do. Nothing is touched until you re-run it with --yes.`,
    `#  * Every step re-checks that the path still exists; missing items`,
    `#    are skipped and reported, and one failure never aborts the rest.`,
    `#  * Junctions and symbolic links are never followed.`,
    ...(mode === "trash"
      ? [
          `#  * Items go to the Recycle Bin - recoverable until you empty it.`,
          `#    If an item is too large for the Recycle Bin, Windows asks`,
          `#    before deleting it permanently; answer No to leave it alone.`,
        ]
      : [`#  * PERMANENT: nothing goes to the Recycle Bin. There is NO undo.`]),
    `# ============================================================`,
    `Set-StrictMode -Version 2.0`,
    `$ErrorActionPreference = 'Stop'`,
    ``,
    `$Apply = ($args -contains '--yes')`,
    `if (-not $Apply) {`,
    `  Write-Host 'DRY RUN - nothing will be ${mode === "trash" ? "moved" : "deleted"}. Re-run with --yes to apply.'`,
    `  Write-Host ''`,
    `}`,
    ...(mode === "trash" ? [`Add-Type -AssemblyName Microsoft.VisualBasic`] : []),
    ``,
    `$script:DoneBytes = [long]0`,
    `$script:DoneCount = 0`,
    `$script:SkipCount = 0`,
    `$script:FailCount = 0`,
    ``,
    `# Logical bytes under a path, never descending through a link.`,
    `function Get-TreeBytes([string]$p) {`,
    `  $sum = [long]0`,
    `  try {`,
    `    $attr = [System.IO.File]::GetAttributes($p)`,
    `    $isDir = [bool]($attr -band [System.IO.FileAttributes]::Directory)`,
    `    $isLink = [bool]($attr -band [System.IO.FileAttributes]::ReparsePoint)`,
    `    if ($isLink) { return $sum }`,
    `    if (-not $isDir) { return [long]([System.IO.FileInfo]$p).Length }`,
    `    foreach ($child in [System.IO.Directory]::GetFileSystemEntries($p)) {`,
    `      $sum += Get-TreeBytes $child`,
    `    }`,
    `  } catch { }`,
    `  return $sum`,
    `}`,
    ``,
    ...(mode === "rm"
      ? [
          `# Permanent delete. A reparse point is removed as a link; its target`,
          `# is left alone. Read-only files are unlocked first, as Explorer does.`,
          `function Remove-Tree([string]$p) {`,
          `  $attr = [System.IO.File]::GetAttributes($p)`,
          `  $isDir = [bool]($attr -band [System.IO.FileAttributes]::Directory)`,
          `  $isLink = [bool]($attr -band [System.IO.FileAttributes]::ReparsePoint)`,
          `  if ($isDir -and -not $isLink) {`,
          `    foreach ($child in [System.IO.Directory]::GetFileSystemEntries($p)) {`,
          `      Remove-Tree $child`,
          `    }`,
          `    [System.IO.Directory]::Delete($p, $false)`,
          `    return`,
          `  }`,
          `  if ($attr -band [System.IO.FileAttributes]::ReadOnly) {`,
          `    [System.IO.File]::SetAttributes($p, ($attr -bxor [System.IO.FileAttributes]::ReadOnly))`,
          `  }`,
          `  if ($isDir) { [System.IO.Directory]::Delete($p, $false) } else { [System.IO.File]::Delete($p) }`,
          `}`,
          ``,
        ]
      : []),
    `function Invoke-Entry([string]$p) {`,
    `  # Re-check reality before acting.`,
    `  if (-not (Test-Path -LiteralPath $p)) {`,
    `    Write-Host "SKIP (no longer exists): $p"`,
    `    $script:SkipCount++`,
    `    return`,
    `  }`,
    `  $bytes = Get-TreeBytes $p`,
    `  if (-not $Apply) {`,
    `    Write-Host "would ${verb}: $p  ($bytes bytes)"`,
    `    $script:DoneBytes += $bytes`,
    `    $script:DoneCount++`,
    `    return`,
    `  }`,
    `  try {`,
    ...(mode === "trash"
      ? [
          `    $ui = [Microsoft.VisualBasic.FileIO.UIOption]::AllDialogs`,
          `    $bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin`,
          `    $onCancel = [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException`,
          `    if ([System.IO.Directory]::Exists($p)) {`,
          `      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $bin, $onCancel)`,
          `    } else {`,
          `      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin, $onCancel)`,
          `    }`,
          `    Write-Host "recycled: $p  ($bytes bytes)"`,
        ]
      : [`    Remove-Tree $p`, `    Write-Host "deleted: $p  ($bytes bytes)"`]),
    `    $script:DoneBytes += $bytes`,
    `    $script:DoneCount++`,
    `  } catch {`,
    mode === "trash"
      ? `    Write-Host "FAILED (left in place): $p - $($_.Exception.Message)"`
      : `    Write-Host "FAILED (may be partially deleted): $p - $($_.Exception.Message)"`,
    `    $script:FailCount++`,
    `  }`,
    `}`,
    ``,
  ];

  const body: string[] = [];
  included.forEach((item, idx) => {
    body.push(...entryComments(item, idx).map(psComment));
    body.push(`Invoke-Entry ${psLiteral(item.path)}`);
    body.push(``);
  });
  body.push(...rejectedComments(rejected).map(psComment));

  const footer = [
    `Write-Host ''`,
    `if (-not $Apply) {`,
    `  Write-Host "DRY RUN complete: $($script:DoneCount) items, $($script:DoneBytes) bytes would be ${done}."`,
    `  Write-Host 'Re-run with --yes to apply.'`,
    `} else {`,
    `  Write-Host "Done: $($script:DoneCount) ${done}, $($script:SkipCount) skipped, $($script:FailCount) failed."`,
    mode === "trash"
      ? `  Write-Host "Measured total: $($script:DoneBytes) bytes - space frees when you empty the Recycle Bin."`
      : `  Write-Host "Measured total freed: $($script:DoneBytes) bytes."`,
    `}`,
    `Write-Host 'DiskAudit''s estimate was ${total} bytes (${formatBytes(total)}). Sizes above are file contents; the estimate is space on disk.'`,
    ``,
  ];

  // PowerShell reads LF fine, but Notepad-era tools prefer CRLF.
  return [...header, ...body, ...footer].join("\r\n");
}
