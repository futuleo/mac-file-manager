//! AppKit side of drag and drop (main thread only).
//!
//! The webview is a `WryWebView`/`WKWebView`. Its drag-destination methods are
//! overridden by giving that one view instance a runtime subclass (the way KVO
//! does), so file drags are answered here and every other drag still reaches
//! WebKit through `super`. Outbound drags use a real `NSDraggingSession` started
//! with the mouse event that is being processed, so they carry file `NSURL`s that
//! Finder and other apps understand.

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use objc2::{
    AllocAnyThread, ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ClassBuilder, ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingInfo, NSDraggingItem,
    NSDraggingSession, NSDraggingSource, NSEvent, NSEventType,
    NSPasteboardURLReadingFileURLsOnlyKey, NSView, NSWorkspace,
};
use objc2_foundation::{
    NSArray, NSCopying, NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRect,
    NSSize, NSString, NSURL,
};
use tauri::{Emitter, Manager, Runtime, WebviewWindow};

use super::{DRAG_EVENT, DragEvent, DragState, Mask, is_usable_path};
use crate::{
    contracts::{AppError, ErrorCategory},
    macos::file_url_with,
    operations::TransferMode,
};

const OPERATION: &str = "drag and drop";
const OFFERED: usize = 1 | 16; // copy | move

struct Hook {
    state: Arc<DragState>,
    emit: Box<dyn Fn(DragEvent)>,
}

thread_local! {
    static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    /// Id of the incoming file drag this app is handling, if any.
    static CURRENT: Cell<Option<u64>> = const { Cell::new(None) };
    static SOURCE: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
}

fn with_hook<T>(work: impl FnOnce(&Hook) -> T) -> Option<T> {
    HOOK.with(|hook| hook.borrow().as_ref().map(work))
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MfmDragSource"]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn source_mask(
            &self,
            _session: &NSDraggingSession,
            _context: NSDraggingContext,
        ) -> NSDragOperation {
            // Copy and move only: no aliases, no deletion, no generic operation.
            NSDragOperation(OFFERED)
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
            SOURCE.with(|source| source.borrow_mut().take());
            with_hook(|hook| {
                if let Some(event) = hook.state.end_outbound(operation.0 as u64) {
                    (hook.emit)(event);
                }
            });
        }
    }
);

/// Raw bytes of every file URL on the drag pasteboard. Display strings are never used.
fn pasteboard_paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
    let pasteboard = info.draggingPasteboard();
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let yes = NSNumber::numberWithBool(true);
    // SAFETY: the key constant is a valid option key and the value an NSNumber.
    let options = unsafe {
        NSDictionary::from_slices(
            &[NSPasteboardURLReadingFileURLsOnlyKey],
            &[&*yes as &AnyObject],
        )
    };
    // SAFETY: `classes` holds NSURL's class, which supports pasteboard reading.
    let Some(objects) =
        (unsafe { pasteboard.readObjectsForClasses_options(&classes, Some(&options)) })
    else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for object in objects.iter() {
        let Some(url) = object.downcast_ref::<NSURL>() else {
            return Vec::new();
        };
        if !url.isFileURL() {
            return Vec::new();
        }
        // Resolves `file:///.file/id=` reference URLs to a path URL.
        let url = url.filePathURL().unwrap_or_else(|| url.copy());
        // SAFETY: NUL-terminated string owned by the URL, copied immediately.
        let bytes = unsafe { CStr::from_ptr(url.fileSystemRepresentation().as_ptr()) }.to_bytes();
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
        // A pasteboard that mixes in anything unusable is not a clean file drag.
        if !is_usable_path(&path) {
            return Vec::new();
        }
        paths.push(path);
    }
    paths
}

fn to_operation(mode: Option<TransferMode>) -> NSDragOperation {
    match mode {
        Some(TransferMode::Copy) => NSDragOperation::Copy,
        Some(TransferMode::Move) => NSDragOperation::Move,
        None => NSDragOperation::None,
    }
}

/// Pointer position in the view's CSS-pixel space (origin top-left).
fn location(view: &NSView, info: &ProtocolObject<dyn NSDraggingInfo>) -> (f64, f64) {
    let point = view.convertPoint_fromView(info.draggingLocation(), None);
    if view.isFlipped() {
        (point.x, point.y)
    } else {
        (point.x, view.bounds().size.height - point.y)
    }
}

fn info_of(raw: &AnyObject) -> &ProtocolObject<dyn NSDraggingInfo> {
    // SAFETY: AppKit passes an object conforming to NSDraggingInfo to these methods.
    unsafe { &*(raw as *const AnyObject as *const ProtocolObject<dyn NSDraggingInfo>) }
}

fn view_of(this: &AnyObject) -> &NSView {
    // SAFETY: the overridden methods are only installed on an NSView.
    unsafe { &*(this as *const AnyObject as *const NSView) }
}

