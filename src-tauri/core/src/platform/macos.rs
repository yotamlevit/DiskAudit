// macOS / APFS policy.
//
//   * APFS volume groups: since Catalina "the drive" is two volumes — a sealed
//     read-only System volume mounted at `/` and a Data volume mounted at
//     `/System/Volumes/Data`, stitched together with firmlinks so `/Users`,
//     `/Applications`, `/private` etc. transparently show Data content.
//     Scanning `/` therefore needs BOTH devices allowed (on older macOS they
//     report different st_dev — crossing into `/Users` must not be treated as
//     leaving the disk) AND `/System/Volumes/Data` itself excluded, because
//     everything in it is already reachable at its firmlinked path (on recent
//     macOS both mounts even report the same st_dev, so without the exclusion
//     a `/` scan counts all user data twice).
//   * Cloud-sync dirs (`~/Library/CloudStorage`, `~/Library/Mobile Documents`)
//     are FileProvider mounts: same device as $HOME, but stat() inside them
//     can block on network I/O and their bytes are not local. Skipped.
//   * Any other device crossing (USB, network mounts, disk images, simulator
//     volumes) is skipped and reported, never silently dropped.

use super::{match_home_site, unix_meta, ReclaimKind, ReclaimSite, COMMON_HOME_SITES};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[allow(unused_imports)] // unused where linux.rs is the active module
pub use super::unix_meta::{dir_device, link_alloc, stat_file};

pub const OS: &str = "macos";
pub const TRASH_NAME: &str = "Trash";
pub const INSTALLER_EXTS: &[&str] = &[".dmg", ".pkg", ".xip", ".ipsw"];

const DATA_VOLUME: &str = "/System/Volumes/Data";

pub fn root_policy(root: &Path) -> (HashSet<u64>, Vec<PathBuf>) {
    let mut allowed_devs = HashSet::new();
    if let Some(dev) = unix_meta::device_of(root) {
        allowed_devs.insert(dev);
    }
    let mut alias_paths = Vec::new();
    if root == Path::new("/") {
        // Allow the Data volume's device (differs from `/` on older macOS)
        // and exclude its mount point (its content shows up at the
        // firmlinked paths instead).
        if let Some(dev) = unix_meta::device_of(Path::new(DATA_VOLUME)) {
            allowed_devs.insert(dev);
            alias_paths.push(PathBuf::from(DATA_VOLUME));
        }
    }
    (allowed_devs, alias_paths)
}

pub fn root_note(root: &Path) -> Option<String> {
    if root == Path::new("/") {
        Some(
            "Scanning the startup disk: the System and Data volumes are shown \
             merged at their usual locations, the way Finder presents them. \
             Other volumes (Preboot, VM/swap, external disks) are listed as \
             skipped."
                .to_string(),
        )
    } else {
        None
    }
}

pub fn resolve_root(input: &Path) -> PathBuf {
    input.canonicalize().unwrap_or_else(|_| input.to_path_buf())
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Does `base` look like a user home directory? True for any direct child of
/// /Users and for the current $HOME (which may live elsewhere).
pub fn looks_like_home(base: &Path) -> bool {
    if base.parent() == Some(Path::new("/Users")) {
        return true;
    }
    home_dir().map(|h| h == base).unwrap_or(false)
}

/// True for the per-user FileProvider cloud-sync mount points themselves:
/// `<home>/Library/CloudStorage` and `<home>/Library/Mobile Documents`, for
/// any home under /Users or the current $HOME. Deliberately exact — a folder
/// coincidentally named `Library/CloudStorage` deep inside a project is NOT
/// skipped.
pub fn is_cloud_sync_dir(path: &Path) -> bool {
    ["Library/CloudStorage", "Library/Mobile Documents"]
        .iter()
        .any(|rel| super::strip_rel_suffix(path, rel, false).is_some_and(looks_like_home))
}

/// Well-known spots relative to a home directory. `iOS DeviceSupport` and
/// friends regenerate when a device reconnects.
const HOME_SITES: &[(&str, ReclaimSite)] = &[
    (
        "Library/Caches",
        ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache),
    ),
    (
        ".cache",
        ReclaimSite::ChildrenAreFindings(ReclaimKind::ToolCache),
    ),
    (
        ".npm/_cacache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        "Library/Developer/Xcode/DerivedData",
        ReclaimSite::SelfIsFinding(ReclaimKind::Xcode),
    ),
    (
        "Library/Developer/Xcode/iOS DeviceSupport",
        ReclaimSite::SelfIsFinding(ReclaimKind::Xcode),
    ),
    (
        "Library/Developer/Xcode/watchOS DeviceSupport",
        ReclaimSite::SelfIsFinding(ReclaimKind::Xcode),
    ),
    (
        "Library/Developer/Xcode/tvOS DeviceSupport",
        ReclaimSite::SelfIsFinding(ReclaimKind::Xcode),
    ),
    (
        "Library/Developer/CoreSimulator/Caches",
        ReclaimSite::SelfIsFinding(ReclaimKind::Xcode),
    ),
    (
        "Library/Developer/Xcode/Archives",
        ReclaimSite::SelfIsFinding(ReclaimKind::XcodeArchive),
    ),
    (
        "Library/Application Support/MobileSync/Backup",
        ReclaimSite::ChildrenAreFindings(ReclaimKind::IosBackup),
    ),
    (".Trash", ReclaimSite::SelfIsFinding(ReclaimKind::Trash)),
    ("Downloads", ReclaimSite::InstallerDir),
];

