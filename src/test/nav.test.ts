import { describe, expect, test } from "vitest";
import {
  baseName,
  isRootPath,
  isWindowsPath,
  isWithin,
  joinPath,
  jumpTo,
  parentPath,
  pushCrumb,
  rootOf,
  samePath,
  trailTo,
} from "../nav";

describe("parentPath", () => {
  test("walks up one level", () => {
    expect(parentPath("/Users/me/Movies")).toBe("/Users/me");
    expect(parentPath("/Users")).toBe("/");
  });
  test("stops at the root", () => {
    expect(parentPath("/")).toBeNull();
    expect(parentPath("")).toBeNull();
  });
});

describe("baseName", () => {
  test("last segment", () => {
    expect(baseName("/Users/me/file.txt")).toBe("file.txt");
    expect(baseName("/")).toBe("/");
  });
});

describe("isWithin", () => {
  test("containment is segment-aware", () => {
    expect(isWithin("/Users/me", "/Users/me/Movies")).toBe(true);
    expect(isWithin("/Users/me", "/Users/me")).toBe(true);
    expect(isWithin("/Users/me", "/Users/meow")).toBe(false);
    expect(isWithin("/", "/Users")).toBe(true);
  });
});

describe("navigation stack", () => {
  const root = { path: "/Users/me", name: "me" };
  const movies = { path: "/Users/me/Movies", name: "Movies" };

  test("push adds; pushing the current top is a no-op", () => {
    const s1 = pushCrumb([root], movies);
    expect(s1).toHaveLength(2);
    expect(pushCrumb(s1, movies)).toBe(s1);
  });

  test("jumpTo truncates to the clicked crumb", () => {
    const stack = [root, movies, { path: "/Users/me/Movies/raw", name: "raw" }];
    expect(jumpTo(stack, 1)).toEqual([root, movies]);
    expect(jumpTo(stack, 0)).toEqual([root]);
  });

  test("jumpTo ignores out-of-range indices", () => {
    const stack = [root, movies];
    expect(jumpTo(stack, 5)).toBe(stack);
    expect(jumpTo(stack, -1)).toBe(stack);
  });

  test("trailTo rebuilds the crumb trail for a direct jump", () => {
    const trail = trailTo(root, "/Users/me/Movies/raw/2024");
    expect(trail.map((c) => c.name)).toEqual(["me", "Movies", "raw", "2024"]);
    expect(trail.map((c) => c.path)).toEqual([
      "/Users/me",
      "/Users/me/Movies",
      "/Users/me/Movies/raw",
      "/Users/me/Movies/raw/2024",
    ]);
  });

  test("trailTo clamps to the root for outside paths", () => {
    expect(trailTo(root, "/etc")).toEqual([root]);
    expect(trailTo(root, "/Users/me")).toEqual([root]);
  });
});

// The same helpers must work on the paths a Windows backend sends.
describe("Windows paths", () => {
  test("shape detection is by prefix, never by the host", () => {
    expect(isWindowsPath("C:\\Users\\me")).toBe(true);
    expect(isWindowsPath("c:/Users/me")).toBe(true);
    expect(isWindowsPath("\\\\nas\\share\\x")).toBe(true);
    expect(isWindowsPath("/Users/me")).toBe(false);
    // A POSIX name may contain backslashes and colons.
    expect(isWindowsPath("/tmp/a\\b:c")).toBe(false);
  });

  test("roots", () => {
    expect(rootOf("C:\\Users\\me")).toBe("C:\\");
    expect(rootOf("\\\\nas\\share\\dir")).toBe("\\\\nas\\share\\");
    expect(rootOf("/Users/me")).toBe("/");
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("C:")).toBe(true);
    expect(isRootPath("\\\\nas\\share")).toBe(true);
    expect(isRootPath("\\\\nas\\share\\")).toBe(true);
    expect(isRootPath("C:\\Users")).toBe(false);
    expect(isRootPath("/")).toBe(true);
  });

  test("parentPath stops at the drive or share", () => {
    expect(parentPath("C:\\Users\\me\\Videos")).toBe("C:\\Users\\me");
    expect(parentPath("C:\\Users")).toBe("C:\\");
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("\\\\nas\\share\\dir")).toBe("\\\\nas\\share\\");
    expect(parentPath("\\\\nas\\share\\")).toBeNull();
    // Trailing separators are not an extra level.
    expect(parentPath("C:\\Users\\me\\")).toBe("C:\\Users");
  });

  test("baseName and joinPath", () => {
    expect(baseName("C:\\Users\\me\\a.txt")).toBe("a.txt");
    expect(baseName("C:\\")).toBe("C:");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinPath("C:\\Users", "me")).toBe("C:\\Users\\me");
    expect(joinPath("/Users/me", "Downloads")).toBe("/Users/me/Downloads");
    expect(joinPath("/", "usr")).toBe("/usr");
  });

  test("containment ignores case on Windows only", () => {
    expect(isWithin("C:\\Users\\Me", "c:\\users\\me\\Videos")).toBe(true);
    expect(isWithin("C:\\Users\\me", "C:\\Users\\meow")).toBe(false);
    expect(isWithin("C:\\", "C:\\Windows")).toBe(true);
    expect(isWithin("C:\\", "D:\\Windows")).toBe(false);
    expect(samePath("C:\\Users\\Me\\", "c:\\users\\me")).toBe(true);
    expect(isWithin("/Users/Me", "/users/me/x")).toBe(false);
    expect(samePath("/Users/me/", "/Users/me")).toBe(true);
    expect(isWithin("", "/anything")).toBe(false);
  });

  test("trailTo splits on the path's own separator", () => {
    const root = { path: "C:\\Users\\me", name: "me" };
    const trail = trailTo(root, "C:\\Users\\me\\Videos\\raw");
    expect(trail.map((c) => c.name)).toEqual(["me", "Videos", "raw"]);
    expect(trail[2].path).toBe("C:\\Users\\me\\Videos\\raw");
    const drive = { path: "C:\\", name: "C:\\" };
    expect(trailTo(drive, "C:\\Windows\\Temp").map((c) => c.path)).toEqual([
      "C:\\",
      "C:\\Windows",
      "C:\\Windows\\Temp",
    ]);
  });
});
