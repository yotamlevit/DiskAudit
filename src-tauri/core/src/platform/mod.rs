// Platform layer. Every OS-shaped assumption the scanner and the reclaim
// detector make lives behind this module:
//
//   * how a file's on-disk size, hardlink identity and mtime are read
//     (`stat_file`, `link_alloc`, `dir_meta`);
//   * which directories a scan may descend into (`ScanPolicy`): other
//     volumes, cloud placeholders, aliases of content counted elsewhere;
//   * how the scan root is resolved (`resolve_root`) and where "home" is;
//   * WHERE each OS keeps caches, trash, package downloads and installers
//     (`reclaim_site`, `INSTALLER_EXTS`, `stale_excluded`).
//
// One implementation module per OS family:
//
//   macos.rs    macOS / APFS (volume groups, firmlinks, FileProvider mounts)
//   linux.rs    Linux and the other non-Apple Unixes (XDG layout)
//   windows.rs  Windows / NTFS (allocation size and file IDs via a
//               read-attributes handle; reparse points are never followed)
//
// The two Unix modules are both COMPILED on every Unix so their pure path
// logic is unit-tested wherever the tests run; only the active one is used.
// No non-test code outside this directory may contain `cfg(target_os)` or
// `std::os::*` — port by editing here.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[cfg(unix)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
mod linux;
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(all(unix, not(target_os = "macos")))]
use linux as os;
#[cfg(target_os = "macos")]
use macos as os;
#[cfg(windows)]
use windows as os;

// ----- File metadata -------------------------------------------------------

/// What the scanner needs to know about one file, however the OS spells it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileMeta {
    /// Allocated bytes: what deleting the file would free. Sparse,
    /// compressed and cloud-placeholder files report their real footprint.
    pub alloc: u64,
    /// Logical length.
    pub logical: u64,
    /// Modification time, unix seconds (0 when unknown).
    pub mtime: i64,
    /// Number of hard links to the file's data.
    pub nlink: u64,
    /// (volume, file) identity for hardlink de-duplication.
    pub id: Option<(u64, u64)>,
}

/// Stat one non-directory entry WITHOUT following a link.
pub fn stat_file(path: &Path) -> std::io::Result<FileMeta> {
    os::stat_file(path)
}

/// Allocated bytes of a symlink itself (never its target). 0 if unknown.
pub fn link_alloc(path: &Path) -> u64 {
    os::link_alloc(path)
}

/// What the walk needs to know about a directory before descending.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DirMeta {
    /// Device/volume id, where the OS needs one to detect a mount boundary.
    /// `None` = unknown or not applicable (Windows: mount points are reparse
    /// points, which the walk never follows).
    pub dev: Option<u64>,
    /// Blocks the directory's own entry table occupies — freed when the
    /// directory is deleted, and what `du` counts for it. 0 on APFS (entries
    /// live in the volume's B-tree) and on Windows (not queried); typically
    /// 4 KiB or more per directory on ext4, XFS and friends.
    pub alloc: u64,
}

/// Stat a directory without following a link. Default (zeroes) on failure:
/// the directory's own read error is reported by the walk itself.
pub fn dir_meta(path: &Path) -> DirMeta {
    os::dir_meta(path)
}

#[cfg(unix)]
pub(crate) mod unix_meta {
    use super::{DirMeta, FileMeta};
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    pub fn stat_file(path: &Path) -> std::io::Result<FileMeta> {
        let md = std::fs::symlink_metadata(path)?;
        Ok(FileMeta {
            // st_blocks is always in 512-byte units, whatever the fs block.
            alloc: md.blocks() * 512,
            logical: md.len(),
            mtime: md.mtime(),
            nlink: md.nlink(),
            id: Some((md.dev(), md.ino())),
        })
    }

    pub fn link_alloc(path: &Path) -> u64 {
        std::fs::symlink_metadata(path)
            .map(|md| md.blocks() * 512)
            .unwrap_or(0)
    }

