//! Read-only filesystem service: typed directory reads and entry metadata.
//!
//! Directories are streamed once in batches (no per-page rescans) and the
//! reader checks a cancellation flag between entries. Symbolic links are never
//! traversed recursively: a link is reported as an entry, with its kind taken
//! from a single `stat` of the target.

use std::{
    fs::{self, Metadata},
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::contracts::{
    AppError, DirectoryEvent, EntryKind, ErrorCategory, FileEntry, ItemFailure, Place, PlaceGroup,
    Places, display_name, id_to_path, path_to_id,
};

pub const BATCH_SIZE: usize = 500;
const BATCH_INTERVAL: Duration = Duration::from_millis(100);

/// Decodes an entry id into a validated absolute path.
pub fn resolve_id(operation: &str, id: &str) -> Result<PathBuf, AppError> {
    let invalid =
        |message: &str| AppError::new(ErrorCategory::InvalidInput, operation, None, message);
    let path = id_to_path(id).ok_or_else(|| invalid("The item identifier is malformed."))?;
    if !path.is_absolute() {
        return Err(invalid("The item path must be absolute."));
    }
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(invalid("The item path contains an invalid character."));
    }
    Ok(path)
}

fn millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

fn kind_of(meta: &Metadata) -> EntryKind {
    if meta.is_dir() {
        EntryKind::Directory
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

/// A link target that genuinely does not resolve: missing, a path component that
/// is not a folder, or a symlink loop. Anything else (permission, I/O) is a real error.
fn is_unresolved_target(error: &io::Error) -> bool {
    #[cfg(target_os = "macos")]
    const ELOOP: i32 = 62;
    #[cfg(not(target_os = "macos"))]
    const ELOOP: i32 = 40;
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || error.raw_os_error() == Some(ELOOP)
}

/// Builds the entry for `path` without following the final link more than once.
/// Fails when the path itself cannot be examined (missing, denied, ...) or when a
/// link target cannot be examined for a reason other than being unresolvable.
pub fn entry_for_path(path: &Path) -> io::Result<FileEntry> {
    entry_for_path_with(path, &|p| fs::metadata(p))
}

/// `target_stat` is injectable so tests can simulate target errors that cannot be
/// produced reliably with real permissions.
fn entry_for_path_with(
    path: &Path,
    target_stat: &dyn Fn(&Path) -> io::Result<Metadata>,
) -> io::Result<FileEntry> {
    let link_meta = fs::symlink_metadata(path)?;
    let is_symlink = link_meta.file_type().is_symlink();
    let mut is_broken_link = false;
    let meta = if is_symlink {
        match target_stat(path) {
            Ok(target) => target,
            Err(e) if is_unresolved_target(&e) => {
                is_broken_link = true;
                link_meta.clone()
            }
            Err(e) => return Err(e),
        }
    } else {
        link_meta
    };
    let kind = if is_broken_link {
        EntryKind::Other
    } else {
        kind_of(&meta)
    };
    Ok(FileEntry {
        id: path_to_id(path),
        path: path.to_string_lossy().into_owned(),
        name: display_name(path),
        kind,
        size: (kind == EntryKind::File).then(|| meta.len()),
        modified_ms: meta.modified().ok().map(millis),
        is_symlink,
        is_broken_link,
    })
}

pub fn home_directory() -> Result<FileEntry, AppError> {
    let operation = "open the home folder";
    let home = std::env::home_dir().ok_or_else(|| {
        AppError::new(
            ErrorCategory::NotFound,
            operation,
            None,
            "The home folder could not be determined.",
        )
    })?;
    entry_for_path(&home).map_err(|e| AppError::from_io(operation, &home, &e))
}

/// Validates a path typed by the user and returns the folder entry. `~` expands to
/// the home folder. Like a shell `cd`, `.` and `..` are resolved lexically and
/// symbolic links in the path are kept. The target must be an existing folder
/// (a link to a folder is accepted).
pub fn resolve_directory(typed: &str) -> Result<FileEntry, AppError> {
    resolve_directory_in(typed, std::env::home_dir().as_deref())
}

fn resolve_directory_in(typed: &str, home: Option<&Path>) -> Result<FileEntry, AppError> {
    use std::path::Component;
    let operation = "open the folder";
    let invalid =
        |message: &str| AppError::new(ErrorCategory::InvalidInput, operation, None, message);
    let typed = typed.trim();
    if typed.is_empty() {
        return Err(invalid("Enter a folder path."));
    }
    if typed.contains('\0') {
        return Err(invalid("The path contains an invalid character."));
    }
    let expanded = if typed == "~" || typed.starts_with("~/") {
        let home = home.ok_or_else(|| {
            AppError::new(
                ErrorCategory::NotFound,
                operation,
                None,
                "The home folder could not be determined.",
            )
        })?;
        home.join(typed[1..].trim_start_matches('/'))
    } else {
        PathBuf::from(typed)
    };
    if !expanded.is_absolute() {
        return Err(invalid(
            "Enter an absolute path starting with / or ~ (for example /Users).",
        ));
    }
    let mut clean = PathBuf::from("/");
    for component in expanded.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::ParentDir => {
                clean.pop();
            }
            _ => {}
        }
    }
    let meta = fs::metadata(&clean).map_err(|e| AppError::from_io(operation, &clean, &e))?;
    if !meta.is_dir() {
        let name = display_name(&clean);
        return Err(AppError::new(
            ErrorCategory::InvalidInput,
            operation,
            Some(name.clone()),
            format!("\"{name}\" is not a folder."),
        ));
    }
    entry_for_path(&clean).map_err(|e| AppError::from_io(operation, &clean, &e))
}

