// Extension → category mapping, parsed from the shared table in
// src/categories.json — the single source of truth used by both the Rust
// stats (category totals) and the TypeScript UI (colors/labels). Keep them
// from drifting by editing only the JSON.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct CategoryDef {
    #[allow(dead_code)]
    label: String,
    #[allow(dead_code)]
    color: String,
    exts: Vec<String>,
}

fn ext_map() -> &'static HashMap<String, String> {
    static MAP: OnceLock<HashMap<String, String>> = OnceLock::new();
    MAP.get_or_init(|| {
        let raw = include_str!("../../src/categories.json");
        let parsed: HashMap<String, CategoryDef> =
            serde_json::from_str(raw).unwrap_or_default();
        let mut map = HashMap::new();
        for (cat, def) in parsed {
            for ext in def.exts {
                map.insert(ext, cat.clone());
            }
        }
        map
    })
}

/// Category id for a lowercase extension ("" = no extension).
pub fn category_for_ext(ext: &str) -> &'static str {
    if ext.is_empty() {
        return "noext";
    }
    // The map is a process-lifetime static, so its values are &'static.
    ext_map().get(ext).map(|s| s.as_str()).unwrap_or("other")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_table_parses_and_maps() {
        assert!(!ext_map().is_empty(), "categories.json failed to parse");
        assert_eq!(category_for_ext("mp4"), "video");
        assert_eq!(category_for_ext("rs"), "code");
        assert_eq!(category_for_ext(""), "noext");
        assert_eq!(category_for_ext("zzznope"), "other");
    }
}