    pub fn dir_meta(path: &Path) -> DirMeta {
        match std::fs::symlink_metadata(path) {
            Ok(md) => DirMeta {
                dev: Some(md.dev()),
                alloc: md.blocks() * 512,
            },
            Err(_) => DirMeta::default(),
        }
    }

    /// Device of a path, following links (scan roots, mount points).
    pub fn device_of(path: &Path) -> Option<u64> {
        std::fs::metadata(path).ok().map(|md| md.dev())
    }
}

// ----- Scan policy ---------------------------------------------------------

/// Why a directory was excluded from the scan. Skipped directories still
/// appear in results as zero-size nodes so the user can see what was left out.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Cloud-sync mount; bytes are not (all) on local disk and metadata
    /// calls inside can hang on network I/O.
    CloudStorage,
    /// Lives on a different filesystem/device than the scan root.
    OtherVolume,
    /// A second path to content that is already counted elsewhere in the
    /// same scan (macOS: the APFS Data volume mount on a `/` scan).
    FirmlinkAlias,
}

/// Decides, per discovered directory, whether the scanner descends into it.
pub struct ScanPolicy {
    /// Devices the walk may traverse. Empty set = no device filtering
    /// (the root could not be stat'ed, or the OS has no use for it).
    allowed_devs: HashSet<u64>,
    /// Exact paths whose content is already counted elsewhere.
    alias_paths: Vec<PathBuf>,
}

impl ScanPolicy {
    /// Build the policy for a scan rooted at `root` (already resolved).
    pub fn for_root(root: &Path) -> Self {
        let (allowed_devs, alias_paths) = os::root_policy(root);
        Self {
            allowed_devs,
            alias_paths,
        }
    }

    /// Test-only constructor with explicit rules.
    #[cfg(test)]
    pub fn with_rules(allowed_devs: HashSet<u64>, alias_paths: Vec<PathBuf>) -> Self {
        Self {
            allowed_devs,
            alias_paths,
        }
    }

    /// Should the walk skip this child directory? `dev` is the directory's
    /// device if known. The scan ROOT is never passed here — scanning a
    /// cloud dir or another volume directly is an explicit user choice and
    /// is honored.
    pub fn skip_reason(&self, path: &Path, dev: Option<u64>) -> Option<SkipReason> {
        if os::is_cloud_sync_dir(path) {
            return Some(SkipReason::CloudStorage);
        }
        if self.alias_paths.iter().any(|a| a == path) {
            return Some(SkipReason::FirmlinkAlias);
        }
        if !self.allowed_devs.is_empty() {
            if let Some(d) = dev {
                if !self.allowed_devs.contains(&d) {
                    return Some(SkipReason::OtherVolume);
                }
            }
        }
        None
    }
}

/// A user-facing note about what "scanning this root" means, when the
/// platform gives it non-obvious semantics.
pub fn root_note(root: &Path) -> Option<String> {
    os::root_note(root)
}

/// Turn what the user typed, picked or dropped into the absolute path the
/// scan is keyed on. Never fails: an unresolvable path comes back as given
/// and the caller's metadata check reports the real error.
pub fn resolve_root(input: &Path) -> PathBuf {
    os::resolve_root(input)
}

/// The user's home directory.
pub fn home_dir() -> Option<PathBuf> {
    os::home_dir()
}

/// Facts the UI needs to speak the host's language (file-manager name,
/// path separator, which shell the generated scripts target). Mirrored by
/// hand in src/types.ts.
#[derive(Serialize, Clone, Debug)]
pub struct PlatformInfo {
    /// "macos" | "windows" | "linux"
    pub os: &'static str,
    pub home: String,
}

