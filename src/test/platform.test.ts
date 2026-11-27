import { describe, expect, test } from "vitest";
import { describePlatform } from "../platform";

describe("describePlatform", () => {
  test("macOS speaks Finder, ⌘ and Trash", () => {
    const p = describePlatform({ os: "macos", home: "/Users/me" });
    expect(p.revealLabel).toBe("Reveal in Finder");
    expect(p.mod("F")).toBe("⌘F");
    expect(p.trash).toBe("Trash");
    expect(p.terminal).toBe("Terminal");
    expect(p.hasPrivacySettings).toBe(true);
    expect(p.quickPicks.map((q) => q.path)).toEqual([
      "/Users/me",
      "/Users/me/Downloads",
      "/",
    ]);
  });

  test("Windows speaks File Explorer, Ctrl and Recycle Bin", () => {
    const p = describePlatform({ os: "windows", home: "D:\\Users\\me" });
    expect(p.revealLabel).toBe("Show in File Explorer");
    expect(p.mod("F")).toBe("Ctrl+F");
    expect(p.trash).toBe("Recycle Bin");
    expect(p.terminal).toBe("PowerShell");
    expect(p.hasPrivacySettings).toBe(false);
    // The system drive is wherever the profile lives.
    expect(p.quickPicks.map((q) => q.path)).toEqual([
      "D:\\Users\\me",
      "D:\\Users\\me\\Downloads",
      "D:\\",
    ]);
  });

  test("Linux names no particular file manager", () => {
    const p = describePlatform({ os: "linux", home: "/home/me" });
    expect(p.revealLabel).toBe("Show in File Manager");
    expect(p.mod("O")).toBe("Ctrl+O");
    expect(p.hasPrivacySettings).toBe(false);
    expect(p.quickPicks[2].path).toBe("/");
  });

  test("an unknown home still offers the disk", () => {
    const p = describePlatform({ os: "windows", home: "" });
    expect(p.quickPicks.map((q) => q.path)).toEqual(["C:\\"]);
  });
});
