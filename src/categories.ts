// File-type categorization and color palette, derived from categories.json —
// the single source of truth shared with the Rust backend (which computes the
// category statistics from the same table). Edit the JSON, not this file.

import defs from "./categories.json";

export type Category = keyof typeof defs;

interface CategoryDef {
  label: string;
  /** Fill on the light surface. */
  color: string;
  /** The same hue stepped for the dark surface. */
  colorDark: string;
}

// Eight hues in a fixed order plus two neutrals. The order is the palette's
// validated slot order (adjacent pairs stay distinguishable under colour-
// vision deficiency); a ninth hue would not be, so new file kinds join an
// existing category instead of getting a colour of their own.
export const CATEGORIES = Object.fromEntries(
  Object.entries(defs).map(([k, v]) => [
    k,
    { label: v.label, color: v.color, colorDark: v.colorDark },
  ])
) as Record<Category, CategoryDef>;

/** CSS colour for a category: a custom property that resolves to the light
 * or dark step with the theme. Use this for anything painted on screen. */
export function categoryVar(cat: Category): string {
  return `var(--cat-${cat})`;
}

/** Text colour to print on top of a category fill. */
export function categoryInkVar(cat: Category): string {
  return `var(--cat-${cat}-ink)`;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** Near-black or white, whichever has the higher contrast ratio on `hex`. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onBlack = (l + 0.05) / 0.068; // #111827 has luminance ~0.018
  return onWhite >= onBlack ? "#ffffff" : "#111827";
}

/** The stylesheet that defines those custom properties, generated from the
 * JSON so the table stays the single source of truth. */
export function categoryStyleSheet(): string {
  const entries = Object.entries(CATEGORIES) as [Category, CategoryDef][];
  const vars = (pick: (v: CategoryDef) => string) =>
    entries
      .map(([k, v]) => `--cat-${k}:${pick(v)};--cat-${k}-ink:${inkOn(pick(v))};`)
      .join("");
  const light = vars((v) => v.color);
  const dark = vars((v) => v.colorDark);
  return `:root{${light}}@media (prefers-color-scheme: dark){:root{${dark}}}`;
}

/** Install the category colours once at startup (see main.tsx). */
export function installCategoryColors(doc: Document = document): void {
  if (doc.getElementById("category-colors")) return;
  const style = doc.createElement("style");
  style.id = "category-colors";
  style.textContent = categoryStyleSheet();
  doc.head.appendChild(style);
}

const EXT_TO_CATEGORY: Record<string, Category> = {};
for (const [cat, def] of Object.entries(defs)) {
  for (const ext of def.exts) {
    EXT_TO_CATEGORY[ext] = cat as Category;
  }
}

export function isCategory(s: string): s is Category {
  return s in CATEGORIES;
}

export function categorize(name: string): Category {
  // Find last "." that isn't a leading dot.
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "noext";
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_CATEGORY[ext] ?? "other";
}

export function categoryColor(name: string): string {
  return categoryVar(categorize(name));
}

export function colorForExt(ext: string): string {
  return categoryVar(categoryForExt(ext));
}

export function categoryForExt(ext: string): Category {
  if (!ext) return "noext";
  return EXT_TO_CATEGORY[ext.toLowerCase()] ?? "other";
}
