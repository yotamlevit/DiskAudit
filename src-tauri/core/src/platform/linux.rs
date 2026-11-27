// Linux (and other non-Apple Unix) policy.
//
//   * Sizes come from st_blocks, exactly as on macOS, so sparse files, btrfs
//     / zfs compression and holes are all reported at their real footprint.
//   * A scan stays on the root's filesystem. That one rule keeps it out of
//     /proc, /sys, /dev and /run (virtual, and /proc/kcore "is" 128 TB),
//     out of network and removable mounts, and out of container overlays.
//     The cost: a separately mounted /home or /boot is listed as skipped on
//     a `/` scan, and so is every btrfs subvolume (each has its own st_dev).
//     They are reported, never silently dropped — scan them directly.
//   * There is no cloud-sync mount convention to special-case: FUSE-backed
//     sync clients (rclone, gvfs, …) are different devices and fall under
//     the rule above.
//   * Reclaimable locations follow the XDG base-directory layout.

use super::{
    match_home_site, strip_rel_suffix, unix_meta, ReclaimKind, ReclaimSite, COMMON_HOME_SITES,
};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

#[allow(unused_imports)] // unused where macos.rs is the active module
pub use super::unix_meta::{dir_device, link_alloc, stat_file};

pub const OS: &str = "linux";
pub const TRASH_NAME: &str = "Trash";
/// `.AppImage` is deliberately absent: the file IS the application.
pub const INSTALLER_EXTS: &[&str] = &[".deb", ".rpm", ".iso"];

pub fn root_policy(root: &Path) -> (HashSet<u64>, Vec<PathBuf>) {
    let mut allowed_devs = HashSet::new();
    if let Some(dev) = unix_meta::device_of(root) {
        allowed_devs.insert(dev);
    }
    (allowed_devs, Vec::new())
}

pub fn root_note(root: &Path) -> Option<String> {
    if root == Path::new("/") {
        Some(
            "Scanning the root filesystem only. Anything mounted separately — \
             a /home or /boot partition, btrfs subvolumes, external and \
             network drives, and the virtual /proc, /sys and /dev — is listed \
             as skipped. Scan those locations directly to see inside them."
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

/// Any direct child of /home, root's home, or the current $HOME.
pub fn looks_like_home(base: &Path) -> bool {
    if base.parent() == Some(Path::new("/home")) || base == Path::new("/root") {
        return true;
    }
    home_dir().map(|h| h == base).unwrap_or(false)
}

pub fn is_cloud_sync_dir(_path: &Path) -> bool {
    false
}

const HOME_SITES: &[(&str, ReclaimSite)] = &[
    // XDG cache home: one finding per application.
    (
        ".cache",
        ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache),
    ),
    (
        ".npm/_cacache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    // freedesktop.org trash spec, home trash.
    (
        ".local/share/Trash",
        ReclaimSite::SelfIsFinding(ReclaimKind::Trash),
    ),
    ("Downloads", ReclaimSite::InstallerDir),
];

/// Package-manager download caches. Each is cleared safely by its own tool
/// (`apt clean`, `dnf clean all`, `pacman -Sc`, `zypper clean`).
const SYSTEM_PACKAGE_CACHES: &[&str] = &[
    "/var/cache/apt/archives",
    "/var/cache/dnf",
    "/var/cache/yum",
    "/var/cache/pacman/pkg",
    "/var/cache/zypp/packages",
];

pub fn reclaim_site(path: &Path, root: &Path) -> Option<ReclaimSite> {
    if SYSTEM_PACKAGE_CACHES.iter().any(|p| path == Path::new(p)) {
        return Some(ReclaimSite::SelfIsFinding(ReclaimKind::PackageCache));
    }
    // Per-volume trash at the top of a scanned volume: `.Trash-<uid>`.
    if path.parent() == Some(root) {
        if let Some(uid) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix(".Trash-"))
        {
            if !uid.is_empty() && uid.bytes().all(|b| b.is_ascii_digit()) {
                return Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash));
            }
        }
    }
    // Flatpak per-app cache: <home>/.var/app/<app-id>/cache.
    if let Some(app_dir) = strip_rel_suffix(path, "cache", false) {
        if app_dir
            .parent()
            .and_then(|apps| strip_rel_suffix(apps, ".var/app", false))
            .is_some_and(looks_like_home)
        {
            return Some(ReclaimSite::SelfIsFinding(ReclaimKind::AppCache));
        }
    }
    match_home_site(path, HOME_SITES, false, looks_like_home)
        .or_else(|| match_home_site(path, COMMON_HOME_SITES, false, looks_like_home))
}

