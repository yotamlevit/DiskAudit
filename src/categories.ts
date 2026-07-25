// File-type categorization and color palette, derived from categories.json —
// the single source of truth shared with the Rust backend (which computes the
// category statistics from the same table). Edit the JSON, not this file.

import defs from "./categories.json";

export type Category = keyof typeof defs;

interface CategoryDef {
  label: string;
  color: string;
}

export const CATEGORIES = Object.fromEntries(
  Object.entries(defs).map(([k, v]) => [k, { label: v.label, color: v.color }])
) as Record<Category, CategoryDef>;

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
  return CATEGORIES[categorize(name)].color;
}

export function colorForExt(ext: string): string {
  return CATEGORIES[categoryForExt(ext)].color;
}

export function categoryForExt(ext: string): Category {
  if (!ext) return "noext";
  return EXT_TO_CATEGORY[ext.toLowerCase()] ?? "other";
}
