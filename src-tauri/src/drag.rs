//! Drag and drop of files between this app and Finder or other apps.
//!
//! Everything that decides *what* is dragged and *where* it may go lives here and
//! works on raw path bytes read from the OS file-URL pasteboard, never on display
//! strings. The webview only reports which folder is under the pointer; it never
//! supplies the dragged paths or the copy/move choice for incoming drags.
//!
//! * Outbound: `start_drag` begins a real `NSDraggingSession` carrying one file
//!   `NSURL` per item; the receiving app (Finder, ...) performs the copy or move.
//! * Inbound: the webview's drag-destination methods are overridden (see
//!   `native`) so file drops are read losslessly and the negotiated operation
//!   (copy/move, from the modifier keys the source allows) is honoured. Wry's own
//!   handler is not used: it decodes paths lossily and always answers "copy".
//! * An accepted drop runs through the same transfer task service as paste.

use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;

use crate::{
    contracts::{AppError, ErrorCategory, display_name, path_to_id},
    filesystem,
    operations::TransferMode,
};

pub const DRAG_EVENT: &str = "drag-event";
const OPERATION: &str = "drag and drop";
/// A drag of more items than this is refused; every item is checked before it starts.
pub const MAX_DRAG_ITEMS: usize = 1000;

/// Operations the drag source allows for the current modifier keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mask {
    pub copy: bool,
    pub moving: bool,
}

impl Mask {
    /// `NSDragOperationCopy` = 1 and `NSDragOperationMove` = 16. Finder narrows
    /// its mask to `NSDragOperationGeneric` = 4 alone while Command is held
    /// (observed with real gestures), which is its move gesture, so a source
    /// offering generic without copy or move is read as move. Link, delete and
    /// private operations are deliberately not interpreted.
    pub fn from_bits(bits: u64) -> Self {
        let copy = bits & 1 != 0;
        let moving = bits & 16 != 0 || (bits & 4 != 0 && !copy);
        Self { copy, moving }
    }
}

/// Finder's rule: Option (copy only) copies, Command (move only) moves, no
/// modifier moves within one volume and copies across volumes.
pub fn choose_operation(mask: Mask, same_volume: bool) -> Option<TransferMode> {
    match (mask.copy, mask.moving) {
        (false, false) => None,
        (true, false) => Some(TransferMode::Copy),
        (false, true) => Some(TransferMode::Move),
        (true, true) if same_volume => Some(TransferMode::Move),
        (true, true) => Some(TransferMode::Copy),
    }
}