pub fn reclaim_site(path: &Path, root: &Path) -> Option<ReclaimSite> {
    // System-wide caches (visible when scanning `/`).
    if path == Path::new("/Library/Caches") {
        return Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache));
    }
    // Per-volume Trash at the top of a scanned volume.
    if path.file_name().is_some_and(|n| n == ".Trashes") && path.parent() == Some(root) {
        return Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash));
    }
    // Home-relative spots, for any home-shaped base (/Users/* or $HOME).
    match_home_site(path, HOME_SITES, false, looks_like_home)
        .or_else(|| match_home_site(path, COMMON_HOME_SITES, false, looks_like_home))
}

/// Anything under a `Library` is app-managed state: old there means
/// "written once", not "forgotten".
pub fn stale_excluded(_root: &Path, rel: &Path) -> bool {
    rel.components().any(|c| c.as_os_str() == "Library")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_sync_dir_detection_is_exact() {
        assert!(is_cloud_sync_dir(Path::new(
            "/Users/alice/Library/CloudStorage"
        )));
        assert!(is_cloud_sync_dir(Path::new(
            "/Users/alice/Library/Mobile Documents"
        )));
        // Inside the mount is handled by not descending, not by re-matching.
        assert!(!is_cloud_sync_dir(Path::new(
            "/Users/alice/Library/CloudStorage/Dropbox"
        )));
        // A look-alike folder inside a project must not be skipped.
        assert!(!is_cloud_sync_dir(Path::new(
            "/Users/alice/backup/Users/alice/Library/CloudStorage"
        )));
        assert!(!is_cloud_sync_dir(Path::new("/Users/alice/Library")));
    }

    #[test]
    fn reclaim_sites_match_only_home_shaped_bases() {
        let root = Path::new("/Users/alice");
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/Library/Caches"), root),
            Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache))
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/.Trash"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash))
        );
        assert_eq!(
            reclaim_site(
                Path::new("/Users/alice/Library/Developer/Xcode/DerivedData"),
                root
            ),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Xcode))
        );
        assert_eq!(
            reclaim_site(
                Path::new("/Users/alice/Library/Application Support/MobileSync/Backup"),
                root
            ),
            Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::IosBackup))
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/.cargo/registry/cache"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache))
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/Downloads"), root),
            Some(ReclaimSite::InstallerDir)
        );

        // Near-misses that must NOT match: same names, wrong base.
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/project/Library/Caches"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/backup/.Trash"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/website/Downloads"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/dev/.cache"), root),
            None
        );
        // A DerivedData copied somewhere else is someone's data, not Xcode's.
        assert_eq!(
            reclaim_site(Path::new("/Users/alice/old-mac/DerivedData"), root),
            None
        );
    }

    #[test]
    fn volume_trashes_only_at_scan_root() {
        let vol = Path::new("/Volumes/Backup");
        assert_eq!(
            reclaim_site(Path::new("/Volumes/Backup/.Trashes"), vol),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash))
        );
        assert_eq!(
            reclaim_site(Path::new("/Volumes/Backup/deep/.Trashes"), vol),
            None
        );
        // System-wide caches match when scanning /.
        assert_eq!(
            reclaim_site(Path::new("/Library/Caches"), Path::new("/")),
            Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache))
        );
    }

    #[test]
    fn stale_hint_is_silent_under_any_library() {
        let root = Path::new("/Users/alice");
        assert!(stale_excluded(root, Path::new("Library/Mail/big.mbox")));
        assert!(stale_excluded(root, Path::new("proj/Library/x.bin")));
        assert!(!stale_excluded(root, Path::new("Movies/old.mov")));
    }
}