/// Top-level directories that belong to the OS and its package manager.
const SYSTEM_TOP_LEVEL: &[&str] = &[
    "bin", "boot", "etc", "lib", "lib32", "lib64", "libx32", "opt", "sbin", "snap", "srv", "usr",
    "var",
];

/// Silent inside dot-directories (app-managed state: ~/.local, ~/.config,
/// ~/.var, ~/.steam…) and, on a `/` scan, inside the OS's own tree.
pub fn stale_excluded(root: &Path, rel: &Path) -> bool {
    let mut comps: Vec<Component> = rel.components().collect();
    comps.pop(); // the file itself may be a dotfile; only its location counts
    if comps
        .iter()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    {
        return true;
    }
    if root == Path::new("/") {
        if let Some(first) = comps.first() {
            return SYSTEM_TOP_LEVEL.iter().any(|s| first.as_os_str() == *s);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xdg_sites_match_only_home_shaped_bases() {
        let root = Path::new("/home/alice");
        assert_eq!(
            reclaim_site(Path::new("/home/alice/.cache"), root),
            Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache))
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/.local/share/Trash"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash))
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/.cargo/registry/cache"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache))
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/Downloads"), root),
            Some(ReclaimSite::InstallerDir)
        );
        assert_eq!(
            reclaim_site(Path::new("/root/.cache"), Path::new("/")),
            Some(ReclaimSite::ChildrenAreFindings(ReclaimKind::AppCache))
        );
        assert_eq!(
            reclaim_site(
                Path::new("/home/alice/.var/app/org.mozilla.firefox/cache"),
                root
            ),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::AppCache))
        );

        // Same names, wrong base.
        assert_eq!(
            reclaim_site(Path::new("/home/alice/project/.cache"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/site/Downloads"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/old/.local/share/Trash"), root),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/home/alice/x/.var/app/org.a.b/cache"), root),
            None
        );
        // The flatpak rule needs the app-id level: `.var/app/cache` is not it.
        assert_eq!(
            reclaim_site(Path::new("/home/alice/.var/app/cache"), root),
            None
        );
    }

    #[test]
    fn volume_trash_and_package_caches() {
        let vol = Path::new("/mnt/data");
        assert_eq!(
            reclaim_site(Path::new("/mnt/data/.Trash-1000"), vol),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash))
        );
        assert_eq!(
            reclaim_site(Path::new("/mnt/data/deep/.Trash-1000"), vol),
            None
        );
        assert_eq!(reclaim_site(Path::new("/mnt/data/.Trash-"), vol), None);
        assert_eq!(
            reclaim_site(Path::new("/mnt/data/.Trash-backup"), vol),
            None
        );
        assert_eq!(
            reclaim_site(Path::new("/var/cache/apt/archives"), Path::new("/")),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::PackageCache))
        );
        assert_eq!(
            reclaim_site(Path::new("/srv/var/cache/apt/archives"), Path::new("/")),
            None
        );
    }

    #[test]
    fn stale_hint_skips_app_state_and_system_trees() {
        let home = Path::new("/home/alice");
        assert!(stale_excluded(
            home,
            Path::new(".local/share/Steam/game.pak")
        ));
        assert!(stale_excluded(home, Path::new("proj/.git/objects/pack/p")));
        assert!(!stale_excluded(home, Path::new("Videos/old.mkv")));
        // A dotFILE in an ordinary folder is still the user's own file.
        assert!(!stale_excluded(home, Path::new("Videos/.hidden.mkv")));
        // `usr` only means "system" at the top of a `/` scan.
        assert!(stale_excluded(Path::new("/"), Path::new("usr/lib/big.so")));
        assert!(!stale_excluded(
            Path::new("/"),
            Path::new("home/alice/a.iso")
        ));
        assert!(!stale_excluded(home, Path::new("usr/big.bin")));
    }

    #[test]
    fn root_scan_explains_mount_boundaries() {
        assert!(root_note(Path::new("/")).is_some());
        assert!(root_note(Path::new("/home/alice")).is_none());
    }
}
