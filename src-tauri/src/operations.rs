//! File-operation engine: folder creation, rename, copy, move and Trash.
//!
//! Rules enforced here (see README "File operations"):
//! * Nothing is overwritten by default. Destinations are created exclusively
//!   (`O_EXCL` / `RENAME_EXCL`), so a conflict that appears after the check is
//!   still caught at execution time. Only an explicit `Replace` decision on a
//!   file replaces anything, and the replaced item is moved to the Trash first.
//! * Symbolic links are never followed while copying or scanning; they are
//!   copied or moved as links.
//! * A cross-volume move copies first and removes exactly the copied source
//!   entries only after the whole item was copied and verified.
//! * Cancellation stops future work; completed work is not rolled back.
//! * The engine is pure with respect to the UI: it talks to a [`TaskControl`]
//!   (events, cancellation, conflict questions) and a [`Trasher`], so it can be
//!   tested against temporary fixtures without a window.

use std::{
    collections::{BTreeSet, HashMap},
    ffi::{CString, OsStr},
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::contracts::{
    AppError, ConflictDecision, EntryKind, ErrorCategory, ItemFailure, ProgressUnit, TaskEvent,
    TaskStage, TaskSummary, display_name, path_to_id,
};

const CHUNK: usize = 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Failures listed individually per task; the rest are only counted.
const MAX_LISTED_FAILURES: usize = 500;
pub const MAX_NAME_BYTES: usize = 255;
#[cfg(target_os = "macos")]
const EXDEV: i32 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    Copy,
    Move,
}

impl TransferMode {
    fn verb(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Move => "move",
        }
    }
}

/// A question the engine asks when the destination name is already taken.
#[derive(Debug, Clone)]
pub struct ConflictPrompt {
    pub conflict_id: String,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub source_kind: EntryKind,
    pub destination_kind: EntryKind,
    pub same_item: bool,
}

impl ConflictPrompt {
    /// Replacing is only possible between non-folders that are not the same item.
    pub fn replaceable(&self) -> bool {
        !self.same_item
            && self.source_kind != EntryKind::Directory
            && self.destination_kind != EntryKind::Directory
    }

