# Windows-10-style macOS file manager

## Status and objective

The user authorized configuring the full autonomous writer/reviewer/fix/merge cycle.
The scaffold, read-only filesystem backend and Explorer UI shell are implemented.
File operations (folder creation, copy, move, rename, Trash) and Spotlight search are implemented; preview and drag-and-drop remain unimplemented.
Before implementing, reread this file, including any user edits.

This repository file is the source of truth for the implementation plan.
Keep planning artifacts and task tracking in English, as requested by the user.

Build a functional macOS desktop file manager with an interface closely resembling
Windows 10 File Explorer while preserving correct macOS filesystem behavior and integrations.

## Confirmed requirements

- Stack: Tauri + React/TypeScript + Rust.
- Appearance: as close to Windows 10 File Explorer as practical.
- The first release is a functional, extended application, not just a visual prototype.
- Sidebar, navigation history, address bar, file table, and sorting.
- Opening files, creating folders, copying, moving, renaming, and moving items to Trash.
  Filename conflicts require an explicit user decision.
- Tabs, search, preview, and drag-and-drop are included in the first release.
- Search filenames and file contents using the system Spotlight index.
- Prepare the plan and useful skills before implementing.
- Full autonomous cycle: a writer commits and opens PRs; a separate reviewer checks
  them; the writer fixes findings; the coordinator merges only after validation and
  independent review pass.
- Selected models: Claude Sonnet 5.5 for writing, GPT-6.1 Sol for independent review,
  and Claude Haiku 5.5 for delegated test/build execution.

## Repository baseline

Historical baseline: before this plan was added, the repository contained only README.md,
AGENTS.md, and LICENSE. It now also contains the scaffold, filesystem backend and Explorer shell;
use the commands in README.md and `.github/AUTONOMY.md`. Do not claim checks that do not exist.

Work in the session worktree, not the main checkout.
The session branch has already been renamed; do not rename it again.

Initial environment check found Node.js and npm, but `rustc` was not on PATH.
Check whether a Rust toolchain is already installed before considering installation.
The initial check stopped at that failure; Cargo, Xcode tools, and macOS version
have not yet been verified.

## Proposed implementation decisions

These are proposed technical decisions, not additional user requirements. Obtain
agreement before changing the stack or materially reducing confirmed functionality.

- Use Tauri 2, React, TypeScript, and Vite. Confirm compatible stable versions against
  current documentation during implementation and commit dependency lockfiles.
- Rust owns filesystem operations and background task lifecycles.
  The UI uses a typed command/event API rather than direct filesystem access.
- Use AppKit/Foundation for Trash, system icons, opening files, and Quick Look.
  Choose the Rust/Objective-C bridge after verifying the required APIs.
- Prefer a native Spotlight API with cancellation and incremental results.
  Investigate NSMetadataQuery and the available bridge before committing to a design.
  Never construct shell commands from user search input.
- Preview uses macOS Quick Look. First establish a working native preview panel
  associated with the Tauri window. An embedded preview pane is not promised;
  replacing Quick Look with a restricted set of formats requires agreement.
- Use original visual assets; do not copy Microsoft's proprietary icons or artwork.
- Start in the user's home directory. Keep history, path, and selection independent
  per tab. Persist presentation preferences, not private search queries.
- Scope search to the current folder and its descendants; provide filename/content modes.
  Content format support depends on installed Spotlight importers.
  Do not build a custom index, promise complete results, or enable indexing automatically.
- Distinguish known unindexed locations, denied access, stale results, and failures
  from a successful search with no matches. Verify which states Spotlight actually
  exposes and clearly communicate uncertainty for states that cannot be determined.
- Use macOS keyboard conventions, including Command rather than blindly adopting
  Windows Ctrl shortcuts. Preserve native menus and accessibility.
- Initially target a regular local desktop build, not a Mac App Store sandbox.
  Do not add network services, telemetry, or cloud features.
  Do not request Full Disk Access without explaining a concrete need.
- Determine the minimum macOS version and supported architectures from the selected
  Tauri/native APIs and available environment, then document them explicitly.

## Architecture and planned surfaces

Generate the standard project structure with the chosen scaffold rather than
manually reproducing a framework template.

- src/: application shell, tabs, folder sidebar, address bar, file list,
  context menus, operation dialogs, search, shared styles, and typed backend client.
- src-tauri/: configuration and capabilities, Rust commands, filesystem service,
  operation tasks, progress events, and macOS integrations.
- Split backend responsibilities into filesystem, operations, macos, and search
  only where that simplifies the code. Avoid an upfront abstraction framework.
- File entry contract: identity/path, display name, kind, size when available,
  modification date, and symbolic-link flag. Load icons lazily.
  Verify lossless addressing for filenames that are not valid UTF-8.
- Error contract: category, operation, safe context, and user-readable message.
  Surface errors in the UI; never turn a failed directory read into an empty directory.
- Task contract: id, stage, progress where measurable, completion/failure events,
  conflict decisions, and cancellation. Do not invent precise percentages.
- Run operations off the UI thread. Stale navigation events must not replace another
  tab's contents. Read large directories and search results incrementally;
  virtualize the list where needed.
- Cross-volume moves use copy-then-delete, removing the source only after successful
  copying. Do not recursively follow symbolic links. Reject copying a directory
  into itself and detect equivalent source/destination paths.
- Overwriting is never the default. Offer skip, keep both, or explicit replacement,
  with clear directory-specific limitations.
- Cancellation stops further work without promising rollback of completed actions.
  Report completed and failed items when an operation partially succeeds.
