//! Quick Look preview through the system `QLPreviewPanel`.
//!
//! The frontend sends lossless entry ids; this module validates them against the
//! file system and drives the shared panel on the AppKit main thread. The panel
//! finds its controller through the responder chain of the calling window: a
//! `MfmQuickLookController` is inserted after the Tauri `NSWindow`, accepts panel
//! control and serves the preview items. Only the window that issued a command
//! can attach, change or close the panel for its own controller.

use std::path::PathBuf;

use tauri::{Runtime, WebviewWindow};

use crate::{
    contracts::{AppError, ErrorCategory, display_name},
    filesystem,
};

/// More items than this are refused: a preview of hundreds of files is not useful
/// and every item is checked on disk before the panel is updated.
pub const MAX_ITEMS: usize = 50;

const OPERATION: &str = "preview";

/// Checks the ids and returns the paths to preview, in order and without duplicates.
/// Only existing, readable regular files and folders can be previewed.
pub fn resolve_items(ids: &[String]) -> Result<Vec<PathBuf>, AppError> {
    if ids.is_empty() {
        return Err(AppError::new(
            ErrorCategory::InvalidInput,
            OPERATION,
            None,
            "Select a file or folder to preview.",
        ));
    }
    if ids.len() > MAX_ITEMS {
        return Err(AppError::new(
            ErrorCategory::InvalidInput,
            OPERATION,
            None,
            format!("Select at most {MAX_ITEMS} items to preview at once."),
        ));
    }
    let mut paths: Vec<PathBuf> = Vec::with_capacity(ids.len());
    for id in ids {
        let path = filesystem::resolve_id(OPERATION, id)?;
        if paths.contains(&path) {
            continue;
        }
        check_previewable(&path)?;
        paths.push(path);
    }
    Ok(paths)
}

fn check_previewable(path: &std::path::Path) -> Result<(), AppError> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::from_io(OPERATION, path, &e))?;
    if meta.is_file() {
        // Only regular files are opened: opening a FIFO or device could block.
        std::fs::File::open(path).map_err(|e| AppError::from_io(OPERATION, path, &e))?;
        Ok(())
    } else if meta.is_dir() {
        Ok(())
    } else {
        let name = display_name(path);
        Err(AppError::new(
            ErrorCategory::InvalidInput,
            OPERATION,
            Some(name.clone()),
            format!("\"{name}\" is not a file or folder, so it cannot be previewed."),
        ))
    }
}

fn unsupported(reason: &str) -> AppError {
    AppError::new(
        ErrorCategory::Unsupported,
        OPERATION,
        None,
        format!("Quick Look is not available: {reason}."),
    )
}

/// Runs `work` with the calling window's native handle on the main thread.
async fn on_main<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    work: impl FnOnce(&str, *mut std::ffi::c_void) -> Result<T, String> + Send + 'static,
) -> Result<T, AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let outcome = match target.ns_window() {
                Ok(handle) => work(target.label(), handle),
                Err(_) => Err("the window has no native handle".to_string()),
            };
            let _ = tx.send(outcome);
        })
        .map_err(|_| unsupported("the main thread is not available"))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| unsupported("the main thread did not answer"))?
        .map_err(|reason| unsupported(&reason))
}

async fn resolve(ids: Vec<String>) -> Result<Vec<PathBuf>, AppError> {
    tauri::async_runtime::spawn_blocking(move || resolve_items(&ids))
        .await
        .map_err(|_| unsupported("the item check was interrupted"))?
}

/// Closes the panel if this window is showing it, otherwise previews `ids`.
/// Returns whether the preview is showing afterwards.
pub async fn toggle<R: Runtime>(
    window: &WebviewWindow<R>,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, ids);
        Err(unsupported("it is only available on macOS"))
    }
    #[cfg(target_os = "macos")]
    {
        if on_main(window, |label, handle| {
            native::close_if_showing(label, handle)
        })
        .await?
        {
            return Ok(false);
        }
        let paths = resolve(ids).await?;
        on_main(window, move |label, handle| {
            native::show(label, handle, &paths)
        })
        .await?;
        Ok(true)
    }
}

