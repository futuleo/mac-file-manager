//! Typed command/event contracts shared with the TypeScript client
//! (`src/backend/contracts.ts`). Later slices implement the commands; this
//! module only fixes the wire format. All structs serialize as camelCase.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const TASK_EVENT: &str = "task-event";
pub const SEARCH_EVENT: &str = "search-event";
pub const DIRECTORY_EVENT: &str = "directory-event";
/// Native menu selections forwarded to the frontend (payload: the menu item id).
pub const MENU_EVENT: &str = "menu-action";

/// Entries are addressed by `id`, a lossless hex encoding of the raw path
/// bytes, because macOS filenames are not guaranteed to be valid UTF-8.
/// `path` and `name` are lossy and for display only; never send them back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
    pub is_symlink: bool,
    /// A symbolic link whose target cannot be resolved (`kind` is then `Other`).
    pub is_broken_link: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCategory {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    InvalidInput,
    Unsupported,
    Cancelled,
    Io,
}

/// A failed operation is always an error, never an empty success.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub category: ErrorCategory,
    pub operation: String,
    /// Safe, user-presentable context such as a file name (never secrets).
    pub context: Option<String>,
    pub message: String,
}

impl AppError {
    pub fn new(
        category: ErrorCategory,
        operation: &str,
        context: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            operation: operation.into(),
            context,
            message: message.into(),
        }
    }

    /// Maps an I/O failure to a category and a readable message. `path` is only
    /// used (lossily) as display context.
    pub fn from_io(operation: &str, path: &Path, error: &std::io::Error) -> Self {
        use std::io::ErrorKind;
        let (category, reason) = match error.kind() {
            ErrorKind::NotFound => (
                ErrorCategory::NotFound,
                "it no longer exists or is unavailable",
            ),
            ErrorKind::PermissionDenied => (
                ErrorCategory::PermissionDenied,
                "permission was denied (the item may be protected by macOS privacy settings)",
            ),
            ErrorKind::AlreadyExists => (ErrorCategory::AlreadyExists, "it already exists"),
            ErrorKind::NotADirectory => (ErrorCategory::InvalidInput, "it is not a folder"),
            ErrorKind::IsADirectory => (ErrorCategory::InvalidInput, "it is a folder"),
            ErrorKind::InvalidInput => (ErrorCategory::InvalidInput, "the path is invalid"),
            _ => (ErrorCategory::Io, "an input/output error occurred"),
        };
        let name = display_name(path);
        Self::new(
            category,
            operation,
            Some(name.clone()),
            format!("Could not {operation} \"{name}\": {reason} ({error})."),
        )
    }
}

/// Lossy last path component for display; the root is shown as its full path.
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub type TaskId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStage {
    Queued,
    Scanning,
    Running,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictDecision {
    Skip,
    KeepBoth,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFailure {
    pub id: String,
    pub error: AppError,
}

/// What `completed`/`total` of a progress event count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressUnit {
    Items,
    Bytes,
}

/// Outcome counters shared by the terminal events of a file operation.
/// `succeeded` and `skipped` count the requested top-level items that were
/// completed without any failure, or were skipped by a conflict decision;
/// `failed` lists failed items at any depth (capped, with `failed_omitted`
/// counting the rest). `affected` lists the lossless ids of folders whose
/// contents changed or may have changed, so views of them can be refreshed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub succeeded: u64,
    pub skipped: u64,
    pub failed: Vec<ItemFailure>,
    pub failed_omitted: u64,
    /// Folders left only partly copied (cancelled or failed midway) and not rolled back.
    pub partial: Vec<String>,
    pub affected: Vec<String>,
}

/// Progress for long operations. `completed`/`total` are `None` when the amount
/// of work is not measurable; consumers must not invent percentages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        task_id: TaskId,
        stage: TaskStage,
        completed: Option<u64>,
        total: Option<u64>,
        unit: ProgressUnit,
    },
    /// The task is paused until `resolve_conflict` is called with `conflict_id`.
    /// `same_item` means the destination is the source itself (copy into its own
    /// folder). Replacing is only possible when neither side is a folder and the
    /// items are not the same.
    #[serde(rename_all = "camelCase")]
    Conflict {
        task_id: TaskId,
        conflict_id: String,
        source_id: String,
        destination_id: String,
        source_name: String,
        destination_name: String,
        source_kind: EntryKind,
        destination_kind: EntryKind,
        same_item: bool,
    },
    /// Completion with partial failures is reported, not hidden.
    #[serde(rename_all = "camelCase")]
    Finished {
        task_id: TaskId,
        #[serde(flatten)]
        summary: TaskSummary,
    },
    /// Cancellation stops further work; completed work is not rolled back.
    #[serde(rename_all = "camelCase")]
    Cancelled {
        task_id: TaskId,
        #[serde(flatten)]
        summary: TaskSummary,
    },
    /// The task could not start or run at all; nothing was reported as done.
    #[serde(rename_all = "camelCase")]
    Failed { task_id: TaskId, error: AppError },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    Filename,
    Content,
}

/// Spotlight query lifecycle. Spotlight does not expose whether a location is
/// indexed, so `Live` never means "complete"; the UI must say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchState {
    /// The initial pass over the index is running; more results may arrive.
    Gathering,
    /// The initial pass ended and the query still watches the index for changes.
    Live,
    Cancelled,
}