- Support internal drag-and-drop and file URL exchange with Finder/other applications.
  Respect copy/move intent and modifier keys. Verify Tauri drag-source support;
  add a narrow native bridge if needed rather than relying only on HTML dragging.
- Clipboard copy/move, context menus, and toolbar actions share one operation service.
  Recheck permissions and on-disk conflicts at execution time.

## Todos and execution order

1. platform-spikes: Check documentation and availability of Node, Rust, and Xcode tools.
   Validate Tauri/macOS integration paths for Quick Look, Spotlight, Trash, and external
   drag sources. Establish compatibility constraints and command/event contracts.
   If an integration fails, investigate an alternative native approach; do not silently
   remove confirmed features.
2. scaffold: Generate the Tauri/React/TypeScript project with minimal capabilities,
   CSP, build/check scripts, a test foundation, and dependency lockfiles.
3. filesystem: Implement typed directory reads, metadata, paths, permission errors,
   symbolic-link handling, file opening, and system icons.
4. explorer-ui: Build the Windows-10-style shell, sidebar, address bar, table,
   sorting, selection, navigation history, tabs, and keyboard navigation.
5. file-operations: Implement folder creation, copy/move, rename, and Trash,
   including progress, cancellation, conflicts, and partial failures.
   Connect operations to the UI and clipboard.
6. spotlight-search: Implement filename/content search, scoped results,
   cancellation, incremental delivery, result navigation, and honest index states.
7. quick-look: Connect Quick Look to selection and Space; handle tab changes,
   disappearing files, and preview lifecycle correctly.
8. drag-drop: Implement internal dragging and file URL exchange with Finder;
   reuse the safe operation service and conflict dialogs.
9. acceptance: Validate the integrated application, accessibility, actual file
   operation behavior, and large directories. Fix directly related defects.
10. documentation: Update README with actual setup/run/build/check commands,
    macOS requirements, and Spotlight, permission, and preview limitations.

Dependencies:
scaffold <- platform-spikes;
filesystem <- scaffold;
explorer-ui <- filesystem;
file-operations <- explorer-ui;
spotlight-search <- explorer-ui;
quick-look <- explorer-ui;
drag-drop <- file-operations;
acceptance <- file-operations, spotlight-search, quick-look, drag-drop;
documentation <- acceptance.

## Validation and acceptance criteria

Add minimal appropriate testing tools when scaffolding the application. Then run
the actual manifest scripts, Cargo checks/tests, and Tauri build. Do not invent
commands before those scripts exist.

- The application actually launches on macOS and its interface is visually inspected.
  The browser canvas can validate web UI only, not native API behavior.
- The address bar, back/forward navigation, and independent tabs work against real files.
- Selection, sorting, and navigation work with the keyboard. Controls have accessible
  labels, focus is visible, text is readable, and resizing does not break the layout.
- Test operations only in temporary fixtures, never against user data.
  Compare copied file contents, not just file existence.
- Cover conflicts, denied permissions, symbolic links, self-copy, unavailable paths,
  cancellation, and partial failure. Verify cross-volume moves on an available safe
  test volume or explicitly report them as unverified.
- Delete actions move files to the system Trash rather than permanently deleting them.
- On an indexed fixture, Spotlight finds a known filename and known content in a
  supported format. Account for indexing delays. Do not enable indexing or change
  macOS settings without permission.
- Quick Look actually opens the selected file. Exercise at least an image, a PDF,
  and a text file where supported by installed preview providers.
- Test drag-and-drop in both directions with Finder, including copy/move and conflicts.
- Verify safe handling of search/file-opening input, Tauri permissions, no arbitrary
  frontend-triggered shell execution, and no remotely loaded application content.
- Confirm responsive navigation and no UI hangs on a large fixture directory.
  Measure observed behavior rather than claiming untested performance thresholds.
- Never claim success for GUI, external-volume, permission, or signing-dependent checks
  that were not executed. Separate verified behavior from environmental limitations.

## Skills and agent strategy

The user has now selected autonomous execution with separate writer/reviewer sessions.
The protocol in `.github/AUTONOMY.md` supersedes the earlier single-session default below.
Model assignments must be passed explicitly at launch; documentation is not a runtime switch.
Configure and verify the cycle with the setup PR before assigning product slices.

- agentfinder is already loaded. Use it for a specific external integration, such as
  Figma, if the user chooses one. Purely local development does not require registry
  or MCP discovery. Do not automatically install external resources.
- orchestrate is already loaded as a coordination reference. No child sessions or
  implementation agents have been created. This plan and SQL tracking are sufficient;
  a separate planning agent is unnecessary.
- create-canvas applies to Copilot canvas extensions, not this desktop application's UI.
- pr-stack is relevant only if the user chooses dependent PRs.
  agent-merge applies only when automated PR lifecycle management is enabled.
- Do not assume nonexistent Swift/Tauri/design skills are installed.
  No additional skills or MCP servers are currently required.
- Default to implementation in the current session. If the user selects parallel
  execution, stabilize the scaffold and backend/UI contracts first. Operations,
  Spotlight, and Quick Look can then become independent workstreams.
  Minimize agent count and overlapping file ownership. Do not launch workflows
  or create child sessions merely because parallelism is technically possible.
- A task agent may handle verbose builds/tests, research may investigate a complex
  native API question, and code-review may inspect a substantial diff separately.
  Delegate only when genuinely useful or explicitly requested.

## Out of scope

Dedicated cloud-drive integrations, network protocols, archive handling, dual-pane mode,
custom indexing, content search for unindexed formats, replacing Finder, Mac App Store
publication, automatic updates, signing/notarization, and a promise of complete undo.
Do not add these features without separate agreement.