pub fn info() -> PlatformInfo {
    PlatformInfo {
        os: os::OS,
        home: home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

// ----- Reclaimable-space locations -----------------------------------------
//
// Everything the reclaim detector knows about WHERE an OS keeps caches,
// developer artifacts, trash and backups lives in the OS modules. What those
// findings mean (labels, confidence, safety wording) lives in reclaim.rs;
// this layer only answers "is this path one of the well-known spots?".
// Matching is deliberately exact: a folder named `Library/Caches` deep
// inside a project must NOT match.

/// What a well-known reclaimable location holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReclaimKind {
    /// Per-app caches (`~/Library/Caches/*`, `~/.cache/*`, browser caches).
    AppCache,
    /// Developer tool caches (npm, cargo, go, gradle, pip, NuGet…).
    ToolCache,
    /// OS package-manager / updater downloads (apt, dnf, pacman, Windows
    /// Update). Regenerable, but usually needs admin rights to clear.
    PackageCache,
    /// Temp directories (Windows `%TEMP%`). Not regenerated, just unneeded
    /// once nothing is mid-install — treated as "careful", not "safe".
    TempFiles,
    /// Xcode regenerable state (DerivedData, DeviceSupport, simulator caches).
    Xcode,
    /// Trash / Recycle Bin contents — deleting is permanent.
    Trash,
    /// iOS/iPadOS device backups — NOT regenerable unless the device syncs
    /// again; treated as "gone forever", never as a cache.
    IosBackup,
    /// Xcode build archives — builds of specific past commits; needed to
    /// symbolicate old crash logs. "Gone forever", not regenerable.
    XcodeArchive,
}

/// How a well-known location turns into findings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReclaimSite {
    /// The directory itself is one finding.
    SelfIsFinding(ReclaimKind),
    /// Each direct child directory is its own finding (per-app granularity).
    ChildrenAreFindings(ReclaimKind),
    /// Scan this subtree's files for used installers.
    InstallerDir,
}

/// Is `path` a well-known reclaimable location? `root` is the scan root
/// (used for per-volume trash folders). Exact matching only.
pub fn reclaim_site(path: &Path, root: &Path) -> Option<ReclaimSite> {
    os::reclaim_site(path, root)
}

/// Lowercase, dot-prefixed installer extensions worth flagging in Downloads.
pub fn installer_exts() -> &'static [&'static str] {
    os::INSTALLER_EXTS
}

/// What the OS calls its trash ("Trash" / "Recycle Bin").
pub fn trash_name() -> &'static str {
    os::TRASH_NAME
}

/// Must the "stale large file" hint stay silent for this file? `rel` is the
/// file's path below the scan root. True for app-managed and system
/// territory, where an old mtime says nothing about whether the file is
/// still needed.
pub fn stale_excluded(root: &Path, rel: &Path) -> bool {
    os::stale_excluded(root, rel)
}

/// Developer-tool caches that sit at the same home-relative path on every
/// OS: the documented locations those tools rebuild on demand.
pub(crate) const COMMON_HOME_SITES: &[(&str, ReclaimSite)] = &[
    (
        ".cargo/registry/cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        ".cargo/git/checkouts",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        "go/pkg/mod/cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        ".gradle/caches",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
];

/// If `path` ends with the `/`-separated components of `rel`, return what
/// precedes them. Component-wise (never substring), optionally ASCII
/// case-insensitive for case-preserving filesystems.
pub(crate) fn strip_rel_suffix<'a>(
    path: &'a Path,
    rel: &str,
    ignore_case: bool,
) -> Option<&'a Path> {
    let mut base = path;
    for want in rel.rsplit('/') {
        let have = base.file_name()?;
        let same = if ignore_case {
            have.to_str().is_some_and(|h| h.eq_ignore_ascii_case(want))
        } else {
            have == want
        };
        if !same {
            return None;
        }
        base = base.parent()?;
    }
    Some(base)
}

/// First entry of `table` whose home-relative path `path` ends with, on a
/// base that `is_home` accepts.
pub(crate) fn match_home_site(
    path: &Path,
    table: &[(&str, ReclaimSite)],
    ignore_case: bool,
    is_home: impl Fn(&Path) -> bool,
) -> Option<ReclaimSite> {
    table.iter().find_map(|(rel, site)| {
        strip_rel_suffix(path, rel, ignore_case)
            .filter(|base| is_home(base))
            .map(|_| *site)
    })
}