/// Search events are tagged with the caller's `search_id`. Every search ends
/// with `Cancelled` (the caller cancelled) or `Failed`; otherwise it keeps
/// reporting changes until cancelled. After a terminal event nothing follows.
/// `Results` are upserts by `id` (a later entry replaces an earlier one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    /// `skipped` counts Spotlight matches that were left out because the item
    /// no longer exists or could not be examined (the index can be stale).
    #[serde(rename_all = "camelCase")]
    Results {
        search_id: String,
        entries: Vec<FileEntry>,
        skipped: u64,
    },
    /// Items that no longer match or no longer exist.
    #[serde(rename_all = "camelCase")]
    Removed { search_id: String, ids: Vec<String> },
    #[serde(rename_all = "camelCase")]
    State {
        search_id: String,
        state: SearchState,
    },
    /// The result limit was reached: the query was stopped and no further
    /// matches are delivered, so the list is incomplete by design.
    #[serde(rename_all = "camelCase")]
    Limited { search_id: String, limit: u64 },
    #[serde(rename_all = "camelCase")]
    Failed { search_id: String, error: AppError },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaceGroup {
    /// The home folder and the standard folders inside it, plus /Applications.
    Quick,
    /// The startup volume and mounted volumes.
    Volume,
}

/// A sidebar location backed by a real folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub label: String,
    pub group: PlaceGroup,
    pub entry: FileEntry,
}

/// Locations that exist, plus the ones that exist but could not be examined.
/// Standard folders that are simply absent are omitted, not reported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub places: Vec<Place>,
    pub failures: Vec<ItemFailure>,
}

/// Incremental directory read. Every read ends in exactly one terminal event
/// (`finished`, `failed` or `cancelled`); a failed read is never reported as an
/// empty `finished`. Entries are in directory order, not sorted. `failures`
/// lists entries that exist but whose metadata could not be read, so nothing is
/// silently dropped (`failure.id` is the entry, or the directory itself when
/// the directory stream failed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DirectoryEvent {
    #[serde(rename_all = "camelCase")]
    Entries {
        read_id: String,
        entries: Vec<FileEntry>,
        failures: Vec<ItemFailure>,
    },
    /// `entries` and `failed` are totals over the whole read.
    #[serde(rename_all = "camelCase")]
    Finished {
        read_id: String,
        entries: u64,
        failed: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failed { read_id: String, error: AppError },
    #[serde(rename_all = "camelCase")]
    Cancelled { read_id: String },
}

/// Whether the native classes are present at runtime. This is API presence only,
/// not proof that the integration works (e.g. external dragging is unexercised).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilities {
    pub spotlight_query: bool,
    pub quick_look_panel: bool,
    pub trash: bool,
    pub system_icons: bool,
    pub drag_session: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub app_version: String,
    pub os_version: String,
    pub arch: String,
    pub deployment_target: String,
    pub capabilities: NativeCapabilities,
}

pub fn path_to_id(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn id_to_path(id: &str) -> Option<PathBuf> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    if id.len() % 2 != 0 || !id.is_ascii() {
        return None;
    }
    let bytes = (0..id.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(PathBuf::from(OsString::from_vec(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    #[test]
    fn path_ids_round_trip_non_utf8_names() {
        let raw = PathBuf::from(OsString::from_vec(b"/tmp/caf\xe9 \xff.txt".to_vec()));
        assert!(raw.to_str().is_none());
        let id = path_to_id(&raw);
        assert_eq!(id_to_path(&id), Some(raw));
        assert_eq!(id_to_path("zz"), None);
        assert_eq!(id_to_path("abc"), None);
    }

    #[test]
    fn file_entry_uses_camel_case_wire_format() {
        let entry = FileEntry {
            id: "2f".into(),
            path: "/".into(),
            name: "/".into(),
            kind: EntryKind::Directory,
            size: None,
            modified_ms: Some(1),
            is_symlink: false,
            is_broken_link: false,
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            json!({"id":"2f","path":"/","name":"/","kind":"directory","size":null,"modifiedMs":1,"isSymlink":false,"isBrokenLink":false})
        );
    }

    #[test]
    fn events_are_tagged_and_round_trip() {
        let event = TaskEvent::Finished {
            task_id: "t1".into(),
            summary: TaskSummary {
                succeeded: 2,
                skipped: 1,
                failed: vec![ItemFailure {
                    id: "61".into(),
                    error: AppError {
                        category: ErrorCategory::PermissionDenied,
                        operation: "copy".into(),
                        context: Some("a".into()),
                        message: "Permission denied".into(),
                    },
                }],
                failed_omitted: 0,
                partial: vec![],
                affected: vec!["2f".into()],
            },
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "finished");
        assert_eq!(value["taskId"], "t1");
        assert_eq!(value["succeeded"], 2);
        assert_eq!(value["affected"][0], "2f");
        assert_eq!(value["failed"][0]["error"]["category"], "permissionDenied");
        assert_eq!(serde_json::from_value::<TaskEvent>(value).unwrap(), event);

        let results = SearchEvent::Results {
            search_id: "s".into(),
            entries: vec![],
            skipped: 2,
        };
        let value = serde_json::to_value(&results).unwrap();
        assert_eq!(value["type"], "results");
        assert_eq!(value["searchId"], "s");
        assert_eq!(value["skipped"], 2);
        let removed = serde_json::to_value(SearchEvent::Removed {
            search_id: "s".into(),
            ids: vec!["61".into()],
        })
        .unwrap();
        assert_eq!(removed["type"], "removed");
        assert_eq!(removed["ids"][0], "61");
        let limited = serde_json::to_value(SearchEvent::Limited {
            search_id: "s".into(),
            limit: 10,
        })
        .unwrap();
        assert_eq!(limited["type"], "limited");
        assert_eq!(limited["limit"], 10);

        let search = SearchEvent::State {
            search_id: "s".into(),
            state: SearchState::Gathering,
        };
        assert_eq!(
            serde_json::to_value(search).unwrap(),
            json!({"type":"state","searchId":"s","state":"gathering"})
        );
    }
}
