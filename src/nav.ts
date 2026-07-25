// Pure navigation-stack helpers (kept free of React so they're unit-testable).

export interface Crumb {
  path: string;
  name: string;
}

/** Parent of an absolute path, or null at the filesystem root. */
export function parentPath(p: string): string | null {
  if (p === "/" || p === "") return null;
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  if (i === 0) return "/";
  return p.slice(0, i);
}

export function baseName(p: string): string {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** True if `path` equals `root` or sits underneath it. */
export function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
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
  if (target === rootCrumb.path) return crumbs;
  const rootPrefix = rootCrumb.path.endsWith("/")
    ? rootCrumb.path
    : rootCrumb.path + "/";
  const rest = target.slice(rootPrefix.length);
  let acc = rootCrumb.path;
  for (const seg of rest.split("/")) {
    if (!seg) continue;
    acc = acc.endsWith("/") ? acc + seg : `${acc}/${seg}`;
    crumbs.push({ path: acc, name: seg });
  }
  return crumbs;
}