/// What the drag state tells the webview about one drag.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DragEvent {
    /// Files entered the window. `internal` drags were started by this app.
    Enter {
        drag_id: String,
        count: usize,
        internal: bool,
    },
    /// Pointer position in CSS pixels of the webview, and the operation that
    /// would happen now over the target last set with `drag_hover`.
    Over {
        drag_id: String,
        x: f64,
        y: f64,
        /// Counts pointer updates of this drag; a hover answer is only good for the update it was asked for.
        pointer: u64,
        operation: Option<TransferMode>,
    },
    Leave {
        drag_id: String,
    },
    /// Files were dropped. `accepted` is false when no valid target was set, in
    /// which case the drag was refused and nothing will happen.
    Drop {
        drag_id: String,
        accepted: bool,
        operation: Option<TransferMode>,
        /// The `drag_hover` request whose verdict was accepted; null when refused.
        token: Option<u64>,
        count: usize,
        internal: bool,
    },
    /// A drag this app started ended. Folder ids are those whose contents the
    /// receiving app may have changed.
    #[serde(rename_all = "camelCase")]
    SourceEnded {
        outcome: SourceOutcome,
        count: usize,
        folders: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceOutcome {
    /// Nobody accepted the drop.
    Cancelled,
    /// Dropped back onto this app's own window; the transfer task reports the result.
    HandledHere,
    /// Another app accepted a copy. It performs it; completion is not confirmed here.
    HandedOffCopy,
    /// Another app accepted a move. It performs it (and removes the originals);
    /// this app does not delete anything and cannot confirm completion.
    HandedOffMove,
    /// The receiver reported an operation this app did not offer.
    Unexpected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hover {
    /// Echo of the request this verdict answers.
    pub token: u64,
    /// The operation that would happen now, or none when the target is refused.
    pub operation: Option<TransferMode>,
    pub reason: Option<String>,
}

/// Validated facts about a candidate drop target.
#[derive(Debug, Clone)]
struct Verdict {
    /// The pointer update and hover request this verdict was computed for.
    pointer: u64,
    token: u64,
    destination: PathBuf,
    same_volume: bool,
    /// Every dragged item already lives directly in the destination.
    all_inside: bool,
}

#[derive(Debug)]
struct Incoming {
    id: u64,
    paths: Vec<PathBuf>,
    internal: bool,
    mask: Mask,
    /// Latest native pointer update.
    pointer: u64,
    /// Latest hover request; older requests are refused and cannot store a verdict.
    token: u64,
    verdict: Option<Verdict>,
    /// Set by an accepted drop with the hover token it accepted; cleared when `take_drop` consumes it.
    accepted: Option<(TransferMode, u64)>,
}

#[derive(Debug)]
struct Outbound {
    paths: Vec<PathBuf>,
    handled_here: bool,
}

#[derive(Debug, Default)]
struct Inner {
    next: u64,
    incoming: Option<Incoming>,
    outbound: Option<Outbound>,
}

/// A drop ready to be handed to the transfer service.
#[derive(Debug, PartialEq, Eq)]
pub struct PendingDrop {
    pub sources: Vec<PathBuf>,
    pub destination: PathBuf,
    pub mode: TransferMode,
}

#[derive(Debug, Default)]
pub struct DragState {
    inner: Mutex<Inner>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::InvalidInput, OPERATION, None, message)
}

impl DragState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A drag of file URLs entered the window. Replaces (and so invalidates) any
    /// earlier incoming drag. Returns its id.
    pub fn enter(&self, paths: Vec<PathBuf>, internal: bool, mask: Mask) -> u64 {
        let mut inner = self.lock();
        inner.next += 1;
        let id = inner.next;
        inner.incoming = Some(Incoming {
            id,
            paths,
            internal,
            mask,
            pointer: 0,
            token: 0,
            verdict: None,
            accepted: None,
        });
        id
    }

    /// The pointer moved or the drag was polled again. A verdict computed for an
    /// earlier update no longer authorises a drop. Returns the new update number.
    pub fn moved(&self, id: u64) -> u64 {
        self.lock()
            .incoming
            .as_mut()
            .filter(|d| d.id == id && d.accepted.is_none())
            .map_or(0, |drag| {
                drag.pointer += 1;
                drag.pointer
            })
    }

    pub fn set_mask(&self, id: u64, mask: Mask) {
        if let Some(drag) = self.lock().incoming.as_mut().filter(|d| d.id == id) {
            drag.mask = mask;
        }
    }

    /// The pointer left the window. An already accepted drop is kept for its transfer.
    pub fn leave(&self, id: u64) {
        let mut inner = self.lock();
        if inner
            .incoming
            .as_ref()
            .is_some_and(|d| d.id == id && d.accepted.is_none())
        {
            inner.incoming = None;
        }
    }

    pub fn count(&self, id: u64) -> usize {
        self.lock()
            .incoming
            .as_ref()
            .filter(|d| d.id == id)
            .map_or(0, |d| d.paths.len())
    }

    /// Sets the folder under the pointer (`None`: no valid target) and reports
    /// what dropping there would do. `pointer` is the update the target was read
    /// at and `token` an increasing request number: the previous verdict is void
    /// at once, an older request is refused, and a request overtaken while it was
    /// being validated stores nothing.
    pub fn hover(
        &self,
        id: u64,
        pointer: u64,
        token: u64,
        destination: Option<PathBuf>,
    ) -> Result<Hover, AppError> {
        let paths = self.begin_hover(id, token)?;
        // Validated outside the lock: it touches the file system.
        let checked = destination.map(|d| evaluate(&paths, d));
        self.finish_hover(id, pointer, token, checked)
    }

    /// Voids the previous verdict and registers the request.
    fn begin_hover(&self, id: u64, token: u64) -> Result<Vec<PathBuf>, AppError> {
        let mut inner = self.lock();
        let drag = inner
            .incoming
            .as_mut()
            .filter(|d| d.id == id && d.accepted.is_none())
            .ok_or_else(|| invalid("This drag is no longer active."))?;
        if token <= drag.token {
            return Err(invalid("A newer drop target replaced this one."));
        }
        drag.token = token;
        drag.verdict = None;
        Ok(drag.paths.clone())
    }

    /// Stores the result unless a newer request overtook this one meanwhile.
    fn finish_hover(
        &self,
        id: u64,
        pointer: u64,
        token: u64,
        checked: Option<Result<Verdict, String>>,
    ) -> Result<Hover, AppError> {
        let mut inner = self.lock();
        let drag = inner
            .incoming
            .as_mut()
            .filter(|d| d.id == id && d.accepted.is_none())
            .ok_or_else(|| invalid("This drag is no longer active."))?;
        if drag.token != token {
            return Err(invalid("A newer drop target replaced this one."));
        }
        let refused = |reason| Hover {
            token,
            operation: None,
            reason,
        };
        match checked {
            None => Ok(refused(None)),
            Some(Err(reason)) => Ok(refused(Some(reason))),
            Some(Ok(mut verdict)) => {
                verdict.pointer = pointer;
                verdict.token = token;
                drag.verdict = Some(verdict);
                Ok(operation_of(drag))
            }
        }
    }

    /// The operation the pointer would get now; used for the cursor feedback.
    pub fn operation(&self, id: u64) -> Option<TransferMode> {
        let inner = self.lock();
        let drag = inner.incoming.as_ref().filter(|d| d.id == id)?;
        operation_of(drag).operation
    }

    /// The drop happened. Returns the operation and the hover request it accepted
    /// when the verdict is for the final pointer update; the caller then answers
    /// the drag session with success. A verdict that is still being replaced or
    /// belongs to an earlier pointer position refuses the drop.
    pub fn accept(&self, id: u64) -> Option<(TransferMode, u64)> {
        let mut inner = self.lock();
        let drag = inner
            .incoming
            .as_mut()
            .filter(|d| d.id == id && d.accepted.is_none())?;
        let verdict = drag.verdict.as_ref()?;
        if verdict.pointer != drag.pointer || verdict.token != drag.token {
            return None;
        }
        let accepted = (operation_of(drag).operation?, verdict.token);
        drag.accepted = Some(accepted);
        Some(accepted)
    }

    pub fn is_internal(&self, id: u64) -> bool {
        self.lock()
            .incoming
            .as_ref()
            .is_some_and(|d| d.id == id && d.internal)
    }

    /// Consumes an accepted drop exactly once. The claim must name the hover
    /// request that was accepted and the destination it validated; anything else
    /// discards the drop untouched.
    pub fn take_drop(
        &self,
        id: u64,
        token: u64,
        destination: &Path,
    ) -> Result<PendingDrop, AppError> {
        let mut inner = self.lock();
        let drag = inner
            .incoming
            .take_if(|d| d.id == id && d.accepted.is_some())
            .ok_or_else(|| invalid("This drop is no longer pending, so nothing was changed."))?;
        let (mode, accepted_token) = drag.accepted.unwrap_or((TransferMode::Copy, 0));
        let verdict = drag.verdict.filter(|v| v.token == accepted_token);
        match verdict {
            Some(v) if accepted_token == token && v.destination == destination => Ok(PendingDrop {
                sources: drag.paths,
                destination: v.destination,
                mode,
            }),
            _ => Err(invalid(
                "The drop target changed before the drop started, so nothing was changed.",
            )),
        }
    }

    /// Drops a pending drop without running it (the view changed under it).
    pub fn discard(&self, id: u64) {
        let mut inner = self.lock();
        if inner.incoming.as_ref().is_some_and(|d| d.id == id) {
            inner.incoming = None;
        }
    }

    pub fn begin_outbound(&self, paths: Vec<PathBuf>) {
        self.lock().outbound = Some(Outbound {
            paths,
            handled_here: false,
        });
    }

    /// The session could not start after all.
    pub fn abandon_outbound(&self) {
        self.lock().outbound = None;
    }

    /// A drop of this app's own drag landed on this app's window.
    pub fn mark_handled_here(&self) {
        if let Some(out) = self.lock().outbound.as_mut() {
            out.handled_here = true;
        }
    }

    /// Ends the outbound drag and describes it for the webview.
    pub fn end_outbound(&self, bits: u64) -> Option<DragEvent> {
        let out = self.lock().outbound.take()?;
        let outcome = if out.handled_here {
            SourceOutcome::HandledHere
        } else {
            match bits {
                0 => SourceOutcome::Cancelled,
                1 => SourceOutcome::HandedOffCopy,
                16 => SourceOutcome::HandedOffMove,
                _ => SourceOutcome::Unexpected,
            }
        };
        let mut folders: Vec<String> = Vec::new();
        for path in &out.paths {
            if let Some(parent) = path.parent() {
                let id = path_to_id(parent);
                if !folders.contains(&id) {
                    folders.push(id);
                }
            }
        }
        Some(DragEvent::SourceEnded {
            outcome,
            count: out.paths.len(),
            folders,
        })
    }
}