fn superclass_of(this: &AnyObject) -> &'static AnyClass {
    this.class()
        .superclass()
        .expect("the runtime subclass has a superclass")
}

fn mask_of(info: &ProtocolObject<dyn NSDraggingInfo>) -> Mask {
    Mask::from_bits(info.draggingSourceOperationMask().0 as u64)
}

unsafe extern "C-unwind" fn dragging_entered(
    this: *mut AnyObject,
    _cmd: Sel,
    raw: *const AnyObject,
) -> NSDragOperation {
    // SAFETY: the receiver is the live view.
    let this = unsafe { &*this };
    // SAFETY: AppKit passes a live dragging-info object.
    let raw = unsafe { &*raw };
    let info = info_of(raw);
    CURRENT.with(|current| current.set(None));
    let paths = pasteboard_paths(info);
    let handled = with_hook(|hook| {
        if paths.is_empty() {
            return false;
        }
        let internal = info
            .draggingSource()
            .is_some_and(|source| source.class() == DragSource::class());
        let count = paths.len();
        let id = hook.state.enter(paths, internal, mask_of(info));
        CURRENT.with(|current| current.set(Some(id)));
        (hook.emit)(DragEvent::Enter {
            drag_id: format!("d{id}"),
            count,
            internal,
        });
        true
    });
    if handled == Some(true) {
        return NSDragOperation::None;
    }
    // SAFETY: forwards the same message to the superclass.
    unsafe { msg_send![super(this, superclass_of(this)), draggingEntered: raw] }
}

unsafe extern "C-unwind" fn dragging_updated(
    this: *mut AnyObject,
    _cmd: Sel,
    raw: *const AnyObject,
) -> NSDragOperation {
    // SAFETY: the receiver is the live view.
    let this = unsafe { &*this };
    // SAFETY: AppKit passes a live dragging-info object.
    let raw = unsafe { &*raw };
    let info = info_of(raw);
    let Some(id) = CURRENT.with(Cell::get) else {
        // SAFETY: forwards the same message to the superclass.
        return unsafe { msg_send![super(this, superclass_of(this)), draggingUpdated: raw] };
    };
    let (x, y) = location(view_of(this), info);
    with_hook(|hook| {
        hook.state.set_mask(id, mask_of(info));
        let operation = hook.state.operation(id);
        (hook.emit)(DragEvent::Over {
            drag_id: format!("d{id}"),
            x,
            y,
            operation,
        });
        to_operation(operation)
    })
    .unwrap_or(NSDragOperation::None)
}

unsafe extern "C-unwind" fn dragging_exited(
    this: *mut AnyObject,
    _cmd: Sel,
    info: *const AnyObject,
) {
    // SAFETY: the receiver is the live view.
    let this = unsafe { &*this };
    let Some(id) = CURRENT.with(Cell::take) else {
        // SAFETY: forwards the same message to the superclass.
        let _: () = unsafe { msg_send![super(this, superclass_of(this)), draggingExited: info] };
        return;
    };
    with_hook(|hook| {
        hook.state.leave(id);
        (hook.emit)(DragEvent::Leave {
            drag_id: format!("d{id}"),
        });
    });
}

unsafe extern "C-unwind" fn perform_drag(
    this: *mut AnyObject,
    _cmd: Sel,
    raw: *const AnyObject,
) -> Bool {
    // SAFETY: the receiver is the live view.
    let this = unsafe { &*this };
    // SAFETY: AppKit passes a live dragging-info object.
    let raw = unsafe { &*raw };
    let info = info_of(raw);
    let Some(id) = CURRENT.with(Cell::take) else {
        // SAFETY: forwards the same message to the superclass.
        return unsafe { msg_send![super(this, superclass_of(this)), performDragOperation: raw] };
    };
    let accepted = with_hook(|hook| {
        hook.state.set_mask(id, mask_of(info));
        let mode = hook.state.accept(id);
        let internal = hook.state.is_internal(id);
        if mode.is_some() && internal {
            hook.state.mark_handled_here();
        }
        (hook.emit)(DragEvent::Drop {
            drag_id: format!("d{id}"),
            accepted: mode.is_some(),
            operation: mode,
            count: hook.state.count(id),
            internal,
        });
        mode.is_some()
    });
    Bool::new(accepted == Some(true))
}