    pub fn to_event(&self, task_id: &str) -> TaskEvent {
        TaskEvent::Conflict {
            task_id: task_id.into(),
            conflict_id: self.conflict_id.clone(),
            source_id: path_to_id(&self.source),
            destination_id: path_to_id(&self.destination),
            source_name: display_name(&self.source),
            destination_name: display_name(&self.destination),
            source_kind: self.source_kind,
            destination_kind: self.destination_kind,
            same_item: self.same_item,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Resolution {
    pub decision: ConflictDecision,
    pub apply_to_all: bool,
}

/// What a running task needs from its host.
pub trait TaskControl: Sync {
    fn is_cancelled(&self) -> bool;
    fn emit(&self, event: TaskEvent);
    /// Publishes the conflict and blocks until it is answered. `None` means the
    /// task was cancelled while waiting.
    fn ask(&self, prompt: &ConflictPrompt) -> Option<Resolution>;
}

/// Moves one item to the user's Trash (recoverable; never a permanent delete).
pub trait Trasher: Sync {
    fn trash(&self, path: &Path) -> Result<Option<PathBuf>, AppError>;
}

pub struct SystemTrash;

impl Trasher for SystemTrash {
    #[cfg(target_os = "macos")]
    fn trash(&self, path: &Path) -> Result<Option<PathBuf>, AppError> {
        crate::macos::trash_item(path)
    }

    #[cfg(not(target_os = "macos"))]
    fn trash(&self, path: &Path) -> Result<Option<PathBuf>, AppError> {
        Err(AppError::new(
            ErrorCategory::Unsupported,
            "move to the Trash",
            Some(display_name(path)),
            "Moving items to the Trash is only supported on macOS.",
        ))
    }
}

// ---------------------------------------------------------------- names

/// Checks a single file or folder name typed by the user.
pub fn validate_name(operation: &str, name: &str) -> Result<(), AppError> {
    let invalid = |message: &str| {
        Err(AppError::new(
            ErrorCategory::InvalidInput,
            operation,
            Some(name.to_string()),
            message,
        ))
    };
    if name.is_empty() {
        return invalid("The name can't be empty.");
    }
    if name == "." || name == ".." {
        return invalid("\".\" and \"..\" are not valid names.");
    }
    if name.contains('/') || name.contains(':') {
        return invalid("Names can't contain \"/\" or \":\".");
    }
    if name.contains('\0') {
        return invalid("The name contains an invalid character.");
    }
    if name.len() > MAX_NAME_BYTES {
        return invalid("The name is too long (at most 255 bytes).");
    }
    Ok(())
}

/// `report.txt` -> `report copy.txt`, `report copy 2.txt`, ... The first name
/// that does not exist (as a file, folder or link) is returned.
pub fn unique_name(dir: &Path, name: &OsStr, is_dir: bool) -> PathBuf {
    let path = Path::new(name);
    // Folders keep their whole name ("v1.2" -> "v1.2 copy"), files keep the extension.
    let (stem, ext) = if is_dir {
        (name.to_os_string(), None)
    } else {
        (
            path.file_stem().unwrap_or(name).to_os_string(),
            path.extension().map(OsStr::to_os_string),
        )
    };
    for n in 1..10_000u32 {
        let mut candidate = stem.clone();
        candidate.push(if n == 1 {
            " copy".to_string()
        } else {
            format!(" copy {n}")
        });
        if let Some(ext) = &ext {
            candidate.push(".");
            candidate.push(ext);
        }
        let full = dir.join(&candidate);
        if fs::symlink_metadata(&full).is_err() {
            return full;
        }
    }
    dir.join(format!(
        "{} copy {}",
        stem.to_string_lossy(),
        std::process::id()
    ))
}

/// Creates a folder named `name`, or "New folder", "New folder 2", ... when no
/// name is given. Never overwrites or merges with an existing item.
pub fn create_folder(parent: &Path, name: Option<&str>) -> Result<PathBuf, AppError> {
    let operation = "create the folder";
    let meta = fs::metadata(parent).map_err(|e| AppError::from_io(operation, parent, &e))?;
    if !meta.is_dir() {
        return Err(AppError::new(
            ErrorCategory::InvalidInput,
            operation,
            Some(display_name(parent)),
            "The destination is not a folder.",
        ));
    }
    if let Some(name) = name {
        validate_name(operation, name)?;
        let path = parent.join(name);
        return match fs::create_dir(&path) {
            Ok(()) => Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(AppError::new(
                ErrorCategory::AlreadyExists,
                operation,
                Some(name.to_string()),
                format!("An item named \"{name}\" already exists in this folder."),
            )),
            Err(e) => Err(AppError::from_io(operation, &path, &e)),
        };
    }
    for n in 1..1000u32 {
        let candidate = if n == 1 {
            "New folder".to_string()
        } else {
            format!("New folder {n}")
        };
        let path = parent.join(candidate);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::from_io(operation, &path, &e)),
        }
    }
    Err(AppError::new(
        ErrorCategory::AlreadyExists,
        operation,
        None,
        "Too many folders named \"New folder\" already exist here.",
    ))
}

/// Renames within the same folder without ever replacing another item. A change
/// of letter case only (same file on a case-insensitive volume) is allowed.
pub fn rename_item(path: &Path, new_name: &str) -> Result<PathBuf, AppError> {
    let operation = "rename";
    validate_name(operation, new_name)?;
    let source_meta =
        fs::symlink_metadata(path).map_err(|e| AppError::from_io(operation, path, &e))?;
    let parent = path.parent().ok_or_else(|| {
        AppError::new(
            ErrorCategory::InvalidInput,
            operation,
            Some(display_name(path)),
            "The root folder can't be renamed.",
        )
    })?;
    let target = parent.join(new_name);
    if target.as_os_str() == path.as_os_str() {
        return Ok(path.to_path_buf());
    }
    match rename_noreplace(path, &target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let same_file = fs::symlink_metadata(&target)
                .map(|t| t.dev() == source_meta.dev() && t.ino() == source_meta.ino())
                .unwrap_or(false);
            let old_name = display_name(path);
            if same_file && old_name.to_lowercase() == new_name.to_lowercase() {
                fs::rename(path, &target).map_err(|e| AppError::from_io(operation, path, &e))?;
                Ok(target)
            } else {
                Err(AppError::new(
                    ErrorCategory::AlreadyExists,
                    operation,
                    Some(new_name.to_string()),
                    format!("An item named \"{new_name}\" already exists in this folder."),
                ))
            }
        }
        Err(e) => Err(AppError::from_io(operation, path, &e)),
    }
}

