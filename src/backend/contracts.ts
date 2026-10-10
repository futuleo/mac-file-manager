// TypeScript mirror of src-tauri/src/contracts.rs. Keep both in sync; the Rust
// tests pin the JSON wire format these types describe.

export const TASK_EVENT = "task-event";
export const SEARCH_EVENT = "search-event";
export const DIRECTORY_EVENT = "directory-event";
/** Native menu selections; the payload is the menu item id (a string). */
export const MENU_EVENT = "menu-action";

export type EntryKind = "file" | "directory" | "other";

/** `id` is a lossless hex encoding of the raw path bytes; `path`/`name` are display-only. */
export interface FileEntry {
  id: string;
  path: string;
  name: string;
  kind: EntryKind;
  size: number | null;
  modifiedMs: number | null;
  isSymlink: boolean;
  /** A symbolic link whose target cannot be resolved (`kind` is then "other"). */
  isBrokenLink: boolean;
}

export type ErrorCategory =
  | "notFound"
  | "permissionDenied"
  | "alreadyExists"
  | "invalidInput"
  | "unsupported"
  | "cancelled"
  | "io";

export interface AppError {
  category: ErrorCategory;
  operation: string;
  context: string | null;
  message: string;
}

/**
 * Incremental directory read. Each read ends with exactly one terminal event
 * (`finished`, `failed`, `cancelled`); `failed` is never an empty folder.
 * `failures` are entries whose metadata could not be read (`id` is the entry, or
 * the folder itself if the directory stream failed). Entries are unsorted.
 */
export type DirectoryEvent =
  | { type: "entries"; readId: string; entries: FileEntry[]; failures: ItemFailure[] }
  | { type: "finished"; readId: string; entries: number; failed: number }
  | { type: "failed"; readId: string; error: AppError }
  | { type: "cancelled"; readId: string };

export type PlaceGroup = "quick" | "volume";
/** A sidebar location backed by a real folder. */
export interface Place {
  label: string;
  group: PlaceGroup;
  entry: FileEntry;
}
/** `failures` are locations that exist but could not be examined; absent standard folders are omitted. */
export interface Places {
  places: Place[];
  failures: ItemFailure[];
}

export type TaskStage = "queued" | "scanning" | "running" | "finalizing";
export type ConflictDecision = "skip" | "keepBoth" | "replace";
export interface ItemFailure {
  id: string;
  error: AppError;
}

/** What `completed`/`total` count: items (folders, trash) or bytes of file data. */
export type ProgressUnit = "items" | "bytes";

/** Outcome of a task. `failed` is capped; `failedOmitted` counts the rest. `affected` are the folder ids whose contents changed. */
export interface TaskSummary {
  succeeded: number;
  skipped: number;
  failed: ItemFailure[];
  failedOmitted: number;
  affected: string[];
}

/** A task ends with exactly one of `finished`, `cancelled` or `failed`. Cancelling never rolls back finished items. */
export type TaskEvent =
  | { type: "progress"; taskId: string; stage: TaskStage; completed: number | null; total: number | null; unit: ProgressUnit }
  | {
      type: "conflict";
      taskId: string;
      conflictId: string;
      sourceId: string;
      destinationId: string;
      sourceName: string;
      destinationName: string;
      sourceKind: EntryKind;
      destinationKind: EntryKind;
      /** The destination is the source itself (e.g. copy into its own folder). */
      sameItem: boolean;
    }
  | ({ type: "finished"; taskId: string } & TaskSummary)
  | ({ type: "cancelled"; taskId: string } & TaskSummary)
  | { type: "failed"; taskId: string; error: AppError };

export type SearchMode = "filename" | "content";
export type SearchState = "gathering" | "live" | "cancelled";
export type SearchEvent =
  | { type: "results"; searchId: string; entries: FileEntry[] }
  | { type: "state"; searchId: string; state: SearchState }
  | { type: "failed"; searchId: string; error: AppError };

export interface NativeCapabilities {
  spotlightQuery: boolean;
  quickLookPanel: boolean;
  trash: boolean;
  systemIcons: boolean;
  dragSession: boolean;
}

export interface PlatformInfo {
  appVersion: string;
  osVersion: string;
  arch: string;
  deploymentTarget: string;
  capabilities: NativeCapabilities;
}

/** Commands registered in the backend today. */
export interface ImplementedCommands {
  get_platform_info: { args: Record<never, never>; result: PlatformInfo };
  get_home_directory: { args: Record<never, never>; result: FileEntry };
  /** The containing folder, or null for the root. */
  parent_directory: { args: { id: string }; result: FileEntry | null };
  /**
   * Validates a typed path (`~` expands to home; `.`/`..` resolve lexically like `cd`).
   * Rejects with `notFound`/`invalidInput`/`permissionDenied` unless it is an existing folder.
   */
  resolve_directory: { args: { path: string }; result: FileEntry };
  /** Home, existing standard folders, /Applications, the startup volume and mounted volumes. */
  list_places: { args: Record<never, never>; result: Places };
  /** Returns once queued; results arrive on DIRECTORY_EVENT tagged with `readId`. */
  start_directory_read: { args: { readId: string; id: string }; result: void };
  /** Idempotent. */
  cancel_directory_read: { args: { readId: string }; result: void };
  /** Opens an existing regular file with its default macOS application. */
  open_item: { args: { id: string }; result: void };
  /** PNG data URL of the system icon; `size` is a pixel hint (8-256). */
  get_icon: { args: { id: string; size: number }; result: string };
  /** Returns once queued; progress, conflicts and the result arrive on TASK_EVENT tagged with `taskId`. */
  start_transfer: {
    args: { taskId: string; moveItems: boolean; sourceIds: string[]; destinationId: string };
    result: void;
  };
  /** Moves to the macOS Trash (recoverable); there is no permanent delete. */
  trash_items: { args: { taskId: string; ids: string[] }; result: void };
  /** Answers a `conflict` event; rejects if it is no longer pending. */
  resolve_conflict: { args: { conflictId: string; decision: ConflictDecision; applyToAll: boolean }; result: void };
  /** Idempotent; stops future work without rolling back. */
  cancel_task: { args: { taskId: string }; result: void };
  /** `name` null picks "New folder", "New folder 2", ... Never overwrites. */
  create_folder: { args: { parentId: string; name: string | null }; result: FileEntry };
  /** Same-folder rename that never replaces another item. */
  rename_item: { args: { id: string; newName: string }; result: FileEntry };
  /** Applies copy/cut/paste/selectAll to the focused text field. */
  edit_action: { args: { action: "copy" | "cut" | "paste" | "selectAll" }; result: void };
}

/**
 * Commands later slices implement. Type-only: they are deliberately not part of
 * `ImplementedCommands`, so the client cannot call them until the backend exists.
 * Rejections carry an `AppError`.
 */
export interface PlannedCommands {
  start_search: { args: { searchId: string; scopeId: string; mode: SearchMode; query: string }; result: void }; // spotlight-search; results via SEARCH_EVENT
  cancel_search: { args: { searchId: string }; result: void };
  show_quick_look: { args: { ids: string[] }; result: void }; // quick-look
}