const STANDARD_FOLDERS: [&str; 7] = [
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Music",
    "Movies",
    "Public",
];

/// Sidebar locations: home, standard folders that exist, /Applications, the
/// startup volume (named after its `/Volumes` link) and mounted volumes.
pub fn places() -> Places {
    places_in(
        std::env::home_dir().as_deref(),
        Path::new("/Applications"),
        Path::new("/Volumes"),
        Path::new("/"),
    )
}

fn add_place(out: &mut Places, label: String, group: PlaceGroup, path: &Path, optional: bool) {
    match entry_for_path(path) {
        Ok(entry) if entry.kind == EntryKind::Directory => out.places.push(Place {
            label,
            group,
            entry,
        }),
        Ok(_) if optional => {}
        Ok(entry) => out.failures.push(ItemFailure {
            id: entry.id,
            error: AppError::new(
                if entry.is_broken_link {
                    ErrorCategory::NotFound
                } else {
                    ErrorCategory::InvalidInput
                },
                "list locations",
                Some(entry.name.clone()),
                format!("\"{}\" is not an available folder.", entry.name),
            ),
        }),
        Err(e) if optional && e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => out.failures.push(ItemFailure {
            id: path_to_id(path),
            error: AppError::from_io("list locations", path, &e),
        }),
    }
}