/// `rename` that fails with `AlreadyExists` instead of replacing the target.
#[cfg(target_os = "macos")]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let cstr = |p: &Path| {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
    };
    let (from, to) = (cstr(from)?, cstr(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the call.
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Atomically exchanges two existing paths.
#[cfg(target_os = "macos")]
fn rename_swap(a: &Path, b: &Path) -> io::Result<()> {
    let cstr = |p: &Path| {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
    };
    let (a, b) = (cstr(a)?, cstr(b)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the call.
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_swap(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(not(target_os = "macos"))]
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let _ = CString::new("");
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn fcopyfile(
        from: libc::c_int,
        to: libc::c_int,
        state: *mut libc::c_void,
        flags: u32,
    ) -> libc::c_int;
}

/// Extended attributes, ACLs and mode (`COPYFILE_ACL | STAT | XATTR`), best effort.
#[cfg(target_os = "macos")]
fn copy_metadata(input: &File, output: &File) {
    // SAFETY: both descriptors are open for the duration of the call.
    let _ = unsafe {
        fcopyfile(
            input.as_raw_fd(),
            output.as_raw_fd(),
            std::ptr::null_mut(),
            0b111,
        )
    };
}

#[cfg(not(target_os = "macos"))]
fn copy_metadata(input: &File, output: &File) {
    let _ = (input.as_raw_fd(), output.as_raw_fd());
}

// ---------------------------------------------------------------- engine

#[derive(Debug)]
struct Cancelled;
type Flow<T = ()> = Result<T, Cancelled>;

#[derive(Debug, PartialEq, Eq)]
enum Node {
    Done,
    /// Only for the top-level destination: it appeared after the conflict check.
    Exists,
    /// The failure was recorded; nothing further is copied for this node.
    Failed,
}

/// Identity and version of an item at the moment it was copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

impl Stamp {
    fn of(meta: &Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.len(),
            mtime: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_nsec: meta.ctime_nsec(),
        }
    }
}

struct CopiedItem {
    path: PathBuf,
    is_dir: bool,
    stamp: Stamp,
}

type Copied = Vec<CopiedItem>;

fn entry_kind(meta: &Metadata) -> EntryKind {
    if meta.is_dir() {
        EntryKind::Directory
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

struct Run<'a> {
    task_id: &'a str,
    ctl: &'a dyn TaskControl,
    trash: &'a dyn Trasher,
    operation: &'static str,
    remembered: Option<ConflictDecision>,
    conflicts: u32,
    temporaries: u32,
    succeeded: u64,
    skipped: u64,
    failed: Vec<ItemFailure>,
    omitted: u64,
    /// Top-level folders left incomplete (cancelled or failed mid-copy).
    partial: Vec<PathBuf>,
    affected: BTreeSet<PathBuf>,
    total_bytes: u64,
    done_bytes: u64,
    total_items: u64,
    done_items: u64,
    last_progress: Instant,
}

impl<'a> Run<'a> {
    fn new(
        task_id: &'a str,
        ctl: &'a dyn TaskControl,
        trash: &'a dyn Trasher,
        operation: &'static str,
    ) -> Self {
        Self {
            task_id,
            ctl,
            trash,
            operation,
            remembered: None,
            conflicts: 0,
            temporaries: 0,
            succeeded: 0,
            skipped: 0,
            failed: Vec::new(),
            omitted: 0,
            partial: Vec::new(),
            affected: BTreeSet::new(),
            total_bytes: 0,
            done_bytes: 0,
            total_items: 0,
            done_items: 0,
            last_progress: Instant::now() - PROGRESS_INTERVAL,
        }
    }

    fn failure_count(&self) -> usize {
        self.failed.len() + self.omitted as usize
    }

    fn fail(&mut self, path: &Path, error: AppError) {
        if self.failed.len() < MAX_LISTED_FAILURES {
            self.failed.push(ItemFailure {
                id: path_to_id(path),
                error,
            });
        } else {
            self.omitted += 1;
        }
    }

    fn fail_io(&mut self, path: &Path, error: &io::Error) {
        let app = AppError::from_io(self.operation, path, error);
        self.fail(path, app);
    }

    fn fail_msg(&mut self, path: &Path, category: ErrorCategory, message: impl Into<String>) {
        let name = display_name(path);
        let app = AppError::new(category, self.operation, Some(name), message);
        self.fail(path, app);
    }

    fn check(&self) -> Flow {
        if self.ctl.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }

    fn progress(&mut self, force: bool) {
        if !force && self.last_progress.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        self.last_progress = Instant::now();
        let (completed, total, unit) = if self.total_bytes > 0 {
            self.total_bytes = self.total_bytes.max(self.done_bytes);
            (self.done_bytes, self.total_bytes, ProgressUnit::Bytes)
        } else {
            self.total_items = self.total_items.max(self.done_items);
            (self.done_items, self.total_items, ProgressUnit::Items)
        };
        self.ctl.emit(TaskEvent::Progress {
            task_id: self.task_id.into(),
            stage: TaskStage::Running,
            completed: Some(completed),
            total: Some(total),
            unit,
        });
    }

    fn summary(&mut self) -> TaskSummary {
        TaskSummary {
            succeeded: self.succeeded,
            skipped: self.skipped,
            failed: std::mem::take(&mut self.failed),
            failed_omitted: self.omitted,
            partial: self.partial.iter().map(|p| path_to_id(p)).collect(),
            affected: self.affected.iter().map(|p| path_to_id(p)).collect(),
        }
    }

    fn finish(&mut self, cancelled: bool) {
        let summary = self.summary();
        let task_id = self.task_id.to_string();
        self.ctl.emit(if cancelled {
            TaskEvent::Cancelled { task_id, summary }
        } else {
            TaskEvent::Finished { task_id, summary }
        });
    }

    fn abort(&self, error: AppError) {
        self.ctl.emit(TaskEvent::Failed {
            task_id: self.task_id.into(),
            error,
        });
    }

    /// Counts the work to do without following links. The per-source byte sizes
    /// let a same-volume rename advance the byte progress in one step.
    fn scan(&mut self, sources: &[PathBuf]) -> Flow<Vec<u64>> {
        let mut sizes = Vec::with_capacity(sources.len());
        let mut found = 0u64;
        for source in sources {
            let mut bytes = 0u64;
            let mut pending = vec![source.clone()];
            while let Some(path) = pending.pop() {
                self.check()?;
                let Ok(meta) = fs::symlink_metadata(&path) else {
                    continue;
                };
                found += 1;
                if meta.is_dir() {
                    if let Ok(entries) = fs::read_dir(&path) {
                        pending.extend(entries.flatten().map(|e| e.path()));
                    }
                } else if meta.is_file() {
                    bytes += meta.len();
                }
                if self.last_progress.elapsed() >= PROGRESS_INTERVAL {
                    self.last_progress = Instant::now();
                    self.ctl.emit(TaskEvent::Progress {
                        task_id: self.task_id.into(),
                        stage: TaskStage::Scanning,
                        completed: Some(found),
                        total: None,
                        unit: ProgressUnit::Items,
                    });
                }
            }
            self.total_bytes += bytes;
            self.total_items += 1;
            sizes.push(bytes);
        }
        Ok(sizes)
    }

    // -------------------------------------------------------- transfer

    fn transfer_one(
        &mut self,
        mode: TransferMode,
        source: &Path,
        dest_dir: &Path,
        dest_canon: &Path,
        size: u64,
    ) -> Flow {
        let Some(name) = source.file_name().map(OsStr::to_os_string) else {
            self.fail_msg(
                source,
                ErrorCategory::InvalidInput,
                "This item can't be transferred.",
            );
            return Ok(());
        };
        let meta = match fs::symlink_metadata(source) {
            Ok(meta) => meta,
            Err(e) => {
                self.fail_io(source, &e);
                return Ok(());
            }
        };
        if meta.is_dir() {
            let own = source
                .parent()
                .and_then(|p| fs::canonicalize(p).ok())
                .map(|p| p.join(&name));
            if own.is_some_and(|own| dest_canon.starts_with(own)) {
                self.fail_msg(
                    source,
                    ErrorCategory::InvalidInput,
                    format!(
                        "Can't {} \"{}\" into itself or one of its own subfolders.",
                        mode.verb(),
                        display_name(source)
                    ),
                );
                return Ok(());
            }
        }
        if mode == TransferMode::Move
            && let Some(parent) = source.parent()
        {
            self.affected.insert(parent.to_path_buf());
        }
        self.affected.insert(dest_dir.to_path_buf());

        let mut target = dest_dir.join(&name);
        for _ in 0..100 {
            self.check()?;
            match fs::symlink_metadata(&target) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    if self.place(mode, source, &target, size)? {
                        return Ok(());
                    }
                    // The name was taken in the meantime: ask again.
                }
                Err(e) => {
                    self.fail_io(&target, &e);
                    return Ok(());
                }
                Ok(existing) => {
                    let same_item = existing.dev() == meta.dev() && existing.ino() == meta.ino();
                    if mode == TransferMode::Move && same_item {
                        self.fail_msg(
                            source,
                            ErrorCategory::InvalidInput,
                            format!("\"{}\" is already in this folder.", display_name(source)),
                        );
                        return Ok(());
                    }
                    let prompt = ConflictPrompt {
                        conflict_id: String::new(),
                        source: source.to_path_buf(),
                        destination: target.clone(),
                        source_kind: entry_kind(&meta),
                        destination_kind: entry_kind(&existing),
                        same_item,
                    };
                    match self.decide(prompt)? {
                        ConflictDecision::Skip => {
                            self.skipped += 1;
                            self.done_items += 1;
                            self.done_bytes += size;
                            self.progress(false);
                            return Ok(());
                        }
                        ConflictDecision::KeepBoth => {
                            target = unique_name(dest_dir, &name, meta.is_dir());
                        }
                        ConflictDecision::Replace => {
                            let approved = (existing.dev(), existing.ino());
                            if self.replace(mode, source, &target, dest_dir, size, approved)? {
                                return Ok(());
                            }
                            // The destination changed after the user answered: the
                            // consent no longer applies, so ask again.
                            if self.remembered == Some(ConflictDecision::Replace) {
                                self.remembered = None;
                            }
                        }
                    }
                }
            }
        }
        self.fail_msg(
            source,
            ErrorCategory::Io,
            "The destination kept changing while it was being checked.",
        );
        Ok(())
    }

    fn decide(&mut self, mut prompt: ConflictPrompt) -> Flow<ConflictDecision> {
        if let Some(decision) = self.remembered
            && (decision != ConflictDecision::Replace || prompt.replaceable())
        {
            return Ok(decision);
        }
        self.conflicts += 1;
        prompt.conflict_id = format!("{}-c{}", self.task_id, self.conflicts);
        let resolution = self.ctl.ask(&prompt).ok_or(Cancelled)?;
        if resolution.apply_to_all {
            self.remembered = Some(resolution.decision);
        }
        if resolution.decision == ConflictDecision::Replace && !prompt.replaceable() {
            // The interface does not offer this; refuse rather than guess.
            return Ok(ConflictDecision::Skip);
        }
        Ok(resolution.decision)
    }

    /// Places `source` at the not-yet-existing `target`. `Ok(false)` means the
    /// target appeared meanwhile and the conflict must be decided again.
    fn place(&mut self, mode: TransferMode, source: &Path, target: &Path, size: u64) -> Flow<bool> {
        let before = self.failure_count();
        match mode {
            TransferMode::Copy => match self.copy_node(source, target, true, &mut None)? {
                Node::Exists => return Ok(false),
                Node::Done if self.failure_count() == before => self.succeeded += 1,
                _ => {}
            },
            TransferMode::Move => match rename_noreplace(source, target) {
                Ok(()) => {
                    self.succeeded += 1;
                    self.done_bytes += size;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
                #[cfg(target_os = "macos")]
                Err(e) if e.raw_os_error() == Some(EXDEV) => {
                    return self.move_across_volumes(source, target, before);
                }
                Err(e) => self.fail_io(source, &e),
            },
        }
        self.done_items += 1;
        self.progress(false);
        Ok(true)
    }

    /// Copy-then-delete. The source is removed only after the complete copy
    /// succeeded, and only the entries that were actually copied.
    #[cfg(target_os = "macos")]
    fn move_across_volumes(&mut self, source: &Path, target: &Path, before: usize) -> Flow<bool> {
        let mut copied: Option<Copied> = Some(Vec::new());
        match self.copy_node(source, target, true, &mut copied)? {
            Node::Exists => return Ok(false),
            Node::Done if self.failure_count() == before => {
                self.remove_copied_sources(copied.unwrap_or_default(), before);
            }
            _ => self.fail_msg(
                source,
                ErrorCategory::Io,
                format!(
                    "\"{}\" was not moved: copying to the other volume did not complete, \
                     so the original was kept.",
                    display_name(source)
                ),
            ),
        }
        self.done_items += 1;
        self.progress(true);
        Ok(true)
    }

    /// Removes only entries that are still exactly what was copied (same
    /// identity and version, under unchanged copied folders). Anything edited or
    /// replaced since is kept and reported.
    fn remove_copied_sources(&mut self, copied: Copied, before: usize) {
        let dirs: HashMap<PathBuf, (u64, u64)> = copied
            .iter()
            .filter(|c| c.is_dir)
            .map(|c| (c.path.clone(), (c.stamp.dev, c.stamp.ino)))
            .collect();
        for item in copied {
            let path = &item.path;
            let unchanged = fs::symlink_metadata(path).is_ok_and(|now| {
                if item.is_dir {
                    now.is_dir() && (now.dev(), now.ino()) == (item.stamp.dev, item.stamp.ino)
                } else {
                    !now.is_dir() && Stamp::of(&now) == item.stamp
                }
            }) && path.ancestors().skip(1).all(|ancestor| {
                dirs.get(ancestor).is_none_or(|id| {
                    fs::symlink_metadata(ancestor)
                        .is_ok_and(|m| m.is_dir() && (m.dev(), m.ino()) == *id)
                })
            });
            if !unchanged {
                self.fail_msg(
                    path,
                    ErrorCategory::Io,
                    format!(
                        "\"{}\" changed after it was copied, so the original was kept; \
                         it exists in both places.",
                        display_name(path)
                    ),
                );
                continue;
            }
            let result = if item.is_dir {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            };
            if let Err(e) = result {
                let name = display_name(path);
                let mut app = AppError::from_io(self.operation, path, &e);
                app.message = format!(
                    "\"{name}\" was copied but the original could not be removed ({e}); \
                     it exists in both places."
                );
                self.fail(path, app);
            }
        }
        if self.failure_count() == before {
            self.succeeded += 1;
        }
    }

    /// Replaces the file or link that the user approved (`approved` is its
    /// device/inode). The new item is fully written under a temporary name, then
    /// atomically swapped into place; the displaced item is checked to be the
    /// approved one (otherwise the swap is undone) before it goes to the Trash.
    /// `Ok(false)` means the destination changed and must be decided again.
    fn replace(
        &mut self,
        mode: TransferMode,
        source: &Path,
        target: &Path,
        dest_dir: &Path,
        size: u64,
        approved: (u64, u64),
    ) -> Flow<bool> {
        self.temporaries += 1;
        let stem = format!(".mfm-replace-{}-{}", std::process::id(), self.temporaries);
        let temporary = dest_dir.join(format!("{stem}.tmp"));
        let holder = dest_dir.join(format!("{stem}.old"));
        let before = self.failure_count();
        let mut copied: Option<Copied> = Some(Vec::new());
        match self.copy_node(source, &temporary, true, &mut copied)? {
            Node::Done if self.failure_count() == before => {}
            other => {
                if other == Node::Exists {
                    self.fail_msg(
                        source,
                        ErrorCategory::Io,
                        "A temporary name was already taken.",
                    );
                } else {
                    let _ = fs::remove_file(&temporary);
                }
                return Ok(true);
            }
        }
        if let Err(e) = rename_swap(&temporary, target) {
            let _ = fs::remove_file(&temporary);
            if e.kind() == io::ErrorKind::NotFound {
                return Ok(false);
            }
            self.fail_io(target, &e);
            return Ok(true);
        }
        // `temporary` now holds whatever was at `target`.
        let displaced = fs::symlink_metadata(&temporary);
        if !displaced
            .as_ref()
            .is_ok_and(|m| !m.is_dir() && (m.dev(), m.ino()) == approved)
        {
            let restored = self.undo_swap(&temporary, target, source);
            return Ok(!restored);
        }
        let held = target
            .file_name()
            .map(|name| holder.join(name))
            .filter(|_| fs::create_dir(&holder).is_ok());
        let Some(held) = held else {
            self.undo_swap(&temporary, target, source);
            self.fail_msg(
                source,
                ErrorCategory::Io,
                "Could not prepare to replace the item; nothing was changed.",
            );
            return Ok(true);
        };
        if let Err(e) = rename_noreplace(&temporary, &held) {
            let _ = fs::remove_dir(&holder);
            self.undo_swap(&temporary, target, source);
            self.fail_io(target, &e);
            return Ok(true);
        }
        if let Err(error) = self.trash.trash(&held) {
            // Put the old item back; the new one returns to the held name and goes away.
            if rename_swap(target, &held).is_ok() {
                let _ = fs::remove_file(&held);
            }
            let _ = fs::remove_dir(&holder);
            self.fail(source, error);
            return Ok(true);
        }
        let _ = fs::remove_dir(&holder);
        if mode == TransferMode::Move {
            self.remove_copied_sources(copied.unwrap_or_default(), before);
            if let Some(parent) = source.parent() {
                self.affected.insert(parent.to_path_buf());
            }
        } else {
            self.succeeded += 1;
        }
        self.done_items += 1;
        self.done_bytes += size;
        self.progress(false);
        Ok(true)
    }

    /// Reverses the swap after the displaced item turned out not to be the
    /// approved one. Returns `true` when the original was restored and the
    /// conflict must be asked again.
    fn undo_swap(&mut self, temporary: &Path, target: &Path, source: &Path) -> bool {
        if rename_swap(temporary, target).is_ok() {
            let _ = fs::remove_file(temporary);
            true
        } else {
            self.fail_msg(
                source,
                ErrorCategory::Io,
                format!(
                    "\"{}\" changed while it was being replaced and could not be restored \
                     automatically; the item that was there is now named \"{}\".",
                    display_name(target),
                    display_name(temporary)
                ),
            );
            false
        }
    }

    // ------------------------------------------------------------ copy

    fn copy_node(
        &mut self,
        src: &Path,
        dst: &Path,
        top: bool,
        copied: &mut Option<Copied>,
    ) -> Flow<Node> {
        self.check()?;
        let meta = match fs::symlink_metadata(src) {
            Ok(meta) => meta,
            Err(e) => {
                self.fail_io(src, &e);
                return Ok(Node::Failed);
            }
        };
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            let result = fs::read_link(src).and_then(|link| std::os::unix::fs::symlink(link, dst));
            let node = self.created(result, src, top, || {
                if let Some(list) = copied {
                    list.push(CopiedItem {
                        path: src.to_path_buf(),
                        is_dir: false,
                        stamp: Stamp::of(&meta),
                    });
                }
            });
            return Ok(node);
        }
        if file_type.is_dir() {
            return self.copy_directory(src, dst, &meta, top, copied);
        }
        if file_type.is_file() {
            return self.copy_file(src, dst, top, copied);
        }
        self.fail_msg(
            src,
            ErrorCategory::Unsupported,
            format!(
                "\"{}\" is a special file (device, socket or pipe) and can't be copied.",
                display_name(src)
            ),
        );
        Ok(Node::Failed)
    }

    fn created(
        &mut self,
        result: io::Result<()>,
        src: &Path,
        top: bool,
        on_success: impl FnOnce(),
    ) -> Node {
        match result {
            Ok(()) => {
                on_success();
                Node::Done
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && top => Node::Exists,
            Err(e) => {
                self.fail_io(src, &e);
                Node::Failed
            }
        }
    }

    fn copy_directory(
        &mut self,
        src: &Path,
        dst: &Path,
        meta: &Metadata,
        top: bool,
        copied: &mut Option<Copied>,
    ) -> Flow<Node> {
        let created = self.created(fs::create_dir(dst), src, top, || {});
        if created != Node::Done {
            return Ok(created);
        }
        let clean = match self.copy_children(src, dst, copied) {
            Ok(clean) => clean,
            Err(cancelled) => {
                if top {
                    self.partial.push(dst.to_path_buf());
                }
                return Err(cancelled);
            }
        };
        // Applied last so a read-only source folder can still be filled.
        if let Ok(dir) = File::open(dst) {
            let _ = dir.set_permissions(meta.permissions());
            if let Ok(modified) = meta.modified() {
                let _ = dir.set_modified(modified);
            }
        }
        if clean {
            if let Some(list) = copied {
                list.push(CopiedItem {
                    path: src.to_path_buf(),
                    is_dir: true,
                    stamp: Stamp::of(meta),
                });
            }
            Ok(Node::Done)
        } else {
            if top {
                self.partial.push(dst.to_path_buf());
            }
            Ok(Node::Failed)
        }
    }

    /// Copies the entries of `src` into the existing folder `dst`; `false` if any failed.
    fn copy_children(&mut self, src: &Path, dst: &Path, copied: &mut Option<Copied>) -> Flow<bool> {
        let mut clean = true;
        match fs::read_dir(src) {
            Err(e) => {
                self.fail_io(src, &e);
                clean = false;
            }
            Ok(entries) => {
                for entry in entries {
                    self.check()?;
                    match entry {
                        Err(e) => {
                            self.fail_io(src, &e);
                            clean = false;
                        }
                        Ok(entry) => {
                            let child = dst.join(entry.file_name());
                            if self.copy_node(&entry.path(), &child, false, copied)? != Node::Done {
                                clean = false;
                            }
                        }
                    }
                }
            }
        }
        Ok(clean)
    }

    fn copy_file(
        &mut self,
        src: &Path,
        dst: &Path,
        top: bool,
        copied: &mut Option<Copied>,
    ) -> Flow<Node> {
        let opened = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(src);
        let mut input = match opened {
            Ok(file) => file,
            Err(e) => {
                self.fail_io(src, &e);
                return Ok(Node::Failed);
            }
        };
        let before = match input.metadata() {
            Ok(meta) if meta.is_file() => meta,
            Ok(_) => {
                self.fail_msg(src, ErrorCategory::Unsupported, "It is not a regular file.");
                return Ok(Node::Failed);
            }
            Err(e) => {
                self.fail_io(src, &e);
                return Ok(Node::Failed);
            }
        };
        let mut output = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dst)
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && top => return Ok(Node::Exists),
            Err(e) => {
                let app = AppError::from_io(self.operation, dst, &e);
                self.fail(src, app);
                return Ok(Node::Failed);
            }
        };

        let mut buffer = vec![0u8; CHUNK];
        let mut written = 0u64;
        let outcome: Result<(), io::Error> = loop {
            if self.ctl.is_cancelled() {
                drop(output);
                let _ = fs::remove_file(dst);
                return Err(Cancelled);
            }
            let n = match input.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => break Err(e),
            };
            if let Err(e) = output.write_all(&buffer[..n]) {
                break Err(e);
            }
            written += n as u64;
            self.done_bytes += n as u64;
            self.progress(false);
        };
        if let Err(e) = outcome {
            drop(output);
            let _ = fs::remove_file(dst);
            self.fail_io(src, &e);
            return Ok(Node::Failed);
        }
        let after = input.metadata().ok();
        let unchanged = after.as_ref().is_some_and(|after| {
            after.len() == before.len()
                && after.mtime() == before.mtime()
                && after.mtime_nsec() == before.mtime_nsec()
                && after.ctime() == before.ctime()
                && after.ctime_nsec() == before.ctime_nsec()
        }) && written == before.len();
        if !unchanged {
            drop(output);
            let _ = fs::remove_file(dst);
            self.fail_msg(
                src,
                ErrorCategory::Io,
                format!(
                    "\"{}\" changed while it was being copied, so the copy was discarded.",
                    display_name(src)
                ),
            );
            return Ok(Node::Failed);
        }
        copy_metadata(&input, &output);
        let _ = output.set_permissions(before.permissions());
        if let Ok(modified) = before.modified() {
            let _ = output.set_modified(modified);
        }
        if let (Some(list), Some(after)) = (copied, after.as_ref()) {
            list.push(CopiedItem {
                path: src.to_path_buf(),
                is_dir: false,
                stamp: Stamp::of(after),
            });
        }
        Ok(Node::Done)
    }
}

