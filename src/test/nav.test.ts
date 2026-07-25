import { describe, expect, test } from "vitest";
import {
  baseName,
  isWithin,
  jumpTo,
  parentPath,
  pushCrumb,
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