/// Gives the window's webview the file-drop behaviour described in the module docs.
pub fn install<R: Runtime>(window: &WebviewWindow<R>, state: Arc<DragState>) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let view = webview.inner() as *mut AnyObject;
                if view.is_null() {
                    return Err("the window has no web view".to_string());
                }
                // SAFETY: a live NSView owned by the window; used on the main thread only.
                let current = unsafe { (*view).class() };
                let name = c"MfmDragWebView";
                let class = if current.name() == name {
                    current
                } else {
                    let mut builder = ClassBuilder::new(name, current)
                        .ok_or("the drag class could not be created")?;
                    // SAFETY: the function types match the NSDraggingDestination selectors.
                    unsafe {
                        builder.add_method(
                            sel!(draggingEntered:),
                            dragging_entered
                                as unsafe extern "C-unwind" fn(
                                    *mut AnyObject,
                                    Sel,
                                    *const AnyObject,
                                )
                                    -> NSDragOperation,
                        );
                        builder.add_method(
                            sel!(draggingUpdated:),
                            dragging_updated
                                as unsafe extern "C-unwind" fn(
                                    *mut AnyObject,
                                    Sel,
                                    *const AnyObject,
                                )
                                    -> NSDragOperation,
                        );
                        builder.add_method(
                            sel!(draggingExited:),
                            dragging_exited
                                as unsafe extern "C-unwind" fn(
                                    *mut AnyObject,
                                    Sel,
                                    *const AnyObject,
                                ),
                        );
                        builder.add_method(
                            sel!(performDragOperation:),
                            perform_drag
                                as unsafe extern "C-unwind" fn(
                                    *mut AnyObject,
                                    Sel,
                                    *const AnyObject,
                                )
                                    -> Bool,
                        );
                    }
                    builder.register()
                };
                HOOK.with(|hook| {
                    *hook.borrow_mut() = Some(Hook {
                        state,
                        emit: Box::new(move |event| {
                            let _ = app.emit_to(label.as_str(), DRAG_EVENT, event);
                        }),
                    });
                });
                // SAFETY: the subclass adds no instance variables, so the layout is unchanged.
                unsafe { objc2::ffi::object_setClass(view, class) };
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn refused(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCategory::Unsupported, OPERATION, None, message)
}

fn icon_for(path: &Path) -> Retained<objc2_app_kit::NSImage> {
    let workspace = NSWorkspace::sharedWorkspace();
    match path.to_str() {
        Some(text) => workspace.iconForFile(&NSString::from_str(text)),
        #[allow(deprecated)]
        None => workspace.iconForFileType(&NSString::from_str("public.data")),
    }
}

/// Starts the drag session for `paths` using the mouse event being processed.
fn begin_session(view: &NSView, paths: &[PathBuf]) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("AppKit was used off the main thread")?;
    let event = NSApplication::sharedApplication(mtm)
        .currentEvent()
        .ok_or("there is no mouse event to drag with")?;
    let kind = event.r#type();
    if (kind != NSEventType::LeftMouseDragged && kind != NSEventType::LeftMouseDown)
        || NSEvent::pressedMouseButtons() & 1 == 0
    {
        return Err("the mouse button was released before the drag could start".into());
    }
    let origin = view.convertPoint_fromView(event.locationInWindow(), None);
    let mut items: Vec<Retained<NSDraggingItem>> = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let url = file_url_with(path, path.is_dir())
            .ok_or_else(|| "a path cannot be expressed as a file URL".to_string())?;
        let writer = ProtocolObject::from_retained(url);
        let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &writer);
        // Items beyond the first few share the last offset so the pile stays small.
        let shift = index.min(4) as f64 * 4.0;
        let frame = NSRect::new(
            NSPoint::new(origin.x - 16.0 + shift, origin.y - 16.0 - shift),
            NSSize::new(32.0, 32.0),
        );
        let icon = icon_for(path);
        // SAFETY: the contents are an NSImage, a valid dragging item image.
        unsafe { item.setDraggingFrame_contents(frame, Some(&icon)) };
        items.push(item);
    }
    // SAFETY: plain `init` of an NSObject subclass.
    let source: Retained<DragSource> = unsafe { msg_send![DragSource::alloc(mtm), init] };
    let refs: Vec<&NSDraggingItem> = items.iter().map(|i| &**i).collect();
    let array = NSArray::from_slice(&refs);
    let protocol = ProtocolObject::from_ref(&*source);
    view.beginDraggingSessionWithItems_event_source(&array, &event, protocol);
    SOURCE.with(|slot| *slot.borrow_mut() = Some(source));
    Ok(())
}

/// Begins an outbound drag of already validated `paths` from the window's web view.
pub async fn begin<R: Runtime>(
    window: &WebviewWindow<R>,
    state: Arc<DragState>,
    paths: Vec<PathBuf>,
) -> Result<(), AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let view = webview.inner() as *const NSView;
            let result = if view.is_null() {
                Err("the window has no web view".to_string())
            } else {
                state.begin_outbound(paths.clone());
                // SAFETY: a live NSView, used on the main thread.
                begin_session(unsafe { &*view }, &paths).inspect_err(|_| {
                    state.abandon_outbound();
                })
            };
            let _ = tx.send(result);
        })
        .map_err(|_| refused("the main thread is not available"))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| refused("the main thread did not answer"))?
        .map_err(|reason| {
            AppError::new(
                ErrorCategory::Cancelled,
                OPERATION,
                None,
                format!("The drag did not start: {reason}."),
            )
        })
}
