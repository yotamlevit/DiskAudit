// Windows / NTFS policy.
//
//   * Size on disk is the file's ALLOCATION size, which std does not expose.
//     `stat_file` opens the file with FILE_READ_ATTRIBUTES only — the same
//     metadata-only handle std::fs::metadata uses internally, never a data
//     handle — and asks for FILE_STANDARD_INFO. That number already accounts
//     for NTFS compression, sparse files, and cloud placeholders (a
//     dehydrated OneDrive file allocates 0 bytes), so cloud folders need no
//     skip rule here: enumerating metadata never triggers a download, and
//     the duplicate pass only reads files that occupy real bytes.
//   * Hardlinks (WinSxS is full of them) are de-duplicated by
//     (volume serial number, file index) from the same handle.
//   * Junctions, directory symlinks and volume mount points are reparse
//     points; std reports them as symlinks and the walk never follows them.
//     A scan therefore cannot leave its volume, and needs no device filter.
//   * Paths are compared ASCII-case-insensitively (NTFS preserves case but
//     does not distinguish it).

use super::{
    match_home_site, strip_rel_suffix, DirMeta, FileMeta, ReclaimKind, ReclaimSite,
    COMMON_HOME_SITES,
};
use std::collections::HashSet;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::{
    FileStandardInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
};

pub const OS: &str = "windows";
pub const TRASH_NAME: &str = "Recycle Bin";
/// `.exe` is deliberately absent: Downloads is where portable apps live.
pub const INSTALLER_EXTS: &[&str] = &[".msi", ".msix", ".msixbundle", ".appx", ".iso"];

/// Seconds between 1601-01-01 (FILETIME epoch) and 1970-01-01.
const FILETIME_UNIX_OFFSET_SECS: i64 = 11_644_473_600;