/// `\\?\C:\dir` → `C:\dir`, `\\?\UNC\server\share` → `\\server\share`.
/// Windows' verbatim form is what canonicalization returns; it is correct
/// but unreadable, and Explorer and PowerShell don't accept it everywhere.
/// Pure string logic so it is tested on every OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return rest.to_string();
        }
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_devices_and_aliases() {
        let policy = ScanPolicy::with_rules(HashSet::from([10, 20]), vec![PathBuf::from("/alias")]);
        assert_eq!(policy.skip_reason(Path::new("/a"), Some(10)), None);
        assert_eq!(policy.skip_reason(Path::new("/a"), Some(20)), None);
        assert_eq!(
            policy.skip_reason(Path::new("/a"), Some(30)),
            Some(SkipReason::OtherVolume)
        );
        assert_eq!(
            policy.skip_reason(Path::new("/alias"), Some(20)),
            Some(SkipReason::FirmlinkAlias)
        );
        // Unknown device: give the walk the benefit of the doubt.
        assert_eq!(policy.skip_reason(Path::new("/a"), None), None);
    }

    #[test]
    fn empty_dev_set_disables_filtering() {
        let policy = ScanPolicy::with_rules(HashSet::new(), Vec::new());
        assert_eq!(policy.skip_reason(Path::new("/a"), Some(42)), None);
    }

    #[test]
    fn rel_suffix_is_component_wise() {
        let p = Path::new("/home/a/.cargo/registry/cache");
        assert_eq!(
            strip_rel_suffix(p, ".cargo/registry/cache", false),
            Some(Path::new("/home/a"))
        );
        assert_eq!(
            strip_rel_suffix(p, "registry/cache", false),
            Some(Path::new("/home/a/.cargo"))
        );
        // Not a substring match.
        assert_eq!(strip_rel_suffix(p, "gistry/cache", false), None);
        assert_eq!(strip_rel_suffix(p, ".Cargo/Registry/Cache", false), None);
        assert_eq!(
            strip_rel_suffix(p, ".Cargo/Registry/Cache", true),
            Some(Path::new("/home/a"))
        );
        // Longer than the path itself.
        assert_eq!(strip_rel_suffix(Path::new("/a"), "x/y/a", false), None);
    }

    #[test]
    fn verbatim_prefixes_are_stripped_only_when_safe() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\a"), r"C:\Users\a");
        assert_eq!(strip_verbatim(r"\\?\UNC\nas\share\x"), r"\\nas\share\x");
        assert_eq!(strip_verbatim(r"C:\Users\a"), r"C:\Users\a");
        // Device paths have no plain spelling; leave them alone.
        assert_eq!(strip_verbatim(r"\\?\Volume{abc}\x"), r"\\?\Volume{abc}\x");
    }

    #[test]
    fn stat_file_reports_real_files() {
        let dir = std::env::temp_dir().join(format!("diskaudit-plat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        std::fs::write(&f, vec![7u8; 100_000]).unwrap();
        let m = stat_file(&f).unwrap();
        assert_eq!(m.logical, 100_000);
        assert!(m.alloc >= 100_000, "allocated {} < logical", m.alloc);
        assert!(
            m.alloc < 100_000 + 1024 * 1024,
            "allocated {} is absurd",
            m.alloc
        );
        assert_eq!(m.nlink, 1);
        assert!(m.mtime > 1_600_000_000);

        std::fs::hard_link(&f, dir.join("b.bin")).unwrap();
        let a = stat_file(&f).unwrap();
        let b = stat_file(&dir.join("b.bin")).unwrap();
        assert_eq!(a.nlink, 2);
        assert!(a.id.is_some());
        assert_eq!(a.id, b.id, "hardlinks share an identity");

        assert!(stat_file(&dir.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