fn path_access(path: &Path, mode: libc::c_int) -> io::Result<()> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `c` is a valid NUL-terminated string.
    if unsafe { libc::access(c.as_ptr(), mode) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Copies or moves `sources` into `destination`, then emits exactly one
/// terminal event (`Finished`, `Cancelled` or `Failed`).
pub fn run_transfer(
    task_id: &str,
    ctl: &dyn TaskControl,
    trash: &dyn Trasher,
    mode: TransferMode,
    sources: Vec<PathBuf>,
    destination: &Path,
) {
    let operation = mode.verb();
    let mut run = Run::new(task_id, ctl, trash, operation);

    let dest_error = |e: &io::Error| AppError::from_io(operation, destination, e);
    match fs::metadata(destination) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return run.abort(AppError::new(
                ErrorCategory::InvalidInput,
                operation,
                Some(display_name(destination)),
                "The destination is not a folder.",
            ));
        }
        Err(e) => return run.abort(dest_error(&e)),
    }
    if let Err(e) = path_access(destination, libc::W_OK | libc::X_OK) {
        let name = display_name(destination);
        return run.abort(AppError::new(
            if e.kind() == io::ErrorKind::PermissionDenied {
                ErrorCategory::PermissionDenied
            } else {
                ErrorCategory::Io
            },
            operation,
            Some(name.clone()),
            format!("Can't write to \"{name}\": {e}."),
        ));
    }
    let dest_canon = match fs::canonicalize(destination) {
        Ok(path) => path,
        Err(e) => return run.abort(dest_error(&e)),
    };

    let Ok(sizes) = run.scan(&sources) else {
        return run.finish(true);
    };
    run.progress(true);
    for (source, size) in sources.iter().zip(sizes) {
        if run
            .transfer_one(mode, source, destination, &dest_canon, size)
            .is_err()
        {
            return run.finish(true);
        }
    }
    run.progress(true);
    run.finish(false);
}