pub fn stat_file(path: &Path) -> std::io::Result<FileMeta> {
    // Metadata-only handle: no read, write or delete access is requested,
    // every share mode is granted so the open never blocks another process,
    // and OPEN_REPARSE_POINT stats a link itself rather than its target.
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let handle = file.as_raw_handle();

    // SAFETY: `handle` is a live file handle owned by `file` for the whole
    // block; both out-parameters are plain-old-data structs of exactly the
    // size passed, fully written by the call on success.
    let (basic, standard) = unsafe {
        let mut basic: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(handle as _, &mut basic) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut standard: FILE_STANDARD_INFO = std::mem::zeroed();
        if GetFileInformationByHandleEx(
            handle as _,
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        (basic, standard)
    };

    let filetime = ((basic.ftLastWriteTime.dwHighDateTime as u64) << 32)
        | basic.ftLastWriteTime.dwLowDateTime as u64;
    Ok(FileMeta {
        alloc: standard.AllocationSize.max(0) as u64,
        logical: standard.EndOfFile.max(0) as u64,
        mtime: filetime_to_unix(filetime),
        nlink: standard.NumberOfLinks as u64,
        id: Some((
            basic.dwVolumeSerialNumber as u64,
            ((basic.nFileIndexHigh as u64) << 32) | basic.nFileIndexLow as u64,
        )),
    })
}

/// 100-ns ticks since 1601 → unix seconds. 0 (unknown) for an unset time.
fn filetime_to_unix(filetime: u64) -> i64 {
    if filetime == 0 {
        return 0;
    }
    (filetime / 10_000_000) as i64 - FILETIME_UNIX_OFFSET_SECS
}

/// Reparse points store their target in the MFT record: no clusters.
pub fn link_alloc(_path: &Path) -> u64 {
    0
}

/// No device (mount points are reparse points and are never descended) and
/// no own size: a directory's index allocation is small and not worth a
/// handle per directory.
pub fn dir_meta(_path: &Path) -> DirMeta {
    DirMeta::default()
}

pub fn root_policy(_root: &Path) -> (HashSet<u64>, Vec<PathBuf>) {
    (HashSet::new(), Vec::new())
}

pub fn is_cloud_sync_dir(_path: &Path) -> bool {
    false
}

pub fn root_note(root: &Path) -> Option<String> {
    if is_volume_root(root) {
        Some(
            "Scanning this drive only. Other drives and mounted volumes are \
             not followed — scan them separately. Folders Windows protects \
             (other users' profiles, System Volume Information) show up as \
             unreadable unless DiskAudit runs as administrator."
                .to_string(),
        )
    } else {
        None
    }
}

/// `C:\` or `\\server\share\`: a prefix, a root, and nothing else.
fn is_volume_root(path: &Path) -> bool {
    let mut comps = path.components();
    matches!(comps.next(), Some(Component::Prefix(_)))
        && matches!(comps.next(), Some(Component::RootDir))
        && comps.next().is_none()
}

/// Absolute, `\`-separated, without the `\\?\` verbatim prefix that
/// canonicalize() would add (std re-adds it internally for long paths, so
/// nothing is lost — and Explorer and PowerShell get a path they accept).
/// Symlinks in the path are left as typed; the walk reads through them.
pub fn resolve_root(input: &Path) -> PathBuf {
    let abs = std::path::absolute(input).unwrap_or_else(|_| input.to_path_buf());
    let plain = PathBuf::from(super::strip_verbatim(&abs.to_string_lossy()));
    // Re-collecting drops trailing separators and `.` components.
    plain.components().collect()
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn eq_ci(a: &std::ffi::OsStr, b: &str) -> bool {
    a.to_str().is_some_and(|a| a.eq_ignore_ascii_case(b))
}

fn same_path_ci(a: &Path, b: &Path) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

/// `<drive>:\Users\<name>`, or the current %USERPROFILE%.
pub fn looks_like_home(base: &Path) -> bool {
    if let Some(users) = base.parent() {
        if users.file_name().is_some_and(|n| eq_ci(n, "Users"))
            && users.parent().is_some_and(is_volume_root)
        {
            return true;
        }
    }
    home_dir().is_some_and(|h| same_path_ci(&h, base))
}

const HOME_SITES: &[(&str, ReclaimSite)] = &[
    (
        "AppData/Local/Temp",
        ReclaimSite::SelfIsFinding(ReclaimKind::TempFiles),
    ),
    (
        "AppData/Local/CrashDumps",
        ReclaimSite::SelfIsFinding(ReclaimKind::TempFiles),
    ),
    (
        "AppData/Local/Microsoft/Windows/INetCache",
        ReclaimSite::SelfIsFinding(ReclaimKind::AppCache),
    ),
    (
        "AppData/Local/Google/Chrome/User Data/Default/Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::AppCache),
    ),
    (
        "AppData/Local/Google/Chrome/User Data/Default/Code Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::AppCache),
    ),
    (
        "AppData/Local/Microsoft/Edge/User Data/Default/Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::AppCache),
    ),
    (
        "AppData/Local/Microsoft/Edge/User Data/Default/Code Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::AppCache),
    ),
    (
        "AppData/Local/npm-cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        "AppData/Local/pip/Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        "AppData/Local/Yarn/Cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        "AppData/Local/NuGet/v3-cache",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    (
        ".nuget/packages",
        ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache),
    ),
    ("Downloads", ReclaimSite::InstallerDir),
];

/// Windows-directory-relative spots (visible on a drive scan; clearing them
/// needs administrator rights).
const WINDOWS_DIR_SITES: &[(&str, ReclaimKind)] = &[
    ("Temp", ReclaimKind::TempFiles),
    ("SoftwareDistribution/Download", ReclaimKind::PackageCache),
];

pub fn reclaim_site(path: &Path, root: &Path) -> Option<ReclaimSite> {
    // Per-volume Recycle Bin at the top of a scanned drive.
    if path.file_name().is_some_and(|n| eq_ci(n, "$Recycle.Bin"))
        && path.parent() == Some(root)
        && is_volume_root(root)
    {
        return Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash));
    }
    for (rel, kind) in WINDOWS_DIR_SITES {
        if let Some(windir) = strip_rel_suffix(path, rel, true) {
            if windir.file_name().is_some_and(|n| eq_ci(n, "Windows"))
                && windir.parent().is_some_and(is_volume_root)
            {
                return Some(ReclaimSite::SelfIsFinding(*kind));
            }
        }
    }
    match_home_site(path, HOME_SITES, true, looks_like_home)
        .or_else(|| match_home_site(path, COMMON_HOME_SITES, true, looks_like_home))
}

/// Directories whose contents are managed by Windows or by installed apps.
const MANAGED_DIRS: &[&str] = &[
    "AppData",
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "$Recycle.Bin",
    "System Volume Information",
];

/// Paging / hibernation files: huge, system-owned, never the user's to judge.
const SYSTEM_FILES: &[&str] = &["pagefile.sys", "hiberfil.sys", "swapfile.sys"];

