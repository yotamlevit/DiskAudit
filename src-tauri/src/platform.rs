// Platform-specific scan policy. Every OS-shaped assumption the scanner makes
// lives behind this module: which devices a scan may cross into, which paths
// are skipped (cloud placeholders, firmlink aliases), and how the user's home
// is resolved. Porting to Windows/Linux means reimplementing these functions,
// not editing the scanner.
//
// Current implementation targets macOS / APFS:
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

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Why a directory was excluded from the scan. Skipped directories still
/// appear in results as zero-size nodes so the user can see what was left out.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// FileProvider-backed cloud sync dir; bytes are not (all) on local disk
    /// and metadata calls inside can hang on network I/O.
    CloudStorage,
    /// Lives on a different filesystem/device than the scan root.
    OtherVolume,
    /// APFS Data volume mount whose content is already counted at its
    /// firmlinked locations (/Users, /Applications, …) when scanning `/`.
    FirmlinkAlias,
}

const DATA_VOLUME: &str = "/System/Volumes/Data";

/// Decides, per discovered directory, whether the scanner descends into it.
pub struct ScanPolicy {
    /// Devices the walk may traverse. Empty set = no device filtering
    /// (used when the root itself could not be stat'ed).
    allowed_devs: HashSet<u64>,
    /// Exact paths whose content is already counted elsewhere via firmlinks.
    alias_paths: Vec<PathBuf>,
}

impl ScanPolicy {
    /// Build the policy for a scan rooted at `root` (canonicalized).
    pub fn for_root(root: &Path) -> Self {
        let mut allowed_devs = HashSet::new();
        if let Ok(md) = std::fs::metadata(root) {
            use std::os::unix::fs::MetadataExt;
            allowed_devs.insert(md.dev());
        }
        let mut alias_paths = Vec::new();
        if root == Path::new("/") {
            // Allow the Data volume's device (differs from `/` on older
            // macOS) and exclude its mount point (its content shows up at
            // the firmlinked paths instead).
            if let Ok(md) = std::fs::metadata(DATA_VOLUME) {
                use std::os::unix::fs::MetadataExt;
                allowed_devs.insert(md.dev());
                alias_paths.push(PathBuf::from(DATA_VOLUME));
            }
        }
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
    /// st_dev if it could be stat'ed. The scan ROOT is never passed here —
    /// scanning a cloud dir or another volume directly is an explicit user
    /// choice and is honored.
    pub fn skip_reason(&self, path: &Path, dev: Option<u64>) -> Option<SkipReason> {
        if is_cloud_sync_dir(path) {
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

/// The user's home directory.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// True for the per-user FileProvider cloud-sync mount points themselves:
/// `<home>/Library/CloudStorage` and `<home>/Library/Mobile Documents`, for
/// any home under /Users or the current $HOME. Deliberately exact — a folder
/// coincidentally named `Library/CloudStorage` deep inside a project is NOT
/// skipped (the baseline substring check would have skipped it).
fn is_cloud_sync_dir(path: &Path) -> bool {
    let mut comps = path.components();
    let (Some(last), Some(prev)) = (comps.next_back(), comps.next_back()) else {
        return false;
    };
    let last = last.as_os_str();
    let prev = prev.as_os_str();
    if prev != "Library" || (last != "CloudStorage" && last != "Mobile Documents") {
        return false;
    }
    // `path` = <base>/Library/<last>; require <base> to look like a home dir.
    let base: &Path = match path.parent().and_then(|p| p.parent()) {
        Some(b) => b,
        None => return false,
    };
    if base.parent() == Some(Path::new("/Users")) {
        return true;
    }
    home_dir().map(|h| h == base).unwrap_or(false)
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
    fn policy_devices_and_aliases() {
        let policy = ScanPolicy::with_rules(
            HashSet::from([10, 20]),
            vec![PathBuf::from("/System/Volumes/Data")],
        );
        assert_eq!(policy.skip_reason(Path::new("/a"), Some(10)), None);
        assert_eq!(policy.skip_reason(Path::new("/a"), Some(20)), None);
        assert_eq!(
            policy.skip_reason(Path::new("/a"), Some(30)),
            Some(SkipReason::OtherVolume)
        );
        assert_eq!(
            policy.skip_reason(Path::new("/System/Volumes/Data"), Some(20)),
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
}
