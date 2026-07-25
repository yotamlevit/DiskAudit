// Reclaimable-space detection: answers "what could the user plausibly free?"
// over the existing scan store, plus the staged duplicate-detection pass.
//
// Read-only, with ONE deliberate addition to the crate's I/O surface: the
// duplicate pass opens files READ-ONLY (std::fs::File::open) to hash their
// contents. See the SECURITY INVARIANT in lib.rs. Nothing here writes,
// moves, or deletes anything, and nothing executes what it produces.
//
// Doctrine (see README): bias hard toward under-reporting. A missed cache is
// invisible; a wrongly-flagged project folder loses someone's data. Every
// matcher is exact, ambiguous names require corroborating marker files, and
// anything uncertain is simply not flagged.
//
// The headline number is a DEDUPLICATED union: a duplicated file inside a
// flagged node_modules must not count twice. Precedence, applied once:
//   directory findings  >  installer files  >  duplicate groups  >  stale.

use crate::platform::{self, ReclaimKind, ReclaimSite};
use crate::scanner::{cached_totals, compute_subtree_totals, ScanCancelToken, ScanShared};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

// ----- Tunables (all deliberate policy; documented in README) --------------

/// Directory findings smaller than this are noise, not savings.
const DIR_MIN_BYTES: u64 = 10 * 1000 * 1000;
/// The Trash is the canonical reclaimable spot; lower floor.
const TRASH_MIN_BYTES: u64 = 1000 * 1000;
/// Installers below this aren't worth the row.
const INSTALLER_MIN_BYTES: u64 = 10 * 1000 * 1000;
/// An installer younger than this may not have been used yet.
const INSTALLER_MIN_AGE_DAYS: i64 = 30;
/// "Stale" = at least this big …
const STALE_MIN_BYTES: u64 = 500 * 1000 * 1000;
/// … and untouched (by mtime) for at least this long.
const STALE_MIN_AGE_DAYS: i64 = 365;
/// Duplicate candidates must be at least this big (logical bytes).
const DUP_MIN_LOGICAL: u64 = 1000 * 1000;
/// Head+tail sample size per end for the cheap hash stage.
const SAMPLE_BYTES: usize = 64 * 1024;
/// Payload bounds (bounded-view convention: no giant IPC payloads).
const MAX_ITEMS_PER_GROUP: usize = 200;
const MAX_DUP_GROUPS: usize = 100;

const DAY_SECS: i64 = 86_400;

// ----- Payload types (mirrored by hand in src/types.ts) --------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReclaimClass {
    /// Deleting costs time, not data — a tool or app recreates it.
    Regenerable,
    /// Plausibly unneeded, but deleting is permanent.
    Disposable,
    /// Identical content at several paths; all but one copy is redundant.
    Duplicate,
    /// Old and large. A hint to review, not a verdict.
    Stale,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Safe,
    Careful,
    Hint,
}

