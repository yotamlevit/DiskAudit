// File-type categorization and color palette. Shared by the treemap, the
// statistics panel, and the legend so colors are consistent everywhere.

export type Category =
  | "video"
  | "image"
  | "audio"
  | "archive"
  | "document"
  | "code"
  | "data"
  | "diskimage"
  | "binary"
  | "text"
  | "cache"
  | "font"
  | "noext"
  | "other";

interface CategoryDef {
  label: string;
  color: string;
}

export const CATEGORIES: Record<Category, CategoryDef> = {
  video:     { label: "Video",       color: "#ef4444" }, // red
  image:     { label: "Image",       color: "#3b82f6" }, // blue
  audio:     { label: "Audio",       color: "#a855f7" }, // purple
  archive:   { label: "Archive",     color: "#f59e0b" }, // amber
  document:  { label: "Document",    color: "#06b6d4" }, // cyan
  code:      { label: "Code",        color: "#22c55e" }, // green
  data:      { label: "Database",    color: "#ec4899" }, // pink
  diskimage: { label: "Disk image",  color: "#dc2626" }, // dark red
  binary:    { label: "Binary",      color: "#84cc16" }, // lime
  text:      { label: "Text/markup", color: "#14b8a6" }, // teal
  cache:     { label: "Cache/build", color: "#6b7280" }, // slate-gray
  font:      { label: "Font",        color: "#f472b6" }, // pink-light
  noext:     { label: "No extension",color: "#475569" }, // dark slate
  other:     { label: "Other",       color: "#94a3b8" }, // light slate
};

const EXT_TO_CATEGORY: Record<string, Category> = {
  // Video
  mp4: "video", mov: "video", avi: "video", mkv: "video", webm: "video",
  m4v: "video", wmv: "video", flv: "video", mpg: "video", mpeg: "video",
  // Image
  jpg: "image", jpeg: "image", png: "image", heic: "image", heif: "image",
  gif: "image", webp: "image", svg: "image", bmp: "image", tiff: "image",
  tif: "image", raw: "image", cr2: "image", arw: "image", nef: "image",
  dng: "image", icns: "image", ico: "image",
  // Audio
  mp3: "audio", m4a: "audio", wav: "audio", flac: "audio", ogg: "audio",
  aac: "audio", aif: "audio", aiff: "audio", opus: "audio",
  // Archive
  zip: "archive", tar: "archive", gz: "archive", bz2: "archive", xz: "archive",
  "7z": "archive", rar: "archive", tgz: "archive", zst: "archive",
  // Document
  pdf: "document", doc: "document", docx: "document", xls: "document",
  xlsx: "document", ppt: "document", pptx: "document", pages: "document",
  numbers: "document", key: "document", odt: "document", rtf: "document",
  epub: "document", mobi: "document",
  // Code
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rs: "code", go: "code", c: "code", cpp: "code", cc: "code",
  cxx: "code", h: "code", hpp: "code", java: "code", swift: "code", kt: "code",
  rb: "code", php: "code", sh: "code", bash: "code", zsh: "code", lua: "code",
  scala: "code", clj: "code", ex: "code", erl: "code", elm: "code", dart: "code",
  vue: "code", svelte: "code",
  // Data / DB
  db: "data", sqlite: "data", sqlite3: "data", mdb: "data", parquet: "data",
  arrow: "data", feather: "data", h5: "data", hdf5: "data", npy: "data",
  npz: "data",
  // Disk image
  dmg: "diskimage", iso: "diskimage", img: "diskimage", qcow2: "diskimage",
  vmdk: "diskimage", vdi: "diskimage", vhd: "diskimage", vhdx: "diskimage",
  raw5: "diskimage",
  // Binary / Executables
  exe: "binary", dylib: "binary", so: "binary", a: "binary", o: "binary",
  obj: "binary", lib: "binary", wasm: "binary", bin: "binary",
  // Text / markup
  txt: "text", md: "text", json: "text", xml: "text", yml: "text",
  yaml: "text", csv: "text", tsv: "text", html: "text", htm: "text",
  css: "text", scss: "text", less: "text", toml: "text", ini: "text",
  conf: "text", log: "text",
  // Cache / build artifacts
  cache: "cache", tmp: "cache", lock: "cache", pyc: "cache", class: "cache",
  pak: "cache", swp: "cache", bak: "cache",
  // Fonts
  ttf: "font", otf: "font", woff: "font", woff2: "font", eot: "font",
};

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
  if (!ext) return CATEGORIES.noext.color;
  const cat = EXT_TO_CATEGORY[ext.toLowerCase()] ?? "other";
  return CATEGORIES[cat].color;
}

export function categoryForExt(ext: string): Category {
  if (!ext) return "noext";
  return EXT_TO_CATEGORY[ext.toLowerCase()] ?? "other";
}