/// Applies the current selection to a preview this window is showing. Without an
/// open preview it does nothing. An empty selection closes the preview, and so
/// does a selection that can no longer be previewed (the error is returned).
pub async fn sync<R: Runtime>(
    window: &WebviewWindow<R>,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, ids);
        Err(unsupported("it is only available on macOS"))
    }
    #[cfg(target_os = "macos")]
    {
        if !on_main(window, |label, handle| native::is_showing(label, handle)).await? {
            return Ok(false);
        }
        if ids.is_empty() {
            on_main(window, |label, handle| {
                native::close_if_showing(label, handle).map(|_| ())
            })
            .await?;
            return Ok(false);
        }
        match resolve(ids).await {
            Ok(paths) => {
                on_main(window, move |label, handle| {
                    native::update(label, handle, &paths)
                })
                .await
            }
            Err(error) => {
                on_main(window, |label, handle| {
                    native::close_if_showing(label, handle).map(|_| ())
                })
                .await?;
                Err(error)
            }
        }
    }
}

/// Releases everything this window's preview owns (called when the window is destroyed).
pub fn release<R: Runtime>(app: &tauri::AppHandle<R>, label: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || native::release(&label));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

#[cfg(target_os = "macos")]
pub mod native {
    //! AppKit side. Every function must run on the main thread; state lives in a
    //! main-thread-local table keyed by window label.

    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        ffi::c_void,
        path::PathBuf,
    };

    use objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::{Retained, Weak},
        runtime::{NSObjectProtocol, ProtocolObject},
    };
    use objc2_app_kit::{NSResponder, NSWindow};
    use objc2_foundation::{NSInteger, NSURL};
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource};

    use crate::macos::file_url_with;

    #[derive(Debug, Default)]
    struct Ivars {
        paths: RefCell<Vec<PathBuf>>,
        urls: RefCell<Vec<Retained<NSURL>>>,
        /// Set by `close_if_showing`: the panel fades out and still reports itself
        /// visible for a moment, but must no longer count as showing.
        closing: Cell<bool>,
    }

    define_class!(
        /// Responder-chain controller for the shared preview panel. It is also the
        /// panel's data source while it controls the panel; the panel does not
        /// retain it, so it is kept in `INSTALLED` and detached before release.
        #[unsafe(super(NSResponder))]
        #[thread_kind = MainThreadOnly]
        #[name = "MfmQuickLookController"]
        #[ivars = Ivars]
        struct Controller;

        unsafe impl NSObjectProtocol for Controller {}

        impl Controller {
            #[unsafe(method(acceptsPreviewPanelControl:))]
            fn accepts_control(&self, _panel: Option<&QLPreviewPanel>) -> bool {
                true
            }

            #[unsafe(method(beginPreviewPanelControl:))]
            fn begin_control(&self, panel: Option<&QLPreviewPanel>) {
                if let Some(panel) = panel {
                    // SAFETY: the controller outlives its control of the panel:
                    // `detach` clears the data source before the controller is dropped.
                    unsafe { panel.setDataSource(Some(ProtocolObject::from_ref(self))) };
                }
            }

            #[unsafe(method(endPreviewPanelControl:))]
            fn end_control(&self, panel: Option<&QLPreviewPanel>) {
                if let Some(panel) = panel {
                    detach(panel, self);
                }
            }
        }

        unsafe impl QLPreviewPanelDataSource for Controller {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn number_of_items(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                self.ivars().urls.borrow().len() as NSInteger
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn item_at(
                &self,
                _panel: Option<&QLPreviewPanel>,
                index: NSInteger,
            ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                let urls = self.ivars().urls.borrow();
                usize::try_from(index)
                    .ok()
                    .and_then(|i| urls.get(i))
                    .map(|url| ProtocolObject::from_retained(url.clone()))
            }
        }
    );

    impl Controller {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            // SAFETY: plain `init` of the NSResponder subclass.
            unsafe { msg_send![super(Self::alloc(mtm).set_ivars(Ivars::default())), init] }
        }

        fn set_items(&self, paths: &[PathBuf]) -> bool {
            if *self.ivars().paths.borrow() == paths {
                return false;
            }
            let urls = paths
                .iter()
                .filter_map(|p| file_url_with(p, p.is_dir()))
                .collect::<Vec<_>>();
            *self.ivars().paths.borrow_mut() = paths.to_vec();
            *self.ivars().urls.borrow_mut() = urls;
            true
        }
    }

    struct Installed {
        controller: Retained<Controller>,
        window: Weak<NSWindow>,
        previous: Option<Weak<NSResponder>>,
    }

    thread_local! {
        static INSTALLED: RefCell<HashMap<String, Installed>> = RefCell::new(HashMap::new());
    }

    fn address<T: ?Sized>(object: &T) -> usize {
        object as *const T as *const () as usize
    }

    /// Clears the panel's data source if `controller` is still the one set.
    fn detach(panel: &QLPreviewPanel, controller: &Controller) {
        // SAFETY: main-thread property reads and a nil assignment.
        unsafe {
            if let Some(source) = panel.dataSource()
                && address(&*source) == address(controller)
            {
                panel.setDataSource(None);
            }
        }
    }

    fn controls(panel: &QLPreviewPanel, controller: &Controller) -> bool {
        // SAFETY: reads the panel's current controller on the main thread.
        unsafe { panel.currentController() }
            .is_some_and(|current| address(&*current) == address(controller))
    }

    fn existing_panel(mtm: MainThreadMarker) -> Option<Retained<QLPreviewPanel>> {
        // SAFETY: main-thread class method calls.
        unsafe {
            if QLPreviewPanel::sharedPreviewPanelExists(mtm) {
                QLPreviewPanel::sharedPreviewPanel(mtm)
            } else {
                None
            }
        }
    }

    fn main_thread() -> Result<MainThreadMarker, String> {
        MainThreadMarker::new().ok_or_else(|| "AppKit was used off the main thread".to_string())
    }

    fn controller_of(label: &str) -> Option<Retained<Controller>> {
        INSTALLED.with_borrow(|map| map.get(label).map(|i| i.controller.clone()))
    }

    /// Inserts the controller behind the window in its responder chain (once).
    fn install(
        mtm: MainThreadMarker,
        label: &str,
        handle: *mut c_void,
    ) -> Result<Retained<Controller>, String> {
        // SAFETY: `handle` is the live NSWindow of the calling Tauri window; it is
        // only used on the main thread during this call.
        let window = unsafe { Retained::retain(handle as *mut NSWindow) }
            .ok_or("the window has no native handle")?;
        let existing = INSTALLED.with_borrow(|map| {
            map.get(label)
                .filter(|i| {
                    i.window
                        .load()
                        .is_some_and(|w| address(&*w) == address(&*window))
                })
                .map(|i| i.controller.clone())
        });
        if let Some(controller) = existing {
            return Ok(controller);
        }
        release(label);
        let controller = Controller::new(mtm);
        // SAFETY: responder links are unretained; the controller is kept alive by
        // `INSTALLED` and unlinked in `release` before it is dropped.
        let previous = unsafe { window.nextResponder() };
        unsafe {
            controller.setNextResponder(previous.as_deref());
            window.setNextResponder(Some(&controller));
        }
        INSTALLED.with_borrow_mut(|map| {
            map.insert(
                label.to_string(),
                Installed {
                    controller: controller.clone(),
                    window: Weak::new(&window),
                    previous: previous.as_deref().map(Weak::new),
                },
            )
        });
        Ok(controller)
    }

    pub fn is_showing(label: &str, _handle: *mut c_void) -> Result<bool, String> {
        let mtm = main_thread()?;
        let Some(controller) = controller_of(label) else {
            return Ok(false);
        };
        Ok(!controller.ivars().closing.get()
            && existing_panel(mtm).is_some_and(|p| p.isVisible() && controls(&p, &controller)))
    }

    /// Closes the panel if this window's controller is showing it.
    pub fn close_if_showing(label: &str, handle: *mut c_void) -> Result<bool, String> {
        if !is_showing(label, handle)? {
            return Ok(false);
        }
        if let Some(controller) = controller_of(label) {
            controller.ivars().closing.set(true);
        }
        if let Some(panel) = existing_panel(main_thread()?) {
            panel.orderOut(None);
        }
        Ok(true)
    }

    /// Shows the panel for `paths`, failing unless the panel really attached to
    /// this window's controller.
    pub fn show(label: &str, handle: *mut c_void, paths: &[PathBuf]) -> Result<(), String> {
        let mtm = main_thread()?;
        let controller = install(mtm, label, handle)?;
        let showing = is_showing(label, handle)?;
        controller.ivars().closing.set(false);
        controller.set_items(paths);
        // SAFETY: main-thread access to the shared panel.
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }
            .ok_or("the system preview panel could not be created")?;
        if showing {
            // SAFETY: the controller is the panel's current data source.
            unsafe {
                panel.reloadData();
                panel.setCurrentPreviewItemIndex(0);
            }
        } else {
            panel.makeKeyAndOrderFront(None);
            if !(panel.isVisible() && controls(&panel, &controller)) {
                panel.orderOut(None);
                return Err("the preview panel could not be attached to this window".to_string());
            }
        }
        Ok(())
    }

    /// Replaces the items of a panel this window is showing. `Ok(false)` when it is not showing.
    pub fn update(label: &str, handle: *mut c_void, paths: &[PathBuf]) -> Result<bool, String> {
        if !is_showing(label, handle)? {
            return Ok(false);
        }
        let controller = controller_of(label).ok_or("the preview controller is missing")?;
        if controller.set_items(paths)
            && let Some(panel) = existing_panel(main_thread()?)
        {
            // SAFETY: the controller is the panel's current data source.
            unsafe {
                panel.reloadData();
                panel.setCurrentPreviewItemIndex(0);
            }
        }
        Ok(true)
    }

    /// Detaches and drops everything owned for `label`: closes its panel, clears the
    /// data source and takes the controller out of the window's responder chain.
    pub fn release(label: &str) {
        let Some(installed) = INSTALLED.with_borrow_mut(|map| map.remove(label)) else {
            return;
        };
        if let Some(mtm) = MainThreadMarker::new()
            && let Some(panel) = existing_panel(mtm)
        {
            if controls(&panel, &installed.controller) {
                panel.orderOut(None);
            }
            detach(&panel, &installed.controller);
        }
        // SAFETY: unlinks the controller from the chain on the main thread.
        unsafe {
            if let Some(window) = installed.window.load()
                && window
                    .nextResponder()
                    .is_some_and(|next| address(&*next) == address(&*installed.controller))
            {
                let previous = installed.previous.as_ref().and_then(Weak::load);
                window.setNextResponder(previous.as_deref());
            }
            installed.controller.setNextResponder(None);
        }
    }

    /// What the panel currently shows, for tests and the native acceptance example.
    #[doc(hidden)]
    #[derive(Debug, PartialEq, Eq)]
    pub struct Snapshot {
        pub visible: bool,
        pub owned: bool,
        pub item_count: usize,
        pub current_path: Option<String>,
    }

    #[doc(hidden)]
    pub fn snapshot(label: &str) -> Snapshot {
        let controller = controller_of(label);
        let panel = MainThreadMarker::new().and_then(existing_panel);
        let owned = match (&panel, &controller) {
            (Some(p), Some(c)) => controls(p, c),
            _ => false,
        };
        let current_path = panel.as_ref().filter(|_| owned).and_then(|p| {
            // SAFETY: reads the panel's current item on the main thread.
            unsafe { p.currentPreviewItem() }
                .and_then(|item| unsafe { item.previewItemURL() })
                .and_then(|url| url.path())
                .map(|path| path.to_string())
        });
        Snapshot {
            visible: panel.as_ref().is_some_and(|p| p.isVisible()),
            owned,
            item_count: controller.map_or(0, |c| c.ivars().urls.borrow().len()),
            current_path,
        }
    }

    #[doc(hidden)]
    pub fn is_installed(label: &str) -> bool {
        INSTALLED.with_borrow(|map| map.contains_key(label))
    }

    #[doc(hidden)]
    pub fn controller_address(label: &str) -> Option<usize> {
        controller_of(label).map(|c| address(&*c))
    }

    #[doc(hidden)]
    pub fn data_source_address() -> Option<usize> {
        let panel = existing_panel(MainThreadMarker::new()?)?;
        // SAFETY: main-thread read.
        unsafe { panel.dataSource() }.map(|s| address(&*s))
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::{contracts::path_to_id, spike_fixture::Fixture};

    fn fixture() -> Fixture {
        Fixture::create_in(&std::env::temp_dir(), "mfm-ql-unit").unwrap()
    }

    fn category(ids: &[String]) -> ErrorCategory {
        resolve_items(ids).unwrap_err().category
    }

    #[test]
    fn existing_files_and_folders_resolve_in_order_without_duplicates() {
        let fx = fixture();
        let a = fx.write("a.txt", "a").unwrap();
        let b = fx.write("b.txt", "b").unwrap();
        let dir = fx.path().join("dir");
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(&a, fx.path().join("link")).unwrap();
        let link = fx.path().join("link");
        let ids: Vec<String> = [&b, &a, &b, &dir, &link]
            .iter()
            .map(|p| path_to_id(p))
            .collect();
        assert_eq!(resolve_items(&ids).unwrap(), vec![b, a, dir, link]);
        fx.cleanup().unwrap();
    }

    #[test]
    fn bad_requests_are_typed_errors() {
        let fx = fixture();
        let file = fx.write("a.txt", "a").unwrap();
        assert_eq!(category(&[]), ErrorCategory::InvalidInput);
        assert_eq!(category(&["zz".into()]), ErrorCategory::InvalidInput);
        assert_eq!(
            category(&[hex_of("relative/path")]),
            ErrorCategory::InvalidInput
        );
        let too_many = vec![path_to_id(&file); MAX_ITEMS + 1];
        assert_eq!(category(&too_many), ErrorCategory::InvalidInput);
        assert!(resolve_items(&vec![path_to_id(&file); MAX_ITEMS]).is_ok());
        let missing = path_to_id(&fx.path().join("missing"));
        assert_eq!(category(&[missing]), ErrorCategory::NotFound);
        std::os::unix::fs::symlink("nowhere", fx.path().join("broken")).unwrap();
        let broken = path_to_id(&fx.path().join("broken"));
        assert_eq!(category(&[broken]), ErrorCategory::NotFound);
        // One bad item rejects the whole request.
        let missing = path_to_id(&fx.path().join("gone"));
        assert_eq!(
            category(&[path_to_id(&file), missing]),
            ErrorCategory::NotFound
        );
        fx.cleanup().unwrap();
    }

    fn hex_of(text: &str) -> String {
        text.bytes().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn unreadable_files_and_special_files_are_refused() {
        let fx = fixture();
        let secret = fx.write("secret.txt", "s").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = resolve_items(&[path_to_id(&secret)]);
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o600)).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(
                denied.unwrap_err().category,
                ErrorCategory::PermissionDenied
            );
        }
        let fifo = fx.path().join("pipe");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        // Must return promptly: a FIFO is never opened.
        assert_eq!(category(&[path_to_id(&fifo)]), ErrorCategory::InvalidInput);
        fx.cleanup().unwrap();
    }
}