impl ReclaimClass {
    pub fn confidence(self) -> Confidence {
        match self {
            ReclaimClass::Regenerable => Confidence::Safe,
            ReclaimClass::Disposable | ReclaimClass::Duplicate => Confidence::Careful,
            ReclaimClass::Stale => Confidence::Hint,
        }
    }
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}
fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Clone, Debug)]
pub struct ReclaimItem {
    pub name: String,
    pub path: String,
    /// Allocated bytes (recursive for directories) — what deleting frees.
    pub size: u64,
    pub is_dir: bool,
    /// Unix seconds, when a modification time is meaningful for this item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// One line: what regenerates it, or what is lost.
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReclaimGroup {
    /// Stable id ("app_cache", "build_artifact", …).
    pub kind: &'static str,
    pub label: &'static str,
    /// One-sentence explanation of the whole class.
    pub blurb: &'static str,
    pub class: ReclaimClass,
    pub confidence: Confidence,
    /// Total over ALL findings of this kind, including truncated ones.
    pub total: u64,
    pub count: u64,
    pub items: Vec<ReclaimItem>,
    #[serde(skip_serializing_if = "is_zero")]
    pub more_count: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub more_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DupCopyPayload {
    pub path: String,
    /// Allocated bytes this copy occupies (freed if deleted).
    pub size: u64,
    pub mtime: i64,
    /// The copy the accounting keeps — never part of the reclaimable number.
    #[serde(skip_serializing_if = "is_false")]
    pub keep: bool,
    /// Lives inside another finding (cache, node_modules…): already counted
    /// there, shown for context only.
    #[serde(skip_serializing_if = "is_false")]
    pub in_finding: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct DupGroupPayload {
    /// Representative file name.
    pub name: String,
    /// Logical size of one copy.
    pub logical: u64,
    /// Bytes freed by deleting every copy EXCEPT the kept one (and excluding
    /// copies already counted inside other findings).
    pub reclaimable: u64,
    pub copies: Vec<DupCopyPayload>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct DupSummaryPayload {
    /// "not_started" | "running" | "done" | "cancelled" | "failed"
    pub status: String,
    /// Always Duplicate/Careful — sent so the UI treats this section with
    /// the same class/confidence machinery as the other groups.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<ReclaimClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<Confidence>,
    /// Reclaimable across ALL groups (incl. beyond the payload cap).
    pub reclaimable: u64,
    pub group_count: u64,
    pub groups: Vec<DupGroupPayload>,
    #[serde(skip_serializing_if = "is_zero")]
    pub more_groups: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub more_bytes: u64,
    /// Real I/O the pass performed, for the honesty line.
    pub bytes_read: u64,
    pub files_hashed: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub errors: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReclaimReport {
    pub scan_id: u64,
    /// The underlying scan is finalized (false = findings are partial and
    /// still growing; the UI must not present the total as the answer).
    pub complete: bool,
    pub root: String,
    /// Deduplicated union of everything below — the headline number.
    pub total: u64,
    pub groups: Vec<ReclaimGroup>,
    pub dup: DupSummaryPayload,
}

// ----- Duplicate-pass shared state -----------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DupStatus {
    #[default]
    NotStarted,
    Running,
    Done,
    Cancelled,
    Failed,
}

impl DupStatus {
    fn as_str(self) -> &'static str {
        match self {
            DupStatus::NotStarted => "not_started",
            DupStatus::Running => "running",
            DupStatus::Done => "done",
            DupStatus::Cancelled => "cancelled",
            DupStatus::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct DupFile {
    pub path: PathBuf,
    pub alloc: u64,
    pub mtime: i64,
}

/// A group of files verified byte-identical by full content hash.
#[derive(Clone, Debug)]
pub struct VerifiedGroup {
    pub logical: u64,
    pub files: Vec<DupFile>,
}

#[derive(Default)]
pub struct DupState {
    pub status: DupStatus,
    pub token: ScanCancelToken,
    pub groups: Vec<VerifiedGroup>,
    pub bytes_read: u64,
    pub files_hashed: u64,
    pub errors: u64,
}

// ----- Detection (path matching over the store; no I/O) --------------------

#[derive(Clone, Copy, PartialEq)]
enum FindKind {
    AppCache,
    ToolCache,
    Xcode,
    XcodeArchive,
    IosBackup,
    Trash,
    BuildArtifact,
    Installer,
    Stale,
}

struct RawFinding {
    path: PathBuf,
    kind: FindKind,
    size: u64,
    is_dir: bool,
    mtime: Option<i64>,
    reason: String,
}

/// Everything detect() concluded, before duplicate/stale interaction is
/// resolved into the final report.
pub struct Detection {
    dir_findings: Vec<RawFinding>,
    installer_findings: Vec<RawFinding>,
    stale_findings: Vec<RawFinding>,
    /// All flagged directory paths (for excluding overlapping findings).
    flagged_dirs: Vec<PathBuf>,
    /// All flagged installer file paths.
    flagged_files: HashSet<PathBuf>,
}

/// Marker files that disambiguate artifact directories from real projects.
mod marker {
    pub const CARGO: u16 = 1 << 0;
    pub const PODFILE: u16 = 1 << 1;
    pub const PACKAGE_JSON: u16 = 1 << 2;
    pub const GO_MOD: u16 = 1 << 3;
    pub const COMPOSER: u16 = 1 << 4;
    pub const GRADLE: u16 = 1 << 5;
}

fn markers_of(names: impl Iterator<Item = impl AsRef<str>>) -> u16 {
    let mut m = 0u16;
    for n in names {
        m |= match n.as_ref() {
            "Cargo.toml" => marker::CARGO,
            "Podfile" => marker::PODFILE,
            "package.json" => marker::PACKAGE_JSON,
            "go.mod" => marker::GO_MOD,
            "composer.json" => marker::COMPOSER,
            "build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts" => {
                marker::GRADLE
            }
            _ => 0,
        };
    }
    m
}

/// Artifact-name rules. `build/` and `dist/` are deliberately NOT here: the
/// names are too often real source directories (build scripts, published
/// dist folders), and a wrong flag is worse than a missed one.
enum ArtifactRule {
    Always,
    ParentHas(u16),
    OwnFile(&'static str),
}

fn artifact_rule(name: &str) -> Option<(ArtifactRule, &'static str)> {
    Some(match name {
        "node_modules" => (
            ArtifactRule::Always,
            "Recreate with npm / yarn / pnpm install",
        ),
        "__pycache__" => (ArtifactRule::Always, "Python recreates this on next run"),
        "target" => (
            ArtifactRule::ParentHas(marker::CARGO),
            "Recreate with cargo build",
        ),
        "Pods" => (
            ArtifactRule::ParentHas(marker::PODFILE),
            "Recreate with pod install",
        ),
        ".next" => (
            ArtifactRule::ParentHas(marker::PACKAGE_JSON),
            "Recreate with next build",
        ),
        ".gradle" => (
            ArtifactRule::ParentHas(marker::GRADLE),
            "Gradle recreates this on the next build",
        ),
        "vendor" => (
            ArtifactRule::ParentHas(marker::GO_MOD | marker::COMPOSER),
            "Recreate with go mod vendor / composer install",
        ),
        ".venv" | "venv" => (
            ArtifactRule::OwnFile("pyvenv.cfg"),
            "Recreate the virtualenv and reinstall packages",
        ),
        _ => return None,
    })
}

/// Ancestor components that mean "already inside an artifact" (guards the
/// scan-root-is-an-artifact case, where the ancestor itself isn't flagged).
fn under_always_artifact(rel: &Path) -> bool {
    let mut comps: Vec<_> = rel.components().collect();
    comps.pop(); // the candidate itself
    comps.iter().any(|c| {
        let s = c.as_os_str();
        s == "node_modules" || s == "__pycache__"
    })
}

fn installer_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".dmg", ".pkg", ".xip", ".ipsw"]
        .iter()
        .any(|e| lower.ends_with(e) && lower.len() > e.len())
}

/// True if any directory component of `rel` (the path below the scan root,
/// excluding the file itself) looks like a macOS package (dot in the name,
/// not at position 0: Foo.app, Photos.photoslibrary, backup.2020…).
fn under_packagelike_dir(rel: &Path) -> bool {
    let mut comps: Vec<_> = rel.components().collect();
    comps.pop();
    comps.iter().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.char_indices().any(|(i, ch)| ch == '.' && i > 0)
    })
}

fn has_library_component(rel: &Path) -> bool {
    rel.components().any(|c| c.as_os_str() == "Library")
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn xcode_reason(name: &str) -> &'static str {
    if name == "DerivedData" {
        "Xcode rebuilds this on the next build"
    } else if name.ends_with("DeviceSupport") {
        "Recreated when a device reconnects"
    } else {
        "Recreated by the simulator / Xcode on demand"
    }
}

/// Path-matching detection over the store. Works live (partial totals) and
/// after finalize (cached totals). `now` is injectable for tests.
pub fn detect(shared: &ScanShared, now: i64) -> Detection {
    let root = &shared.root;

    // Pass 1: one sweep over the store, collecting lightweight candidates.
    // No nested map lookups while iterating (DashMap shard-lock discipline).
    struct FileLite {
        dir: PathBuf,
        name: String,
        size: u64,
        mtime: i64,
    }
    let mut self_sites: Vec<(PathBuf, ReclaimKind)> = Vec::new();
    let mut child_sites: Vec<(PathBuf, ReclaimKind)> = Vec::new();
    let mut installer_roots: Vec<PathBuf> = Vec::new();
    let mut name_candidates: Vec<(PathBuf, ArtifactRule, &'static str)> = Vec::new();
    let mut installer_files: Vec<FileLite> = Vec::new();
    let mut big_files: Vec<FileLite> = Vec::new();
    let mut skipped_paths: Vec<PathBuf> = Vec::new();

    for kv in shared.dirs.iter() {
        let path = kv.key();
        let g = kv.value().lock();
        if g.skip.is_some() {
            skipped_paths.push(path.clone());
            continue;
        }
        match platform::reclaim_site(path, root) {
            Some(ReclaimSite::SelfIsFinding(kind)) => {
                if path != root {
                    self_sites.push((path.clone(), kind));
                }
            }
            Some(ReclaimSite::ChildrenAreFindings(kind)) => {
                child_sites.push((path.clone(), kind));
            }
            Some(ReclaimSite::InstallerDir) => {
                installer_roots.push(path.clone());
            }
            None => {
                if path != root {
                    if let Some((rule, regen)) = artifact_rule(&g.name) {
                        if let Ok(rel) = path.strip_prefix(root) {
                            if !under_always_artifact(rel) {
                                name_candidates.push((path.clone(), rule, regen));
                            }
                        }
                    }
                }
            }
        }
        for f in &g.files {
            if f.is_symlink {
                continue;
            }
            if f.size >= STALE_MIN_BYTES {
                big_files.push(FileLite {
                    dir: path.clone(),
                    name: f.name.clone(),
                    size: f.size,
                    mtime: f.mtime,
                });
            }
            if f.size >= INSTALLER_MIN_BYTES && installer_ext(&f.name) {
                installer_files.push(FileLite {
                    dir: path.clone(),
                    name: f.name.clone(),
                    size: f.size,
                    mtime: f.mtime,
                });
            }
        }
    }

    // Totals: cached after finalize, one live computation otherwise.
    let live_totals = if shared.is_complete() {
        None
    } else {
        Some(compute_subtree_totals(shared, root))
    };
    let totals_of = |p: &Path| -> u64 {
        match &live_totals {
            Some(map) => map.get(p).map(|t| t.size).unwrap_or(0),
            None => cached_totals(shared, p).size,
        }
    };
    let dir_markers = |p: &Path| -> u16 {
        shared
            .dirs
            .get(p)
            .map(|acc| markers_of(acc.lock().files.iter().map(|f| f.name.as_str())))
            .unwrap_or(0)
    };
    let dir_has_file = |p: &Path, name: &str| -> bool {
        shared
            .dirs
            .get(p)
            .map(|acc| acc.lock().files.iter().any(|f| f.name == name))
            .unwrap_or(false)
    };

    // Resolve candidates into directory findings.
    let mut dir_findings: Vec<RawFinding> = Vec::new();
    let mut push_dir = |path: PathBuf, kind: FindKind, reason: String| {
        let size = totals_of(&path);
        let floor = if kind == FindKind::Trash {
            TRASH_MIN_BYTES
        } else {
            DIR_MIN_BYTES
        };
        if size >= floor {
            dir_findings.push(RawFinding {
                path,
                kind,
                size,
                is_dir: true,
                mtime: None,
                reason,
            });
        }
    };

    for (path, kind) in self_sites {
        let name = name_of(&path);
        let (fk, reason) = match kind {
            ReclaimKind::ToolCache => (
                FindKind::ToolCache,
                "Re-downloaded by the tool on demand".to_string(),
            ),
            ReclaimKind::Xcode => (FindKind::Xcode, xcode_reason(&name).to_string()),
            ReclaimKind::XcodeArchive => (
                FindKind::XcodeArchive,
                "Archived builds of past releases — needed to symbolicate old crash logs"
                    .to_string(),
            ),
            ReclaimKind::Trash => (
                FindKind::Trash,
                "Already sent to the Trash — emptying is permanent".to_string(),
            ),
            // Self-findings never carry these kinds today, but stay total.
            ReclaimKind::AppCache => (
                FindKind::AppCache,
                "Rebuilt automatically as needed".to_string(),
            ),
            ReclaimKind::IosBackup => (
                FindKind::IosBackup,
                "Backup of an iOS device — gone forever once deleted".to_string(),
            ),
        };
        push_dir(path, fk, reason);
    }
    for (site, kind) in child_sites {
        let children: Vec<PathBuf> = shared
            .dirs
            .get(&site)
            .map(|acc| acc.lock().children.clone())
            .unwrap_or_default();
        for child in children {
            let skip = shared
                .dirs
                .get(&child)
                .map(|acc| acc.lock().skip.is_some())
                .unwrap_or(true);
            if skip {
                continue;
            }
            let (fk, reason) = match kind {
                ReclaimKind::AppCache => (
                    FindKind::AppCache,
                    "Cache — rebuilt automatically as needed".to_string(),
                ),
                ReclaimKind::ToolCache => (
                    FindKind::ToolCache,
                    "Tool cache — re-downloaded on demand".to_string(),
                ),
                ReclaimKind::IosBackup => (
                    FindKind::IosBackup,
                    "Backup of an iOS device — gone forever once deleted".to_string(),
                ),
                _ => (FindKind::AppCache, "Cache".to_string()),
            };
            push_dir(child, fk, reason);
        }
    }
    for (path, rule, regen) in name_candidates {
        let ok = match rule {
            ArtifactRule::Always => true,
            ArtifactRule::ParentHas(bits) => path
                .parent()
                .map(|par| dir_markers(par) & bits != 0)
                .unwrap_or(false),
            ArtifactRule::OwnFile(f) => dir_has_file(&path, f),
        };
        if ok {
            push_dir(path, FindKind::BuildArtifact, regen.to_string());
        }
    }

    // Keep only outermost findings (a target/ inside a flagged node_modules
    // is covered by its ancestor), then drop any finding whose subtree
    // contains skipped territory (a live mount point is not deletable data).
    dir_findings.sort_by(|a, b| a.path.cmp(&b.path));
    let mut kept: Vec<RawFinding> = Vec::new();
    for f in dir_findings {
        let nested = kept
            .last()
            .map(|k: &RawFinding| f.path.starts_with(&k.path))
            .unwrap_or(false);
        if !nested {
            kept.push(f);
        }
    }
    kept.retain(|f| !skipped_paths.iter().any(|s| s.starts_with(&f.path)));
    let dir_findings = kept;

    let flagged_dirs: Vec<PathBuf> = dir_findings.iter().map(|f| f.path.clone()).collect();
    let under_flagged =
        |p: &Path| -> bool { flagged_dirs.iter().any(|d| p.starts_with(d) && p != d) };

    // Installers: only inside a Downloads root, only if old enough.
    let mut installer_findings: Vec<RawFinding> = Vec::new();
    let mut flagged_files: HashSet<PathBuf> = HashSet::new();
    for f in installer_files {
        let in_downloads = installer_roots.iter().any(|r| f.dir.starts_with(r));
        if !in_downloads {
            continue;
        }
        if f.mtime <= 0 || now - f.mtime < INSTALLER_MIN_AGE_DAYS * DAY_SECS {
            continue;
        }
        let full = f.dir.join(&f.name);
        if under_flagged(&full) {
            continue;
        }
        flagged_files.insert(full.clone());
        installer_findings.push(RawFinding {
            path: full,
            kind: FindKind::Installer,
            size: f.size,
            is_dir: false,
            mtime: Some(f.mtime),
            reason: "Installer sitting in Downloads for 30+ days — likely already used".to_string(),
        });
    }

    // Stale: strictly a hint, with aggressive exclusions. Anything under a
    // Library, inside a package-like folder (Foo.app, *.photoslibrary), or
    // already covered by another finding is NOT flagged.
    let mut stale_findings: Vec<RawFinding> = Vec::new();
    for f in big_files {
        if f.mtime <= 0 || now - f.mtime < STALE_MIN_AGE_DAYS * DAY_SECS {
            continue;
        }
        let full = f.dir.join(&f.name);
        if under_flagged(&full) || flagged_files.contains(&full) {
            continue;
        }
        let Ok(rel) = full.strip_prefix(root) else {
            continue;
        };
        if has_library_component(rel) || under_packagelike_dir(rel) {
            continue;
        }
        stale_findings.push(RawFinding {
            path: full,
            kind: FindKind::Stale,
            size: f.size,
            is_dir: false,
            mtime: Some(f.mtime),
            reason: "Large and not modified in over a year (by modification time)".to_string(),
        });
    }

    Detection {
        dir_findings,
        installer_findings,
        stale_findings,
        flagged_dirs,
        flagged_files,
    }
}

// ----- Report assembly -----------------------------------------------------

struct GroupMeta {
    kind: &'static str,
    label: &'static str,
    blurb: &'static str,
    class: ReclaimClass,
}

fn group_meta(kind: FindKind) -> GroupMeta {
    match kind {
        FindKind::AppCache => GroupMeta {
            kind: "app_cache",
            label: "App caches",
            blurb: "Apps rebuild these as needed. Deleting costs a slower first launch, not data.",
            class: ReclaimClass::Regenerable,
        },
        FindKind::ToolCache => GroupMeta {
            kind: "tool_cache",
            label: "Developer tool caches",
            blurb: "Package managers re-download whatever the next build needs.",
            class: ReclaimClass::Regenerable,
        },
        FindKind::Xcode => GroupMeta {
            kind: "xcode",
            label: "Xcode regenerable data",
            blurb: "DerivedData, device support and simulator caches — Xcode recreates them.",
            class: ReclaimClass::Regenerable,
        },
        FindKind::BuildArtifact => GroupMeta {
            kind: "build_artifact",
            label: "Build artifacts",
            blurb: "Recreated by each project's own install or build step.",
            class: ReclaimClass::Regenerable,
        },
        FindKind::Trash => GroupMeta {
            kind: "trash",
            label: "Trash",
            blurb: "Already deleted once. Emptying is permanent.",
            class: ReclaimClass::Disposable,
        },
        FindKind::Installer => GroupMeta {
            kind: "installer",
            label: "Used installers",
            blurb: "Installers in Downloads older than 30 days. Most can be re-downloaded; \
                    old versions maybe not.",
            class: ReclaimClass::Disposable,
        },
        FindKind::IosBackup => GroupMeta {
            kind: "ios_backup",
            label: "Device backups",
            blurb: "iPhone/iPad backups. Deleting is PERMANENT — only safe if the device \
                    still syncs or the backup is obsolete.",
            class: ReclaimClass::Disposable,
        },
        FindKind::XcodeArchive => GroupMeta {
            kind: "xcode_archive",
            label: "Xcode archives",
            blurb: "Builds of specific past releases, needed to symbolicate old crash \
                    reports. Deleting is permanent.",
            class: ReclaimClass::Disposable,
        },
        FindKind::Stale => GroupMeta {
            kind: "stale",
            label: "Stale large files",
            blurb: "Big files untouched for over a year — judged by modification time, \
                    because access times are unreliable on macOS. Review before acting.",
            class: ReclaimClass::Stale,
        },
    }
}

fn to_group(kind: FindKind, mut findings: Vec<RawFinding>) -> Option<ReclaimGroup> {
    if findings.is_empty() {
        return None;
    }
    findings.sort_by_key(|f| std::cmp::Reverse(f.size));
    let meta = group_meta(kind);
    let total: u64 = findings.iter().map(|f| f.size).sum();
    let count = findings.len() as u64;
    let mut more_count = 0u64;
    let mut more_bytes = 0u64;
    if findings.len() > MAX_ITEMS_PER_GROUP {
        for f in &findings[MAX_ITEMS_PER_GROUP..] {
            more_count += 1;
            more_bytes += f.size;
        }
        findings.truncate(MAX_ITEMS_PER_GROUP);
    }
    let items = findings
        .into_iter()
        .map(|f| ReclaimItem {
            name: name_of(&f.path),
            path: f.path.to_string_lossy().to_string(),
            size: f.size,
            is_dir: f.is_dir,
            mtime: f.mtime,
            reason: f.reason,
        })
        .collect();
    Some(ReclaimGroup {
        kind: meta.kind,
        label: meta.label,
        blurb: meta.blurb,
        class: meta.class,
        confidence: meta.class.confidence(),
        total,
        count,
        items,
        more_count,
        more_bytes,
    })
}

/// Choose which copy of a duplicate group to keep: oldest mtime (the likely
/// original), then shortest path, then lexicographic — deterministic.
fn keep_index(files: &[DupFile]) -> usize {
    let mut best = 0usize;
    for (i, f) in files.iter().enumerate().skip(1) {
        let b = &files[best];
        let cmp = f
            .mtime
            .cmp(&b.mtime)
            .then(f.path.as_os_str().len().cmp(&b.path.as_os_str().len()))
            .then(f.path.cmp(&b.path));
        if cmp == std::cmp::Ordering::Less {
            best = i;
        }
    }
    best
}

/// The full report: detection + duplicate results, merged under the
/// precedence rules so nothing is counted twice.
pub fn build_report(shared: &ScanShared) -> ReclaimReport {
    build_report_at(shared, now_unix())
}

pub fn build_report_at(shared: &ScanShared, now: i64) -> ReclaimReport {
    let det = detect(shared, now);
    let under_flagged = |p: &Path| -> bool {
        det.flagged_dirs.iter().any(|d| p.starts_with(d) && p != d) || det.flagged_files.contains(p)
    };

    // Duplicate groups: keep-one accounting, minus copies other findings
    // already count.
    let (dup_status, verified, bytes_read, files_hashed, errors) = {
        let d = shared.dup.lock();
        (
            d.status,
            d.groups.clone(),
            d.bytes_read,
            d.files_hashed,
            d.errors,
        )
    };
    let mut dup_groups: Vec<DupGroupPayload> = Vec::new();
    let mut dup_member_paths: HashSet<PathBuf> = HashSet::new();
    for g in &verified {
        let free_idx: Vec<usize> = (0..g.files.len())
            .filter(|&i| !under_flagged(&g.files[i].path))
            .collect();
        if free_idx.len() < 2 {
            // Zero or one copy outside other findings: nothing extra to
            // reclaim here (deleting the caches already handles the rest).
            continue;
        }
        let free_files: Vec<DupFile> = free_idx.iter().map(|&i| g.files[i].clone()).collect();
        let keep_i = free_idx[keep_index(&free_files)];
        let reclaimable: u64 = g
            .files
            .iter()
            .enumerate()
            .filter(|(i, _)| free_idx.contains(i) && *i != keep_i)
            .map(|(_, f)| f.alloc)
            .sum();
        if reclaimable == 0 {
            continue;
        }
        for f in &g.files {
            dup_member_paths.insert(f.path.clone());
        }
        let copies: Vec<DupCopyPayload> = g
            .files
            .iter()
            .enumerate()
            .map(|(i, f)| DupCopyPayload {
                path: f.path.to_string_lossy().to_string(),
                size: f.alloc,
                mtime: f.mtime,
                keep: i == keep_i,
                in_finding: !free_idx.contains(&i),
            })
            .collect();
        let name = g
            .files
            .get(keep_i)
            .map(|f| name_of(&f.path))
            .unwrap_or_default();
        dup_groups.push(DupGroupPayload {
            name,
            logical: g.logical,
            reclaimable,
            copies,
        });
    }
    dup_groups.sort_by_key(|g| std::cmp::Reverse(g.reclaimable));
    let dup_reclaimable: u64 = dup_groups.iter().map(|g| g.reclaimable).sum();
    let group_count = dup_groups.len() as u64;
    let mut more_groups = 0u64;
    let mut more_bytes = 0u64;
    if dup_groups.len() > MAX_DUP_GROUPS {
        for g in &dup_groups[MAX_DUP_GROUPS..] {
            more_groups += 1;
            more_bytes += g.reclaimable;
        }
        dup_groups.truncate(MAX_DUP_GROUPS);
    }

    // Stale loses to duplicates: a stale file that is part of a reported
    // duplicate group is already represented (and counted) there.
    let stale: Vec<RawFinding> = det
        .stale_findings
        .into_iter()
        .filter(|f| !dup_member_paths.contains(&f.path))
        .collect();

    // Assemble groups by kind.
    let mut by_kind: HashMap<u8, (FindKind, Vec<RawFinding>)> = HashMap::new();
    let mut push_all = |v: Vec<RawFinding>| {
        for f in v {
            let key = f.kind as u8;
            by_kind
                .entry(key)
                .or_insert_with(|| (f.kind, Vec::new()))
                .1
                .push(f);
        }
    };
    push_all(det.dir_findings);
    push_all(det.installer_findings);
    push_all(stale);

    let mut groups: Vec<ReclaimGroup> = by_kind
        .into_values()
        .filter_map(|(kind, v)| to_group(kind, v))
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.total));

    let path_total: u64 = groups.iter().map(|g| g.total).sum();
    let total = path_total + dup_reclaimable;

    ReclaimReport {
        scan_id: shared.scan_id,
        complete: shared.is_complete(),
        root: shared.root.to_string_lossy().to_string(),
        total,
        groups,
        dup: DupSummaryPayload {
            status: dup_status.as_str().to_string(),
            class: Some(ReclaimClass::Duplicate),
            confidence: Some(ReclaimClass::Duplicate.confidence()),
            reclaimable: dup_reclaimable,
            group_count,
            groups: dup_groups,
            more_groups,
            more_bytes,
            bytes_read,
            files_hashed,
            errors,
        },
    }
}

// ----- Staged duplicate pass (the only file-content I/O in the app) --------

pub type DupProgressCb = dyn Fn(&'static str, u64, u64, u64) + Send + Sync;

struct DupCand {
    path: PathBuf,
    logical: u64,
    alloc: u64,
    mtime: i64,
}

/// Try to mark the pass as running. False if one is already running.
pub fn try_begin_dup_scan(shared: &ScanShared) -> bool {
    let mut d = shared.dup.lock();
    if d.status == DupStatus::Running {
        return false;
    }
    *d = DupState {
        status: DupStatus::Running,
        token: ScanCancelToken::new(),
        ..Default::default()
    };
    true
}

pub fn cancel_dup_scan(shared: &ScanShared) {
    shared.dup.lock().token.cancel();
}

/// Run the staged pipeline. Call try_begin_dup_scan first. Stages:
///   1. candidates from the store (logical ≥ 1 MB, not symlink, not
///      hardlinked — deleting one path of a hardlink set frees nothing)
///   2. group by logical size, drop singletons        (no I/O)
///   3. head+tail sample hash, regroup, drop singletons (little I/O)
///   4. full hash survivors, regroup                   (the real I/O)
///
/// Only files that collided twice ever get fully read; bytes_read reports
/// exactly how much I/O the pass performed.
pub fn run_dup_scan(shared: &ScanShared, on_progress: Arc<DupProgressCb>) {
    let token = shared.dup.lock().token.clone();
    let bytes_read = AtomicU64::new(0);
    let done_ctr = AtomicU64::new(0);
    let errors = AtomicU64::new(0);
    let last_emit = AtomicU64::new(0);

    let emit = |phase: &'static str, done: u64, total: u64, force: bool| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let last = last_emit.load(Ordering::Relaxed);
        if force
            || (now.saturating_sub(last) >= 100
                && last_emit
                    .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok())
        {
            on_progress(phase, done, total, bytes_read.load(Ordering::Relaxed));
        }
    };

    // Stage 1: collect candidates.
    emit("collecting", 0, 0, true);
    let mut cands: Vec<DupCand> = Vec::new();
    for kv in shared.dirs.iter() {
        if token.is_cancelled() {
            break;
        }
        let dir = kv.key();
        let g = kv.value().lock();
        if g.skip.is_some() {
            continue;
        }
        for f in &g.files {
            if f.is_symlink || f.hardlinked || f.logical < DUP_MIN_LOGICAL || f.size == 0 {
                continue;
            }
            cands.push(DupCand {
                path: dir.join(&f.name),
                logical: f.logical,
                alloc: f.size,
                mtime: f.mtime,
            });
        }
    }

    // Stage 2: group by logical size; drop singletons.
    let mut by_size: HashMap<u64, Vec<DupCand>> = HashMap::new();
    for c in cands {
        by_size.entry(c.logical).or_default().push(c);
    }
    by_size.retain(|_, v| v.len() >= 2);

    // Stage 3: head+tail sample hash.
    let sample_cands: Vec<DupCand> = by_size.into_values().flatten().collect();
    let sample_total = sample_cands.len() as u64;
    done_ctr.store(0, Ordering::Relaxed);
    emit("sampling", 0, sample_total, true);
    let sampled: Vec<Option<(DupCand, blake3::Hash)>> = {
        use rayon::prelude::*;
        sample_cands
            .into_par_iter()
            .map(|c| {
                if token.is_cancelled() {
                    return None;
                }
                let r = hash_sample(&c.path, c.logical);
                let done = done_ctr.fetch_add(1, Ordering::Relaxed) + 1;
                match r {
                    Ok((n, h)) => {
                        bytes_read.fetch_add(n, Ordering::Relaxed);
                        emit("sampling", done, sample_total, false);
                        Some((c, h))
                    }
                    Err(_) => {
                        errors.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .collect()
    };
    let mut by_sample: HashMap<(u64, blake3::Hash), Vec<DupCand>> = HashMap::new();
    for entry in sampled.into_iter().flatten() {
        let (c, h) = entry;
        by_sample.entry((c.logical, h)).or_default().push(c);
    }
    by_sample.retain(|_, v| v.len() >= 2);

    // Stage 4: full hash for survivors.
    let full_cands: Vec<DupCand> = by_sample.into_values().flatten().collect();
    let full_total = full_cands.len() as u64;
    done_ctr.store(0, Ordering::Relaxed);
    emit("hashing", 0, full_total, true);
    let hashed: Vec<Option<(DupCand, blake3::Hash)>> = {
        use rayon::prelude::*;
        full_cands
            .into_par_iter()
            .map(|c| {
                if token.is_cancelled() {
                    return None;
                }
                let r = hash_full(&c.path, c.logical);
                let done = done_ctr.fetch_add(1, Ordering::Relaxed) + 1;
                match r {
                    Ok((n, h)) => {
                        bytes_read.fetch_add(n, Ordering::Relaxed);
                        emit("hashing", done, full_total, false);
                        Some((c, h))
                    }
                    Err(_) => {
                        errors.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .collect()
    };
    let files_hashed = hashed.iter().filter(|h| h.is_some()).count() as u64;
    let mut by_full: HashMap<(u64, blake3::Hash), Vec<DupCand>> = HashMap::new();
    for entry in hashed.into_iter().flatten() {
        let (c, h) = entry;
        by_full.entry((c.logical, h)).or_default().push(c);
    }

    let mut groups: Vec<VerifiedGroup> = by_full
        .into_iter()
        .filter(|(_, v)| v.len() >= 2)
        .map(|((logical, _), v)| VerifiedGroup {
            logical,
            files: v
                .into_iter()
                .map(|c| DupFile {
                    path: c.path,
                    alloc: c.alloc,
                    mtime: c.mtime,
                })
                .collect(),
        })
        .collect();
    // Deterministic member order (walk order isn't).
    for g in &mut groups {
        g.files.sort_by(|a, b| a.path.cmp(&b.path));
    }

    emit("hashing", full_total, full_total, true);
    let mut d = shared.dup.lock();
    d.groups = groups;
    d.bytes_read = bytes_read.load(Ordering::Relaxed);
    d.files_hashed = files_hashed;
    d.errors = errors.load(Ordering::Relaxed);
    d.status = if token.is_cancelled() {
        DupStatus::Cancelled
    } else {
        DupStatus::Done
    };
}

/// Mark the pass failed (panic recovery in lib.rs).
pub fn fail_dup_scan(shared: &ScanShared) {
    shared.dup.lock().status = DupStatus::Failed;
}

/// Hash the first and last SAMPLE_BYTES of the file. Cheap collision filter;
/// equal content of equal size always produces equal samples. Skips files
/// whose current length no longer matches the scanned logical size (changed
/// since the scan — reality wins).
fn hash_sample(path: &Path, expect_len: u64) -> std::io::Result<(u64, blake3::Hash)> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let md = f.metadata()?;
    if md.len() != expect_len {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file changed since scan",
        ));
    }
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; SAMPLE_BYTES];
    let n_head = read_fully(&mut f, &mut buf)?;
    hasher.update(&buf[..n_head]);
    let mut read = n_head as u64;
    if expect_len > (SAMPLE_BYTES as u64) * 2 {
        f.seek(SeekFrom::End(-(SAMPLE_BYTES as i64)))?;
        let n_tail = read_fully(&mut f, &mut buf)?;
        hasher.update(&buf[..n_tail]);
        read += n_tail as u64;
    }
    Ok((read, hasher.finalize()))
}

fn hash_full(path: &Path, expect_len: u64) -> std::io::Result<(u64, blake3::Hash)> {
    let mut f = std::fs::File::open(path)?;
    let md = f.metadata()?;
    if md.len() != expect_len {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file changed since scan",
        ));
    }
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut read = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read += n as u64;
    }
    Ok((read, hasher.finalize()))
}

/// Read until the buffer is full or EOF; returns bytes read.
fn read_fully(f: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0usize;
    loop {
        let n = f.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
        if filled == buf.len() {
            break;
        }
    }
    Ok(filled)
}

#[cfg(test)]
#[path = "reclaim_tests.rs"]
mod tests;
