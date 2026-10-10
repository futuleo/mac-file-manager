# mac-file-manager

A macOS file manager with a Windows-10-style interface.
The Tauri 2 + React/TypeScript + Rust foundation, the read-only **filesystem
backend** and the **Explorer UI shell** exist: tab strip, ribbon-inspired
command area, back/forward/up/refresh, breadcrumb/address bar, sidebar of real
locations, a virtualized details list (Name / Date modified / Type / Size) and a
status bar, all wired to the real backend commands. **File operations** (new
folder, copy, cut/paste move, rename, Move to the Trash) are implemented; see
[File operations](#file-operations). Search, preview, Finder drag-and-drop,
Properties and "Move to" are **not implemented**; their controls are shown
disabled ("Not available yet").

See [plan.md](plan.md) for product scope and implementation tasks.
See [.github/AUTONOMY.md](.github/AUTONOMY.md) for the writer/reviewer/fix/merge
cycle, model assignments, validation commands, and runtime requirements.

## Requirements

- macOS on Apple Silicon (`aarch64-apple-darwin`) or Intel (`x86_64-apple-darwin`),
  with Xcode (or Command Line Tools) installed.
- Node.js 24 and npm 11 (CI uses Node 24).
- Rust ≥ 1.90 with `rustfmt`. `rust-version = "1.90"` in `Cargo.toml` is the
  minimum required by the locked dependencies (Tauri 2.12.2 and muda 0.20.0 require 1.90;
  `time` 0.3.55 and `darling` 0.24.1 require 1.88). `cargo check --all-targets` and
  `cargo test --locked` were run on 1.90.0; the full chain and native build on 1.99.0.
  Install with [rustup](https://rustup.rs) and make sure `~/.cargo/bin` is on `PATH`.

Compatibility, as established so far:

| Item | Status |
|---|---|
| macOS 26.6.1 on arm64, Xcode 27.0 | Built, tested and launched (process stayed alive; no GUI inspection, see Limitations) |
| x86_64 | `cargo check --target x86_64-apple-darwin` passes; not built, linked or run |
| macOS deployment target | **12.0** is only the *configured* target in `tauri.conf.json` (`bundle.macOS.minimumSystemVersion`) and `DEPLOYMENT_TARGET` in `src-tauri/src/lib.rs`; it is not a support claim. All native APIs used (NSMetadataQuery, QLPreviewPanel, `trashItemAtURL`, NSDraggingSession) predate it; it was chosen, and **no macOS older than 26 has been tested** |

## Setup, run, check and build

```sh
npm ci                                   # install JS dependencies from the lockfile
npm run tauri dev                        # run the desktop app with hot reload
npm run check                            # TypeScript type check
npm test                                 # Vitest unit tests
npm run build                            # production frontend build into dist/
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build -- --no-bundle       # native release binary
```

The `--no-bundle` build produces `src-tauri/target/release/mac-file-manager`
(not a `.app`, not signed or notarized). Signing and notarization are out of scope.

## Structure

- `src/` – React UI. `src/backend/contracts.ts` mirrors the Rust wire types and
  lists implemented and planned commands; `src/backend/client.ts` is the only
  place that calls `invoke`, restricted to implemented commands.
- `src-tauri/src/contracts.rs` – command/event contracts: `FileEntry` (with a
  lossless hex path `id` for non-UTF-8 names), `AppError`, `TaskEvent`
  (progress, conflict, finished with partial failures, cancelled, failed),
  `SearchEvent`, `PlatformInfo`. Rust tests pin the JSON format.
- `src-tauri/src/filesystem.rs` – read-only filesystem service (see
  [Filesystem backend](#filesystem-backend)).
- `src/backend/directory.ts` – directory-read client (`readDirectory`);
  `src/App.tsx` – orchestrator (tabs reducer, preferences, menu events);
  `src/explorer/` – pure models (`tabs`, `history`, `path`, `selection`, `sort`,
  `virtual`, `preferences`); `TabReader` (one cancellable read per tab),
  `FileList` (virtualized grid), `NavBar`, `Sidebar`, `TabStrip`, `Ribbon`,
  `ContextMenu`, `StatusBar`; `src/iconQueue.ts` + `FileIcon.tsx` – lazy,
  bounded, cancellable icons; `src/PlatformPanel.tsx` – native class presence.
- `src-tauri/src/operations.rs` (+ `operations/tests.rs`) – file-operation engine;
  `src-tauri/src/tasks.rs` – task registry (cancel, conflict answers);
  `src/operations/` (model + `useOperations` hook), `OperationsPanel`, `NameDialog`.
- `src-tauri/src/macos.rs` – native bridge (objc2). `menu.rs` – native menu bar;
  actions for later slices appear disabled with their Command shortcuts.
- `src-tauri/examples/` – feasibility spikes, not shipped:
  `cargo run --manifest-path src-tauri/Cargo.toml --example platform_spike`
  (Spotlight, Trash, icons) and `--example quicklook_spike` (needs a GUI session).
  Each run creates its own exclusively named directory (`~/mfm-spike-*` for
  Spotlight, which needs an indexed location; `$TMPDIR/mfm-spike-ql-*` for Quick Look),
  never writes into an existing path, and removes only that directory, reporting
  any cleanup failure (`src-tauri/src/spike_fixture.rs`, with unit tests using temporary
  directories only).

Security baseline: no plugins, no shell/opener/fs permissions; the main-window
capability only allows event listen/unlisten; the CSP allows only `'self'` and
Tauri IPC (no remote content); the app makes no network requests and has no telemetry.
The frontend has no `fs`, `shell` or `opener` access; it can only call the app
commands listed below. The "Native services" panel lists native class presence
only (API available), not exercised behavior; external dragging is untested.

## Explorer UI

- **Tabs** (⌘T new, ⌘W close, ⇧⌘[ / ⇧⌘] previous/next; the last tab cannot be
  closed, use ⇧⌘W to close the window). Each tab has its own folder, back/forward
  history, selection, loading and error state; a closed tab cancels its read.
- **Navigation**: ⌘[ back, ⌘] forward, ⌘↑ up (lexical, selects the folder you came
  from), ⇧⌘H home, ⌘R refresh, ⌘L "Go to Folder…" (type a path; invalid paths show
  an error and leave history untouched). Double-click or Enter opens folders and
  files (files use the safe `open_item` command).
- **Selection**: click, ⌘-click toggle, ⇧-click range, arrows / Home / End /
  PageUp / PageDown (⇧ extends), ⌘A, Esc clears; context menu via right click,
  the Menu key or ⇧F10. Sorting by clicking the headers or from the View tab; ⇧⌘.
  toggles hidden items. Column widths are resizable (drag or ←/→ on the handle).
- Native menu items are forwarded to the UI as `menu-action` events because macOS
  consumes the accelerators before the WebView.
- **Persistence**: only sort, hidden-items and column widths (`localStorage`,
  key `explorer.preferences.v1`). No paths, history or searches are stored.
- **Large folders**: the list renders only the visible rows (plus overscan);
  icons are requested only for visible rows, at most 4 at a time.

Limitations: "hidden" means a leading dot (the macOS hidden flag is not read);
rows stay in directory order while a folder is still loading and are sorted
when it finishes; Details is the only layout; search, copy/cut/paste/move/delete/
rename/new folder, properties and preview are disabled placeholders.

## Filesystem backend

Rust owns all filesystem access. Commands (`src/backend/contracts.ts`
`ImplementedCommands`, wire types in `contracts.rs`); every failure rejects with
a typed `AppError` (`category`, `operation`, `context`, `message`; categories
include `notFound`, `permissionDenied`, `invalidInput`, `io`):

| Command | Behavior |
|---|---|
| `get_home_directory` | Entry for the user's home folder (the initial location) |
| `parent_directory {id}` | Containing folder entry, `null` for `/` |
| `resolve_directory {path}` | Validates a typed address: trims, expands `~`, requires an absolute path, resolves `.`/`..` lexically (like `cd`), and must be an existing folder (a symlink to a folder is accepted); otherwise a typed `notFound`/`invalidInput` error |
| `list_places` | Sidebar locations that really exist: Home, Desktop/Documents/Downloads/Pictures/Music/Movies/Public (omitted if absent), /Applications, the startup volume and mounted `/Volumes` entries; unreadable volume entries are returned in `failures` |
| `start_directory_read {readId, id}` | Returns once queued; the read runs on a blocking worker and emits `directory-event`s tagged with `readId` |
| `cancel_directory_read {readId}` | Idempotent; unknown/finished ids are not errors |
| `open_item {id}` | Opens an existing regular file (or a link to one) with `NSWorkspace openURL:` on the main thread; folders and missing paths are typed errors; no shell is involved |
| `get_icon {id, size}` | System icon (`NSWorkspace iconForFile:`) as a `data:image/png;base64` URL; requested lazily by the UI when a row becomes visible |

- **Entries** (`FileEntry`): `id` (lossless hex of the raw path bytes – the only
  value ever sent back to the backend), lossy display `path` and `name`, `kind`
  (`file`/`directory`/`other`), `size` (regular files only), `modifiedMs`,
  `isSymlink`, `isBrokenLink`. Ids must decode to an absolute path without NUL.
- **Directory events**: `entries` batches (≤500 entries, flushed at least every
  100 ms) carry `entries` and `failures`; the read ends with exactly one of
  `finished {entries, failed}`, `failed {error}` or `cancelled`. A directory that
  cannot be opened (missing, denied, not a folder) is `failed`, never an empty
  `finished`. Entries whose metadata cannot be read (denied, vanished between
  listing and `stat`) are reported in `failures`, not dropped. The directory is
  streamed once; paging is the batch stream, so nothing is rescanned per page.
  Order is directory order; sorting belongs to the explorer UI.
- **Stale results**: the client (`readDirectory`) subscribes before starting,
  filters events by its own `readId`, and cancels on replace/unmount, so a
  superseded read cannot change another location's contents. Up to 32 reads may
  run concurrently; duplicate ids are rejected.
- **Symbolic links** are never traversed recursively. A link is one entry; its
  kind and size come from a single `stat` of the target. Only a genuinely
  unresolvable target (missing, a non-folder path component, or a loop) is
  `isBrokenLink` with kind `other`; if the target exists but cannot be examined
  (permission denied, I/O error) the entry is reported in `failures` instead.
- **Permissions**: macOS privacy-protected folders (Desktop, Documents, ...) may
  prompt or return `permissionDenied`; the app does not request Full Disk Access.
- `open_item` launches the registered default application, so opening an
  executable file or script behaves like double-clicking it in Finder.
- Icons are available for UTF-8 paths only (`iconForFile:` takes an `NSString`);
  other paths get a typed `unsupported` error and a blank placeholder.

### Filesystem verification

- `cargo test` (31 tests) uses only exclusively owned temporary fixtures
  (`spike_fixture::Fixture`): empty and non-empty folders, Unicode names, links
  (file, folder, broken, self/loop, and a link into a chmod-denied folder), disappearing entries (injected `stat`),
  denied folders and denied entry metadata (chmod; skipped if the user is not
  restricted), path-is-a-file and missing paths, a 12,000-entry folder in bounded
  batches without duplicates, mid-stream and pre-start cancellation, id
  validation, icon PNG generation and a read-only default-application lookup.
- `lib.rs` tests drive the real registered commands through Tauri's **mock
  runtime** IPC (argument/result serialization, event emission, registry
  cleanup, typed rejections). This is not a WebView/GUI round trip.
- **APFS rejects file names that are not valid UTF-8** (`EILSEQ`), so such files
  could not be created on the test volume. Lossless addressing is verified at the
  id level (raw non-UTF-8 bytes → id → identical path); listing such a name from
  disk is not verified here (the test would run on volumes that permit it).
- Frontend tests (`App.test.tsx`, `directory.test.ts`) mock `invoke` and
  `listen` and are labeled as such.
- Icon rendering runs inside a per-call Cocoa autorelease pool (worker threads
  have none) and copies the PNG out before it ends; a test renders 300 icons on one
  reused background thread. Injected-error tests for link-target classification
  are labeled as injected. No memory growth was measured.
- **Not verified**: real WebView↔backend IPC and GUI rendering; actually
  launching an application through `open_item` (only the default-application
  lookup is tested, to avoid launching apps during tests); icons off the main
  thread under heavy concurrency (calls are serialized by a lock); network volumes; macOS older than 26 and Intel at runtime.

## Native API findings

Chosen bridge: **`objc2` 0.6 with `objc2-foundation`, `objc2-app-kit` and
`objc2-quick-look-ui` 0.3** (typed Rust bindings to the system frameworks, no
Objective-C source, no shell-outs). Tauri 2.12 exposes `WebviewWindow::ns_window()`
and `ns_view()`, which provide the native handles later slices need.

| Feature | Path | Verified here (macOS 26.6.1, arm64) |
|---|---|---|
| Spotlight | `NSMetadataQuery` with search scopes and `NSPredicate` built from `predicateWithFormat:argumentArray:` (user text is a bound argument, never concatenated or shelled out). Filename: `kMDItemFSName CONTAINS[cd] %@`; content: `kMDItemTextContent CONTAINS[cd] %@`. Cancel with `stopQuery`. | Found an already-indexed file by name and by content; results were observable while still gathering; a freshly created fixture was found by both predicates after a delay (a first attempt in a dot-directory returned nothing within 20 s, so indexing latency is real and must be surfaced); `stopQuery` stopped the query |
| Trash | `NSFileManager.trashItemAtURL:resultingItemURL:error:` | Moved a fixture to `~/.Trash`, source gone, resulting URL returned (the spike removed its own file afterwards) |
| System icons | `NSWorkspace.iconForFile:` | Returned an `NSImage` |
| Quick Look | `QLPreviewPanel.sharedPreviewPanel` with a Rust-defined `QLPreviewPanelDataSource` (`define_class!`) | In a standalone AppKit process the panel became visible with the expected item URL; `makeKeyAndOrderFront` and `setDataSource` were sufficient |
| External drag source | `NSView.beginDraggingSessionWithItems:event:source:` with `NSURL` pasteboard writers on the webview's `NSView`; Tauri's built-in drag-drop only handles drops *into* the window | **Not exercised.** Bindings and `NSDraggingSession` exist, but a drag needs a live view and mouse event |

Design consequences and limits:

- Spotlight cannot report "this folder is not indexed" or "access denied" directly.
  Results must be presented as best-effort; the search slice has to detect and word
  uncertain states honestly (`SearchState` deliberately has no "complete").
- Content search covers only formats with installed Spotlight importers.
- `NSMetadataQuery` needs a run loop; the search slice must create and drive it on
  the main thread and forward batches over `SEARCH_EVENT`.
- AppKit calls (Quick Look, drag sessions, queries) are main-thread only; filesystem
  work belongs on background tasks reporting via `TASK_EVENT`.
- Quick Look in the Tauri window still needs verification of the responder-chain /
  panel-control integration with the webview and of Space-key handling.

## Limitations (unverified)

- The app was launched and stayed running, but no GUI inspection was possible in the
  environment used (screen capture was unavailable); window rendering, the native
  menu, and the real WebView-to-backend IPC round trip were **not** visually
  or interactively confirmed. Frontend tests mock `invoke`; backend command
  tests use Tauri's mock runtime (see Filesystem verification).
- External drag-and-drop to/from Finder, cross-volume behavior, and macOS versions
  other than 26.6.1 were not tested.
- The app icon is an original simple placeholder. The bundle step (`.app`/`.dmg`),
  signing and notarization were not performed.
## Explorer UI verification

- Vitest (jsdom, **mocked IPC**): independent tabs and history, invalid/valid
  address, stale and closed-tab read events, sorting and selection invariants,
  keyboard selection, context menus, errors and a 5000-row virtualization test.
  These prove frontend logic only, not real WebView/IPC behavior.
- Rust: 33 tests, including the new `resolve_directory`/`list_places` cases and
  the Tauri mock-runtime command test.
- The release binary (`npm run tauri build -- --no-bundle`) was built and launched
  with `HOME` pointing at a temporary fixture; the process stayed alive, but
  `screencapture` and window inspection were unavailable, so the real
  WebView↔backend IPC, native menu events and the final visual appearance are
  **unverified** on this machine. macOS 12.0 as deployment target is untested.

## File operations

All work runs in Rust off the UI thread (`start_transfer`, `trash_items`,
`create_folder`, `rename_item`, `cancel_task`, `resolve_conflict`) and reports
`TaskEvent`s to the window that started it; the frontend only sends opaque path
ids. Toolbar, context menu and native menu share one service.

- **New folder** (⇧⌘N): creates a uniquely named folder ("New folder", "New folder 2"…) and asks for its name.
- **Copy / Cut / Paste** (⌘C / ⌘X / ⌘V): the clipboard is **internal to the app** (it holds item ids). It is *not* shared with Finder or other apps and does not exchange files; in text fields the menu actions go to the field. Cut + Paste is a move.
- **Rename** (F2 or context menu): one item; validated name, never overwrites (atomic `RENAME_EXCL`); case-only renames work.
- **Move to the Trash** (⌘⌫, context menu, "Delete"): uses `NSFileManager.trashItemAtURL`; there is **no permanent deletion**.
- **Conflicts**: never overwritten silently. Choose Skip, Keep both (numbered name) or Replace (files only; the old file goes to the Trash), optionally for all remaining conflicts. Folders are never merged or replaced. Conflicts are re-checked at execution time, and a Replace answer is bound to the exact file that was shown (device and inode): the replacement is swapped in atomically and the displaced item is verified before it goes to the Trash. If the name was taken over by a different item (for example a folder) since you answered, nothing is trashed and you are asked again. A source that became a folder after the prompt is never used for a file Replace. If moving the old file to the Trash fails, the original is restored only when the installed new copy is still byte-for-byte the same item and version; otherwise nothing is deleted, and the error names where the surviving items are.
- **Safety**: copying/moving an item into itself or a descendant is rejected; symlinks are copied/moved as links, never followed; a move (including Move + Replace and the cross-volume copy-then-delete fallback) removes a source only if it is still the very item that was copied; a source edited or replaced meanwhile is kept, reported as a failure, and exists in both places. The check and the removal are separate steps, so a change in that tiny window cannot be excluded.
- **Progress and cancellation**: measured bytes (copy/move) or items; "Counting items…" while the total is unknown, never an invented percentage. Cancel stops further work; it does **not** roll back what was already done, and the result says so. Partial failures list the failed items (capped; the rest is counted). A folder copy that was cancelled or failed part-way keeps what was copied and is listed as partly copied (not counted as succeeded).
- **Refresh**: only tabs showing an affected folder reload; events are matched by task id.

Limitations: Replace needs a filesystem supporting atomic swap (`renamex_np`); otherwise it fails safely without changing anything. If the operation listener cannot be registered, no operation is started and an error is shown. Cross-volume moves (EXDEV fallback) are tested only by driving the
fallback on one volume, not with a real second volume; no Full Disk Access is
requested, so protected folders report permission errors; Trash and menu
behavior have been checked by automated tests with owned temporary fixtures,
see the PR for GUI acceptance evidence. Copies preserve extended attributes, ACLs and mode on a best-effort basis (failures to copy this metadata are not reported).
