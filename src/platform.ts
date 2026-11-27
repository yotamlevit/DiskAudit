// Host-OS facts and the wording that follows from them. The backend reports
// the OS family and home directory once (platform_info); everything the UI
// says about file managers, shortcuts, trash and shells derives from that
// here, so no component hard-codes "Finder" or "⌘".

import { createContext, useContext } from "react";
import type { OsId, PlatformInfo } from "./types";
import { joinPath } from "./nav";

export interface QuickPick {
  label: string;
  path: string;
  hint: string;
}

export interface Platform {
  os: OsId;
  home: string;
  /** "Finder" / "File Explorer" / "your file manager" */
  fileManager: string;
  /** Context-menu label for revealing an item. */
  revealLabel: string;
  /** Where a copied command gets pasted: "Terminal" / "PowerShell". */
  terminal: string;
  /** "Trash" / "Recycle Bin" */
  trash: string;
  /** Render a shortcut with the platform's primary modifier: "⌘F" / "Ctrl+F". */
  mod: (key: string) => string;
  /** Shortcut hint for "go up one level". */
  upKeys: string;
  /** Example text for the path field. */
  pathPlaceholder: string;
  /** One-click scan targets for the welcome screen. */
  quickPicks: QuickPick[];
  /** Why items can be unreadable, and what to do about it. */
  unreadableHelp: string;
  /** True where an "open privacy settings" deep link exists (macOS). */
  hasPrivacySettings: boolean;
}

export function describePlatform(info: PlatformInfo): Platform {
  const { os, home } = info;
  const picks = (diskPath: string, diskLabel: string, diskHint: string): QuickPick[] => {
    const out: QuickPick[] = [];
    if (home) {
      out.push({ label: "Home folder", path: home, hint: home });
      const dl = joinPath(home, "Downloads");
      out.push({ label: "Downloads", path: dl, hint: dl });
    }
    out.push({ label: diskLabel, path: diskPath, hint: diskHint });
    return out;
  };

  if (os === "windows") {
    // The system drive is wherever the profile lives; C: if unknown.
    const drive = /^[A-Za-z]:/.test(home) ? home.slice(0, 2).toUpperCase() : "C:";
    return {
      os,
      home,
      fileManager: "File Explorer",
      revealLabel: "Show in File Explorer",
      terminal: "PowerShell",
      trash: "Recycle Bin",
      mod: (key) => `Ctrl+${key}`,
      upKeys: "Esc, Backspace or Alt+↑",
      pathPlaceholder: `${drive}\\Users\\you   or   ${drive}\\ for the whole drive`,
      quickPicks: picks(`${drive}\\`, `${drive} drive`, "Everything on the system drive"),
      unreadableHelp:
        "Usually folders Windows protects, like other users' profiles. " +
        "Run DiskAudit as administrator to include them.",
      hasPrivacySettings: false,
    };
  }
  if (os === "linux") {
    return {
      os,
      home,
      fileManager: "your file manager",
      revealLabel: "Show in File Manager",
      terminal: "a terminal",
      trash: "Trash",
      mod: (key) => `Ctrl+${key}`,
      upKeys: "Esc, Backspace or Alt+↑",
      pathPlaceholder: "/home/you   or   / for the root filesystem",
      quickPicks: picks("/", "Root filesystem", "Everything on the system partition"),
      unreadableHelp:
        "Usually folders owned by root or other users. They are counted as " +
        "unreadable rather than guessed at.",
      hasPrivacySettings: false,
    };
  }
  return {
    os: "macos",
    home,
    fileManager: "Finder",
    revealLabel: "Reveal in Finder",
    terminal: "Terminal",
    trash: "Trash",
    mod: (key) => `⌘${key}`,
    upKeys: "Esc, Backspace or ⌘↑",
    pathPlaceholder: "/Users/you   or   / for the whole startup disk",
    quickPicks: picks("/", "Startup disk", "Everything on this Mac's disk"),
    unreadableHelp:
      "Usually macOS privacy protection. Grant DiskAudit Full Disk Access, then rescan.",
    hasPrivacySettings: true,
  };
}

/** Until platform_info resolves (one IPC round-trip at startup), and as the
 * fallback if it ever fails: guess from the browser. */
export function guessPlatform(): Platform {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os: OsId = /Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "macos" : "linux";
  return describePlatform({ os, home: "" });
}

export const PlatformContext = createContext<Platform>(describePlatform({ os: "macos", home: "" }));

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}