fn operation_of(drag: &Incoming) -> Hover {
    let Some(verdict) = &drag.verdict else {
        return Hover {
            token: drag.token,
            operation: None,
            reason: None,
        };
    };
    let operation = choose_operation(drag.mask, verdict.same_volume);
    if operation.is_none() {
        return Hover {
            token: verdict.token,
            operation: None,
            reason: Some("The drag source offers neither copy nor move.".into()),
        };
    }
    if operation == Some(TransferMode::Move) && verdict.all_inside {
        return Hover {
            token: verdict.token,
            operation: None,
            reason: Some(
                "The items are already in this folder. Hold Option to copy them here.".into(),
            ),
        };
    }
    Hover {
        token: verdict.token,
        operation,
        reason: None,
    }
}

fn access(path: &Path, mode: i32) -> bool {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        // SAFETY: valid NUL-terminated string.
        .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), mode) } == 0)
}

/// Checks that `destination` can receive every path: an existing writable folder
/// that is not one of the items or inside one of them.
fn evaluate(paths: &[PathBuf], destination: PathBuf) -> Result<Verdict, String> {
    let name = display_name(&destination);
    let meta = std::fs::metadata(&destination)
        .map_err(|_| format!("\"{name}\" is not available as a drop target."))?;
    if !meta.is_dir() {
        return Err(format!("\"{name}\" is not a folder."));
    }
    if !access(&destination, libc::W_OK | libc::X_OK) {
        return Err(format!("You can't add items to \"{name}\"."));
    }
    let canonical = std::fs::canonicalize(&destination)
        .map_err(|_| format!("\"{name}\" is not available as a drop target."))?;
    let mut same_volume = true;
    let mut all_inside = !paths.is_empty();
    for path in paths {
        let source = std::fs::symlink_metadata(path)
            .map_err(|_| format!("\"{}\" no longer exists.", display_name(path)))?;
        if source.is_dir()
            && std::fs::canonicalize(path).is_ok_and(|real| canonical.starts_with(real))
        {
            return Err(format!(
                "\"{}\" can't be dropped into itself.",
                display_name(path)
            ));
        }
        same_volume &= source.dev() == meta.dev();
        all_inside &= path
            .parent()
            .and_then(|p| std::fs::canonicalize(p).ok())
            .is_some_and(|p| p == canonical);
    }
    Ok(Verdict {
        pointer: 0,
        token: 0,
        destination,
        same_volume,
        all_inside,
    })
}

/// Decodes and checks the ids of an outbound drag.
pub fn resolve_sources(ids: &[String]) -> Result<Vec<PathBuf>, AppError> {
    if ids.is_empty() {
        return Err(invalid("Select a file or folder to drag."));
    }
    if ids.len() > MAX_DRAG_ITEMS {
        return Err(invalid(format!(
            "Select at most {MAX_DRAG_ITEMS} items to drag at once."
        )));
    }
    let mut paths: Vec<PathBuf> = Vec::with_capacity(ids.len());
    for id in ids {
        let path = filesystem::resolve_id(OPERATION, id)?;
        if paths.contains(&path) {
            continue;
        }
        std::fs::symlink_metadata(&path).map_err(|e| AppError::from_io(OPERATION, &path, &e))?;
        paths.push(path);
    }
    Ok(paths)
}

/// Rejects relative or NUL-containing paths read from a pasteboard.
pub fn is_usable_path(path: &Path) -> bool {
    path.is_absolute() && !path.as_os_str().as_encoded_bytes().contains(&0)
}

#[cfg(target_os = "macos")]
pub mod native;

#[cfg(test)]
mod tests;