/// Moves `paths` to the Trash one by one; never deletes permanently.
pub fn run_trash(task_id: &str, ctl: &dyn TaskControl, trash: &dyn Trasher, paths: Vec<PathBuf>) {
    let mut run = Run::new(task_id, ctl, trash, "move to the Trash");
    run.total_items = paths.len() as u64;
    for path in &paths {
        if ctl.is_cancelled() {
            return run.finish(true);
        }
        if let Err(error) = trash_one(&mut run, path) {
            run.fail(path, error);
        }
        run.done_items += 1;
        run.progress(false);
    }
    run.progress(true);
    run.finish(false);
}

fn trash_one(run: &mut Run, path: &Path) -> Result<(), AppError> {
    let operation = "move to the Trash";
    fs::symlink_metadata(path).map_err(|e| AppError::from_io(operation, path, &e))?;
    let in_trash = path.components().any(|c| {
        let name: &OsStr = c.as_os_str();
        name == OsStr::new(".Trash") || name == OsStr::new(".Trashes")
    });
    if in_trash || path.parent().is_none() {
        let name = display_name(path);
        return Err(AppError::new(
            ErrorCategory::Unsupported,
            operation,
            Some(name.clone()),
            format!(
                "\"{name}\" can't be moved to the Trash (it is already there or is a volume root). \
                 This app never deletes permanently."
            ),
        ));
    }
    run.trash.trash(path)?;
    run.succeeded += 1;
    if let Some(parent) = path.parent() {
        run.affected.insert(parent.to_path_buf());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
