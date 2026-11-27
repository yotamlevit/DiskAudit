import { describe, expect, test } from "vitest";
import {
  CATEGORIES,
  categorize,
  categoryColor,
  categoryForExt,
  categoryStyleSheet,
  colorForExt,
  inkOn,
  isCategory,
} from "../categories";
import defs from "../categories.json";

describe("categorize", () => {
  test("known extensions map to their category", () => {
    expect(categorize("movie.MP4")).toBe("video");
    expect(categorize("photo.jpeg")).toBe("image");
    expect(categorize("main.rs")).toBe("code");
    expect(categorize("backup.tar.gz")).toBe("archive"); // last extension wins
  });

  test("files without a usable extension", () => {
    expect(categorize("README")).toBe("noext");
    expect(categorize(".gitignore")).toBe("noext"); // leading dot is not an ext
    expect(categorize("weird.")).toBe("noext"); // trailing dot
  });

  test("unknown extensions fall through to other", () => {
    expect(categorize("data.zzznope")).toBe("other");
  });
});

describe("category table (single source of truth)", () => {
  test("every category has a label and color", () => {
    for (const key of Object.keys(defs)) {
      expect(isCategory(key)).toBe(true);
      expect(CATEGORIES[key as keyof typeof CATEGORIES].label).toBeTruthy();
      expect(CATEGORIES[key as keyof typeof CATEGORIES].color).toMatch(/^#/);
    }
  });

  test("no extension is claimed by two categories", () => {
    const seen = new Map<string, string>();
    for (const [cat, def] of Object.entries(defs)) {
      for (const ext of def.exts) {
        expect(
          seen.has(ext),
          `.${ext} in both ${seen.get(ext)} and ${cat}`
        ).toBe(false);
        seen.set(ext, cat);
      }
    }
  });

  test("colors are consistent across lookup paths", () => {
    expect(colorForExt("mp4")).toBe(categoryColor("x.mp4"));
    expect(categoryForExt("")).toBe("noext");
    expect(colorForExt("")).toBe("var(--cat-noext)");
  });

  test("eight hues and two neutrals — never a ninth colour", () => {
    // More hues than this cannot stay distinguishable (see categories.ts);
    // new file kinds must join an existing category.
    expect(Object.keys(CATEGORIES).length).toBe(10);
  });

  test("every category has a light and a dark step, and readable ink", () => {
    for (const def of Object.values(CATEGORIES)) {
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(def.colorDark).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(inkOn("#ffffff")).toBe("#111827");
    expect(inkOn("#0e3d7e")).toBe("#ffffff");
    const css = categoryStyleSheet();
    expect(css).toContain("--cat-video:#f47230");
    expect(css).toContain("--cat-video-ink:");
    expect(css).toContain("prefers-color-scheme: dark");
  });
});