fn places_in(home: Option<&Path>, applications: &Path, volumes: &Path, root: &Path) -> Places {
    let mut out = Places {
        places: Vec::new(),
        failures: Vec::new(),
    };
    if let Some(home) = home {
        add_place(&mut out, "Home".into(), PlaceGroup::Quick, home, false);
        for name in STANDARD_FOLDERS {
            add_place(
                &mut out,
                name.into(),
                PlaceGroup::Quick,
                &home.join(name),
                true,
            );
        }
    }
    add_place(
        &mut out,
        "Applications".into(),
        PlaceGroup::Quick,
        applications,
        true,
    );

    let mut startup_named = false;
    let mut volume_entries: Vec<(String, PathBuf)> = Vec::new();
    match fs::read_dir(volumes) {
        Ok(dir) => {
            for item in dir {
                match item {
                    Ok(item) => {
                        let path = item.path();
                        let name = item.file_name().to_string_lossy().into_owned();
                        let is_startup = matches!(
                            (fs::canonicalize(&path), fs::canonicalize(root)),
                            (Ok(a), Ok(b)) if a == b
                        );
                        if is_startup {
                            startup_named = true;
                            add_place(&mut out, name, PlaceGroup::Volume, root, false);
                        } else {
                            volume_entries.push((name, path));
                        }
                    }
                    Err(e) => out.failures.push(ItemFailure {
                        id: path_to_id(volumes),
                        error: AppError::from_io("list volumes", volumes, &e),
                    }),
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => out.failures.push(ItemFailure {
            id: path_to_id(volumes),
            error: AppError::from_io("list volumes", volumes, &e),
        }),
    }
    if !startup_named {
        add_place(
            &mut out,
            "Startup volume (/)".into(),
            PlaceGroup::Volume,
            root,
            false,
        );
    }
    volume_entries.sort();
    for (name, path) in volume_entries {
        add_place(&mut out, name, PlaceGroup::Volume, &path, false);
    }
    // The startup volume leads the volume group.
    let root_path = root.to_string_lossy().into_owned();
    out.places
        .sort_by_key(|p| (p.group != PlaceGroup::Quick, p.entry.path != root_path));
    out
}

/// The containing folder; `None` for the root.
pub fn parent_entry(path: &Path) -> Result<Option<FileEntry>, AppError> {
    let Some(parent) = path.parent() else {
        return Ok(None);
    };
    entry_for_path(parent)
        .map(Some)
        .map_err(|e| AppError::from_io("go to the parent folder", parent, &e))
}

fn flush(
    read_id: &str,
    entries: &mut Vec<FileEntry>,
    failures: &mut Vec<ItemFailure>,
    emit: &mut dyn FnMut(DirectoryEvent),
) {
    if entries.is_empty() && failures.is_empty() {
        return;
    }
    emit(DirectoryEvent::Entries {
        read_id: read_id.into(),
        entries: std::mem::take(entries),
        failures: std::mem::take(failures),
    });
}

/// Streams `dir` through `emit` and always ends with exactly one terminal event.
pub fn read_directory(
    read_id: &str,
    dir: &Path,
    cancel: &AtomicBool,
    batch_size: usize,
    emit: &mut dyn FnMut(DirectoryEvent),
) {
    read_directory_with(read_id, dir, cancel, batch_size, &entry_for_path, emit)
}

/// `stat` is injectable so tests can simulate entries vanishing after `readdir`.
fn read_directory_with(
    read_id: &str,
    dir: &Path,
    cancel: &AtomicBool,
    batch_size: usize,
    stat: &dyn Fn(&Path) -> io::Result<FileEntry>,
    emit: &mut dyn FnMut(DirectoryEvent),
) {
    let operation = "read the folder";
    let cancelled = |emit: &mut dyn FnMut(DirectoryEvent)| {
        emit(DirectoryEvent::Cancelled {
            read_id: read_id.into(),
        })
    };
    if cancel.load(Ordering::Relaxed) {
        return cancelled(emit);
    }
    let iter = match fs::read_dir(dir) {
        Ok(iter) => iter,
        Err(e) => {
            return emit(DirectoryEvent::Failed {
                read_id: read_id.into(),
                error: AppError::from_io(operation, dir, &e),
            });
        }
    };

    let mut entries = Vec::new();
    let mut failures = Vec::new();
    let (mut total, mut failed) = (0u64, 0u64);
    let mut last_flush = Instant::now();
    for item in iter {
        if cancel.load(Ordering::Relaxed) {
            return cancelled(emit);
        }
        match item {
            Ok(dirent) => {
                let path = dirent.path();
                match stat(&path) {
                    Ok(entry) => {
                        total += 1;
                        entries.push(entry);
                    }
                    Err(e) => {
                        failed += 1;
                        failures.push(ItemFailure {
                            id: path_to_id(&path),
                            error: AppError::from_io("read the details of", &path, &e),
                        });
                    }
                }
            }
            Err(e) => {
                failed += 1;
                failures.push(ItemFailure {
                    id: path_to_id(dir),
                    error: AppError::from_io("continue reading the folder", dir, &e),
                });
            }
        }
        if entries.len() + failures.len() >= batch_size || last_flush.elapsed() >= BATCH_INTERVAL {
            flush(read_id, &mut entries, &mut failures, emit);
            last_flush = Instant::now();
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return cancelled(emit);
    }
    flush(read_id, &mut entries, &mut failures, emit);
    emit(DirectoryEvent::Finished {
        read_id: read_id.into(),
        entries: total,
        failed,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spike_fixture::Fixture;
    use std::{
        ffi::OsString,
        os::unix::{ffi::OsStringExt, fs::PermissionsExt},
    };

    fn fixture() -> Fixture {
        Fixture::create_in(&std::env::temp_dir(), "mfm-fs-test").unwrap()
    }

    fn collect(dir: &Path, cancel: &AtomicBool, batch: usize) -> Vec<DirectoryEvent> {
        let mut events = Vec::new();
        read_directory("r", dir, cancel, batch, &mut |e| events.push(e));
        events
    }

    fn entries_of(events: &[DirectoryEvent]) -> (Vec<FileEntry>, Vec<ItemFailure>) {
        let (mut entries, mut failures) = (vec![], vec![]);
        for e in events {
            if let DirectoryEvent::Entries {
                entries: es,
                failures: fs,
                ..
            } = e
            {
                entries.extend(es.clone());
                failures.extend(fs.clone());
            }
        }
        (entries, failures)
    }

    fn by_name<'a>(entries: &'a [FileEntry], name: &str) -> &'a FileEntry {
        entries.iter().find(|e| e.name == name).unwrap()
    }

    #[test]
    fn empty_directory_finishes_with_zero_entries() {
        let fx = fixture();
        let events = collect(fx.path(), &AtomicBool::new(false), BATCH_SIZE);
        assert_eq!(
            events,
            vec![DirectoryEvent::Finished {
                read_id: "r".into(),
                entries: 0,
                failed: 0
            }]
        );
        fx.cleanup().unwrap();
    }

    #[test]
    fn lists_metadata_for_files_directories_and_unicode_names() {
        let fx = fixture();
        fx.write("plain.txt", "hello").unwrap();
        fx.write("héllo wörld ✓.txt", "ü").unwrap();
        fs::create_dir(fx.path().join("sub")).unwrap();
        let events = collect(fx.path(), &AtomicBool::new(false), BATCH_SIZE);
        let (entries, failures) = entries_of(&events);
        assert!(failures.is_empty());
        assert_eq!(entries.len(), 3);
        let plain = by_name(&entries, "plain.txt");
        assert_eq!(plain.kind, EntryKind::File);
        assert_eq!(plain.size, Some(5));
        assert!(plain.modified_ms.unwrap() > 1_600_000_000_000);
        assert!(!plain.is_symlink && !plain.is_broken_link);
        assert_eq!(plain.path, fx.path().join("plain.txt").to_string_lossy());
        assert_eq!(by_name(&entries, "héllo wörld ✓.txt").size, Some(2));
        let sub = by_name(&entries, "sub");
        assert_eq!((sub.kind, sub.size), (EntryKind::Directory, None));
        assert!(matches!(
            events.last(),
            Some(DirectoryEvent::Finished {
                entries: 3,
                failed: 0,
                ..
            })
        ));
        fx.cleanup().unwrap();
    }

    #[test]
    fn non_utf8_names_keep_a_lossless_identity() {
        let fx = fixture();
        let raw = OsString::from_vec(b"caf\xe9-\xff.txt".to_vec());
        let path = fx.path().join(&raw);

        // The id of a non-UTF-8 path is lossless and distinct from its lossy display form.
        let id = path_to_id(&path);
        assert_eq!(resolve_id("test", &id).unwrap(), path);
        assert!(path.to_str().is_none());
        assert_ne!(path.to_string_lossy(), path.to_str().unwrap_or(""));

        match fs::write(&path, "x") {
            Ok(()) => {
                let events = collect(fx.path(), &AtomicBool::new(false), BATCH_SIZE);
                let (entries, _) = entries_of(&events);
                assert_eq!(entries.len(), 1);
                assert!(entries[0].name.contains('\u{fffd}'));
                assert_eq!(entries[0].id, id);
                assert_eq!(
                    fs::read_to_string(resolve_id("test", &entries[0].id).unwrap()).unwrap(),
                    "x"
                );
                // The lossy display path is not a valid address for the file.
                assert!(fs::metadata(&entries[0].path).is_err());
            }
            // APFS and HFS+ reject names that are not valid UTF-8 (EILSEQ), so such
            // files cannot be created on the temp volume; only addressing is tested.
            Err(e) if e.raw_os_error() == Some(92) => {
                eprintln!("volume rejects non-UTF-8 names; listing part of this test skipped");
            }
            Err(e) => panic!("unexpected error creating fixture: {e}"),
        }
        fx.cleanup().unwrap();
    }

    #[test]
    fn symlinks_are_flagged_and_not_followed_recursively() {
        let fx = fixture();
        fx.write("target.txt", "abcd").unwrap();
        fs::create_dir(fx.path().join("dir")).unwrap();
        fs::write(fx.path().join("dir/inner.txt"), "i").unwrap();
        use std::os::unix::fs::symlink;
        symlink("target.txt", fx.path().join("link-file")).unwrap();
        symlink("dir", fx.path().join("link-dir")).unwrap();
        symlink("missing", fx.path().join("link-broken")).unwrap();
        symlink(".", fx.path().join("link-loop")).unwrap();
        symlink("link-self", fx.path().join("link-self")).unwrap();
        let events = collect(fx.path(), &AtomicBool::new(false), BATCH_SIZE);
        let (entries, failures) = entries_of(&events);
        assert!(failures.is_empty());
        // 2 real items + 5 links, and nothing from inside `dir` or the loop.
        assert_eq!(entries.len(), 7);
        let f = by_name(&entries, "link-file");
        assert!(f.is_symlink && !f.is_broken_link);
        assert_eq!((f.kind, f.size), (EntryKind::File, Some(4)));
        let d = by_name(&entries, "link-dir");
        assert!(d.is_symlink);
        assert_eq!(d.kind, EntryKind::Directory);
        let b = by_name(&entries, "link-broken");
        assert!(b.is_symlink && b.is_broken_link);
        assert_eq!((b.kind, b.size), (EntryKind::Other, None));
        assert_eq!(by_name(&entries, "link-loop").kind, EntryKind::Directory);
        assert!(by_name(&entries, "link-self").is_broken_link);
        fx.cleanup().unwrap();
    }

    #[test]
    fn link_into_a_denied_directory_is_a_failure_not_a_broken_link() {
        let fx = fixture();
        let locked = fx.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("inner.txt"), "x").unwrap();
        let _restore = RestorePerms(locked.clone());
        std::os::unix::fs::symlink("locked/inner.txt", fx.path().join("link")).unwrap();
        std::os::unix::fs::symlink("missing", fx.path().join("dangling")).unwrap();
        std::os::unix::fs::symlink("dangling-self", fx.path().join("dangling-self")).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::metadata(locked.join("inner.txt")).is_ok() {
            eprintln!("skipping: permissions are not enforced for this user");
        } else {
            let events = collect(fx.path(), &AtomicBool::new(false), BATCH_SIZE);
            let (entries, failures) = entries_of(&events);
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].error.category, ErrorCategory::PermissionDenied);
            assert_eq!(id_to_path(&failures[0].id).unwrap(), fx.path().join("link"));
            // Genuinely dangling and looping links stay successful broken links.
            for name in ["dangling", "dangling-self"] {
                assert!(by_name(&entries, name).is_broken_link, "{name}");
            }
            assert!(entries.iter().all(|e| e.name != "link"));
            assert!(matches!(
                events.last(),
                Some(DirectoryEvent::Finished {
                    entries: 3,
                    failed: 1,
                    ..
                })
            ));
        }
        drop(_restore);
        fx.cleanup().unwrap();
    }

    #[test]
    fn injected_target_errors_are_classified() {
        // INJECTED errors: the stat of the link target is replaced, so this checks
        // classification only, not real filesystem behavior.
        let fx = fixture();
        fx.write("t.txt", "x").unwrap();
        let link = fx.path().join("l");
        std::os::unix::fs::symlink("t.txt", &link).unwrap();
        let fail = |kind: io::Error| {
            entry_for_path_with(&link, &|_| Err(io::Error::new(kind.kind(), "injected")))
        };
        for kind in [io::ErrorKind::NotFound, io::ErrorKind::NotADirectory] {
            assert!(fail(kind.into()).unwrap().is_broken_link);
        }
        let eloop = entry_for_path_with(&link, &|_| {
            Err(io::Error::from_raw_os_error(if cfg!(target_os = "macos") {
                62
            } else {
                40
            }))
        });
        assert!(eloop.unwrap().is_broken_link);
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
            io::ErrorKind::TimedOut,
        ] {
            let err = fail(kind.into()).unwrap_err();
            assert_eq!(err.kind(), kind);
        }
        let eio = entry_for_path_with(&link, &|_| Err(io::Error::from_raw_os_error(5)));
        let failure = AppError::from_io("read the details of", &link, &eio.unwrap_err());
        assert_eq!(failure.category, ErrorCategory::Io);
        fx.cleanup().unwrap();
    }

    #[test]
    fn missing_path_and_file_path_are_errors_not_empty_folders() {
        let fx = fixture();
        let file = fx.write("file.txt", "x").unwrap();
        for (path, category) in [
            (fx.path().join("nope"), ErrorCategory::NotFound),
            (file, ErrorCategory::InvalidInput),
        ] {
            let events = collect(&path, &AtomicBool::new(false), BATCH_SIZE);
            assert_eq!(events.len(), 1);
            match &events[0] {
                DirectoryEvent::Failed { error, .. } => assert_eq!(error.category, category),
                other => panic!("expected failure, got {other:?}"),
            }
        }
        fx.cleanup().unwrap();
    }

    struct RestorePerms(PathBuf);
    impl Drop for RestorePerms {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn denied_directory_is_a_permission_error() {
        let fx = fixture();
        let locked = fx.path().join("locked");
        fs::create_dir(&locked).unwrap();
        let _restore = RestorePerms(locked.clone());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&locked).is_ok() {
            eprintln!("skipping: permissions are not enforced for this user");
        } else {
            let events = collect(&locked, &AtomicBool::new(false), BATCH_SIZE);
            match &events[..] {
                [DirectoryEvent::Failed { error, .. }] => {
                    assert_eq!(error.category, ErrorCategory::PermissionDenied);
                    assert_eq!(error.context.as_deref(), Some("locked"));
                }
                other => panic!("expected a single failure, got {other:?}"),
            }
        }
        drop(_restore);
        fx.cleanup().unwrap();
    }

    #[test]
    fn unreadable_entry_metadata_is_reported_not_dropped() {
        // A listable but non-searchable directory yields entries whose stat is denied.
        let fx = fixture();
        let dir = fx.path().join("list-only");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        let _restore = RestorePerms(dir.clone());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o444)).unwrap();
        if fs::metadata(dir.join("a.txt")).is_ok() {
            eprintln!("skipping: permissions are not enforced for this user");
        } else {
            let events = collect(&dir, &AtomicBool::new(false), BATCH_SIZE);
            let (entries, failures) = entries_of(&events);
            assert!(entries.is_empty());
            assert_eq!(failures.len(), 2);
            assert!(
                failures
                    .iter()
                    .all(|f| f.error.category == ErrorCategory::PermissionDenied)
            );
            let names: Vec<_> = failures
                .iter()
                .map(|f| id_to_path(&f.id).unwrap().file_name().unwrap().to_owned())
                .collect();
            assert!(
                names.contains(&OsString::from("a.txt"))
                    && names.contains(&OsString::from("b.txt"))
            );
            assert!(matches!(
                events.last(),
                Some(DirectoryEvent::Finished {
                    entries: 0,
                    failed: 2,
                    ..
                })
            ));
        }
        drop(_restore);
        fx.cleanup().unwrap();
    }

    #[test]
    fn entries_vanishing_after_readdir_are_reported_as_failures() {
        let fx = fixture();
        fx.write("stays.txt", "1").unwrap();
        let gone = fx.write("gone.txt", "2").unwrap();
        let mut events = Vec::new();
        let stat = |p: &Path| {
            if p.file_name().unwrap() == "gone.txt" {
                fs::remove_file(p)?;
            }
            entry_for_path(p)
        };
        read_directory_with(
            "r",
            fx.path(),
            &AtomicBool::new(false),
            BATCH_SIZE,
            &stat,
            &mut |e| events.push(e),
        );
        let (entries, failures) = entries_of(&events);
        assert_eq!(entries.len(), 1);
        assert_eq!(failures.len(), 1);
        assert_eq!(id_to_path(&failures[0].id).unwrap(), gone);
        assert_eq!(failures[0].error.category, ErrorCategory::NotFound);
        assert!(matches!(
            events.last(),
            Some(DirectoryEvent::Finished {
                entries: 1,
                failed: 1,
                ..
            })
        ));
        fx.cleanup().unwrap();
    }

    #[test]
    fn large_directory_is_delivered_in_bounded_batches() {
        let fx = fixture();
        const N: usize = 12_000;
        for i in 0..N {
            fs::write(fx.path().join(format!("f{i:05}.txt")), "").unwrap();
        }
        let events = collect(fx.path(), &AtomicBool::new(false), 1000);
        let mut seen = std::collections::HashSet::new();
        let mut batches = 0;
        for e in &events {
            if let DirectoryEvent::Entries { entries, .. } = e {
                batches += 1;
                assert!(entries.len() <= 1000);
                for entry in entries {
                    assert!(seen.insert(entry.id.clone()), "duplicate entry");
                }
            }
        }
        assert_eq!(seen.len(), N);
        assert!(batches >= N / 1000);
        assert!(matches!(
            events.last(),
            Some(DirectoryEvent::Finished { entries, failed: 0, .. }) if *entries == N as u64
        ));
        fx.cleanup().unwrap();
    }

    #[test]
    fn cancellation_stops_mid_stream_with_a_single_terminal_event() {
        let fx = fixture();
        for i in 0..2000 {
            fs::write(fx.path().join(format!("f{i}")), "").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        read_directory("r", fx.path(), &cancel, 100, &mut |e| {
            cancel.store(true, Ordering::Relaxed);
            events.push(e);
        });
        let delivered: usize = events
            .iter()
            .map(|e| match e {
                DirectoryEvent::Entries { entries, .. } => entries.len(),
                _ => 0,
            })
            .sum();
        assert!(delivered < 2000);
        assert!(matches!(
            events.last(),
            Some(DirectoryEvent::Cancelled { .. })
        ));
        assert_eq!(
            events
                .iter()
                .filter(|e| !matches!(e, DirectoryEvent::Entries { .. }))
                .count(),
            1
        );

        let pre = AtomicBool::new(true);
        let events = collect(fx.path(), &pre, 100);
        assert_eq!(
            events,
            vec![DirectoryEvent::Cancelled {
                read_id: "r".into()
            }]
        );
        fx.cleanup().unwrap();
    }

    #[test]
    fn resolve_id_rejects_malformed_relative_and_nul_paths() {
        assert!(resolve_id("t", "zz").is_err());
        assert!(resolve_id("t", &path_to_id(Path::new("relative/dir"))).is_err());
        assert!(resolve_id("t", &path_to_id(Path::new("/a\0b"))).is_err());
        assert_eq!(
            resolve_id("t", &path_to_id(Path::new("/tmp"))).unwrap(),
            Path::new("/tmp")
        );
        let err = resolve_id("t", "abc").unwrap_err();
        assert_eq!(err.category, ErrorCategory::InvalidInput);
    }

    #[test]
    fn home_directory_entry_is_a_real_directory() {
        let home = home_directory().unwrap();
        assert_eq!(home.kind, EntryKind::Directory);
        assert_eq!(id_to_path(&home.id).unwrap(), std::env::home_dir().unwrap());
    }

    #[test]
    fn parent_entry_is_none_only_for_the_root() {
        assert_eq!(parent_entry(Path::new("/")).unwrap(), None);
        let parent = parent_entry(Path::new("/tmp")).unwrap().unwrap();
        assert_eq!(
            (parent.path.as_str(), parent.kind),
            ("/", EntryKind::Directory)
        );
        let err = parent_entry(Path::new("/nonexistent-mfm/child")).unwrap_err();
        assert_eq!(err.category, ErrorCategory::NotFound);
    }

    #[test]
    fn typed_paths_are_validated_against_the_real_filesystem() {
        let fx = fixture();
        fs::create_dir(fx.path().join("sub")).unwrap();
        let file = fx.write("a.txt", "x").unwrap();
        std::os::unix::fs::symlink("sub", fx.path().join("link")).unwrap();
        std::os::unix::fs::symlink("nope", fx.path().join("broken")).unwrap();
        let base = fx.path().to_string_lossy().into_owned();
        let ok = |typed: &str| resolve_directory_in(typed, Some(fx.path()));

        let sub = ok(&format!("{base}//sub/./")).unwrap();
        assert_eq!(sub.path, format!("{base}/sub"));
        assert_eq!(ok(&format!("{base}/sub/..")).unwrap().path, base);
        assert_eq!(ok("~").unwrap().path, base);
        assert_eq!(ok("~/sub").unwrap().path, format!("{base}/sub"));
        assert_eq!(
            ok(&format!("  {base}/sub  ")).unwrap().path,
            format!("{base}/sub")
        );
        let link = ok(&format!("{base}/link")).unwrap();
        assert!(link.is_symlink && link.kind == EntryKind::Directory);
        assert_eq!(link.path, format!("{base}/link"));

        let category = |typed: &str| ok(typed).unwrap_err().category;
        assert_eq!(category(""), ErrorCategory::InvalidInput);
        assert_eq!(category("relative/path"), ErrorCategory::InvalidInput);
        assert_eq!(category("bad\0path"), ErrorCategory::InvalidInput);
        assert_eq!(
            category(&format!("{base}/missing")),
            ErrorCategory::NotFound
        );
        assert_eq!(category(&format!("{base}/broken")), ErrorCategory::NotFound);
        assert_eq!(
            category(&file.to_string_lossy()),
            ErrorCategory::InvalidInput
        );
        assert_eq!(
            resolve_directory_in("~", None).unwrap_err().category,
            ErrorCategory::NotFound
        );
        fx.cleanup().unwrap();
    }

    #[test]
    fn places_list_real_locations_and_report_failures() {
        let fx = fixture();
        let home = fx.path().join("home");
        fs::create_dir_all(home.join("Documents")).unwrap();
        fs::create_dir(home.join("Downloads")).unwrap();
        fs::write(home.join("Music"), "a file, not a folder").unwrap();
        let apps = fx.path().join("Applications");
        fs::create_dir(&apps).unwrap();
        let root = fx.path().join("root");
        fs::create_dir(&root).unwrap();
        let volumes = fx.path().join("Volumes");
        fs::create_dir_all(volumes.join("Backup")).unwrap();
        fs::create_dir(volumes.join("Archive")).unwrap();
        std::os::unix::fs::symlink(&root, volumes.join("Macintosh HD")).unwrap();
        std::os::unix::fs::symlink("gone", volumes.join("Ejected")).unwrap();

        let found = places_in(Some(&home), &apps, &volumes, &root);
        let labels: Vec<_> = found
            .places
            .iter()
            .map(|p| (p.label.as_str(), p.group))
            .collect();
        assert_eq!(
            labels,
            [
                ("Home", PlaceGroup::Quick),
                ("Documents", PlaceGroup::Quick),
                ("Downloads", PlaceGroup::Quick),
                ("Applications", PlaceGroup::Quick),
                ("Macintosh HD", PlaceGroup::Volume),
                ("Archive", PlaceGroup::Volume),
                ("Backup", PlaceGroup::Volume),
            ]
        );
        assert!(
            found
                .places
                .iter()
                .all(|p| p.entry.kind == EntryKind::Directory)
        );
        let startup = found
            .places
            .iter()
            .find(|p| p.label == "Macintosh HD")
            .unwrap();
        assert_eq!(startup.entry.path, root.to_string_lossy());
        // A dangling volume entry is reported, not silently dropped.
        assert_eq!(found.failures.len(), 1);
        assert_eq!(found.failures[0].error.category, ErrorCategory::NotFound);

        let bare = places_in(None, &apps, &fx.path().join("none"), &root);
        let labels: Vec<_> = bare.places.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(labels, ["Applications", "Startup volume (/)"]);
        assert!(bare.failures.is_empty());
        fx.cleanup().unwrap();
    }
}