pub fn stale_excluded(_root: &Path, rel: &Path) -> bool {
    let mut comps: Vec<Component> = rel.components().collect();
    let file = comps.pop();
    if comps
        .iter()
        .any(|c| MANAGED_DIRS.iter().any(|m| eq_ci(c.as_os_str(), m)))
    {
        return true;
    }
    comps.is_empty() && file.is_some_and(|f| SYSTEM_FILES.iter().any(|s| eq_ci(f.as_os_str(), s)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_conversion() {
        assert_eq!(filetime_to_unix(0), 0);
        // 2020-01-01T00:00:00Z
        assert_eq!(filetime_to_unix(132_223_104_000_000_000), 1_577_836_800);
    }

    #[test]
    fn volume_roots() {
        assert!(is_volume_root(Path::new(r"C:\")));
        assert!(is_volume_root(Path::new(r"\\nas\share\")));
        assert!(!is_volume_root(Path::new(r"C:\Users")));
        assert!(!is_volume_root(Path::new(r"C:")));
    }

    #[test]
    fn resolve_root_is_plain_and_normalized() {
        assert_eq!(
            resolve_root(Path::new(r"\\?\C:\Users\alice\")),
            PathBuf::from(r"C:\Users\alice")
        );
        assert_eq!(
            resolve_root(Path::new(r"C:/Users/alice/./Downloads")),
            PathBuf::from(r"C:\Users\alice\Downloads")
        );
        assert_eq!(resolve_root(Path::new(r"C:\")), PathBuf::from(r"C:\"));
    }

    #[test]
    fn homes_are_children_of_a_drive_level_users_folder() {
        assert!(looks_like_home(Path::new(r"C:\Users\alice")));
        assert!(looks_like_home(Path::new(r"d:\users\Bob")));
        assert!(!looks_like_home(Path::new(r"C:\backup\Users\alice")));
        assert!(!looks_like_home(Path::new(r"C:\Users")));
    }

    #[test]
    fn sites_match_case_insensitively_and_only_on_home_bases() {
        let root = Path::new(r"C:\Users\alice");
        assert_eq!(
            reclaim_site(Path::new(r"C:\Users\alice\AppData\Local\Temp"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::TempFiles))
        );
        assert_eq!(
            reclaim_site(Path::new(r"C:\Users\alice\appdata\local\npm-cache"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache))
        );
        assert_eq!(
            reclaim_site(Path::new(r"C:\Users\alice\.cargo\registry\cache"), root),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::ToolCache))
        );
        assert_eq!(
            reclaim_site(Path::new(r"C:\Users\alice\Downloads"), root),
            Some(ReclaimSite::InstallerDir)
        );
        assert_eq!(
            reclaim_site(
                Path::new(r"C:\Users\alice\project\AppData\Local\Temp"),
                root
            ),
            None
        );
        assert_eq!(
            reclaim_site(Path::new(r"C:\Users\alice\site\Downloads"), root),
            None
        );
    }

    #[test]
    fn drive_level_sites_need_a_drive_scan() {
        let drive = Path::new(r"C:\");
        assert_eq!(
            reclaim_site(Path::new(r"C:\$Recycle.Bin"), drive),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::Trash))
        );
        assert_eq!(
            reclaim_site(Path::new(r"C:\Windows\Temp"), drive),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::TempFiles))
        );
        assert_eq!(
            reclaim_site(
                Path::new(r"C:\Windows\SoftwareDistribution\Download"),
                drive
            ),
            Some(ReclaimSite::SelfIsFinding(ReclaimKind::PackageCache))
        );
        // A folder that merely shares the name, deeper in the tree.
        assert_eq!(reclaim_site(Path::new(r"C:\old\Windows\Temp"), drive), None);
        assert_eq!(
            reclaim_site(Path::new(r"C:\data\$Recycle.Bin"), Path::new(r"C:\data")),
            None
        );
    }

    #[test]
    fn stale_hint_skips_managed_trees_and_system_files() {
        let root = Path::new(r"C:\");
        assert!(stale_excluded(root, Path::new(r"pagefile.sys")));
        assert!(stale_excluded(
            root,
            Path::new(r"Program Files\Game\data.pak")
        ));
        assert!(stale_excluded(
            root,
            Path::new(r"Users\alice\appdata\Roaming\x.db")
        ));
        assert!(!stale_excluded(
            root,
            Path::new(r"Users\alice\Videos\old.mkv")
        ));
        // Only a top-level pagefile is the system's.
        assert!(!stale_excluded(
            root,
            Path::new(r"Users\alice\pagefile.sys")
        ));
    }
}
