// Pure path and navigation-stack helpers (kept free of React so they're
// unit-tested). Paths arrive from the backend as native strings, so every
// helper works on both shapes: POSIX (`/Users/a/b`) and Windows
// (`C:\Users\a\b`, `\\server\share\dir`). The shape is detected per path —
// there is no global "current OS" here.

export interface Crumb {
  path: string;
  name: string;
}

/** Drive-letter or UNC path? Everything else is treated as POSIX. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
}

/** The separator this path uses. */
export function sepOf(p: string): "/" | "\\" {
  return isWindowsPath(p) ? "\\" : "/";
}

/** The filesystem root this path hangs off: `/`, `C:\`, or `\\server\share\`
 * (always with its trailing separator), or "" if the path is not absolute. */
export function rootOf(p: string): string {
  if (!isWindowsPath(p)) return p.startsWith("/") ? "/" : "";
  const drive = /^[A-Za-z]:/.exec(p);
  if (drive) return `${drive[0]}\\`;
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p);
  return unc ? `${unc[0]}\\` : "";
}

/** Drop trailing separators, except the one that makes a root a root. */
function trimTrailing(p: string): string {
  const root = rootOf(p);
  const sep = sepOf(p);
  let out = p;
  while (out.length > root.length && out.endsWith(sep)) out = out.slice(0, -1);
  // `C:` and `\\server\share` are spelled with their separator.
  return root && out.length < root.length ? root : out;
}

/** Is this path a filesystem root (`/`, `C:\`, `\\server\share`)? */
export function isRootPath(p: string): boolean {
  const root = rootOf(p);
  return root !== "" && trimTrailing(p) === root;
}

/** Parent of an absolute path, or null at the filesystem root. */
export function parentPath(p: string): string | null {
  if (p === "") return null;
  const path = trimTrailing(p);
  const root = rootOf(path);
  if (root && path === root) return null;
  const i = path.lastIndexOf(sepOf(path));
  if (i < 0) return null;
  const parent = path.slice(0, i);
  return parent.length < root.length ? root : parent;
}

export function baseName(p: string): string {
  const path = trimTrailing(p);
  if (isRootPath(path)) {
    // `/` stays `/`; a drive or share reads better without the slash.
    return path === "/" ? "/" : path.slice(0, -1);
  }
  const i = path.lastIndexOf(sepOf(path));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** `dir` + separator + `name`, in the directory's own style. */
export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Windows names are case-insensitive; POSIX names are not. */
function comparable(p: string): string {
  const t = trimTrailing(p);
  return isWindowsPath(t) ? t.toLowerCase() : t;
}

/** Same location, allowing for trailing separators and Windows casing. */
export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** True if `path` equals `root` or sits underneath it. */
export function isWithin(root: string, path: string): boolean {
  const r = comparable(root);
  const p = comparable(path);
  if (r === "") return false;
  if (p === r) return true;
  const sep = sepOf(root);
  return p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Push a crumb, ignoring a repeat of the current top. */
export function pushCrumb(stack: Crumb[], crumb: Crumb): Crumb[] {
  const top = stack[stack.length - 1];
  if (top && top.path === crumb.path) return stack;
  return [...stack, crumb];
}

/** Truncate the stack to end at `index` (breadcrumb click). */
export function jumpTo(stack: Crumb[], index: number): Crumb[] {
  if (index < 0 || index >= stack.length) return stack;
  return stack.slice(0, index + 1);
}

/** Crumb trail from the scan root to `target` (both absolute, target within
 * root). Used when navigation jumps somewhere directly (search, stats). */
export function trailTo(rootCrumb: Crumb, target: string): Crumb[] {
  if (!isWithin(rootCrumb.path, target)) return [rootCrumb];
  const crumbs: Crumb[] = [rootCrumb];
  if (samePath(target, rootCrumb.path)) return crumbs;
  const sep = sepOf(rootCrumb.path);
  const base = trimTrailing(rootCrumb.path);
  const prefix = base.endsWith(sep) ? base : base + sep;
  const rest = trimTrailing(target).slice(prefix.length);
  let acc = base;
  for (const seg of rest.split(sep)) {
    if (!seg) continue;
    acc = joinPath(acc, seg);
    crumbs.push({ path: acc, name: seg });
  }
  return crumbs;
}
