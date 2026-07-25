// Shell-quoting helpers for the "Copy delete command" action.
//
// DiskAudit NEVER runs these commands — it only places the text on the
// clipboard for the user to paste into Terminal themselves. There is no code
// path in the app that executes a shell command.

/** Quote a path for POSIX shells: wrap in single quotes, escaping embedded
 * single quotes as '\''. Survives spaces, quotes, $, backticks, globs,
 * newlines and non-ASCII intact. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The delete command placed on the clipboard. `-rf` for folders, `-f` for
 * single files — communicates intent and limits blast radius. */
export function deleteCommand(path: string, isDir: boolean): string {
  return `${isDir ? "rm -rf" : "rm -f"} ${shellQuote(path)}`;
}
