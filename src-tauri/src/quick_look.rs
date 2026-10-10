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

/// Result of a main-thread panel operation that is guarded by the request order.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// A newer request superseded this one; nothing was changed. Carries whether the panel is showing.
    Stale(bool),
    /// The operation ran; carries its outcome (see each operation).
    Done(bool),
}

/// The panel operations the command flows need. Every mutating operation re-checks
/// on the main thread that `seq` is still the newest request of its window.
#[allow(async_fn_in_trait)]
pub trait Panel {
    /// Registers `seq` as the newest request, which supersedes every older one still
    /// pending. Returns false (and registers nothing) if a newer one already exists.
    fn begin(&self, seq: u64) -> bool;
    fn is_current(&self, seq: u64) -> bool;
    async fn showing(&self) -> Result<bool, AppError>;
    /// `Done(true)`: it was showing and is now closing.
    async fn close_if_showing(&self, seq: u64) -> Result<Step, AppError>;
    /// `Done(true)`.
    async fn show(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError>;
    /// `Done(showing afterwards)`.
    async fn update(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError>;
}

fn settled(step: Step) -> bool {
    match step {
        Step::Stale(showing) | Step::Done(showing) => showing,
    }
}

/// Closes the panel if this window is showing it, otherwise previews `ids`.
/// Returns whether the preview is showing afterwards. Superseded requests change
/// nothing and report the panel as it is.
pub async fn run_toggle<
    P: Panel,
    F: std::future::Future<Output = Result<Vec<PathBuf>, AppError>>,
>(
    panel: &P,
    seq: u64,
    resolve: impl FnOnce(Vec<String>) -> F,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    if !panel.begin(seq) {
        return panel.showing().await;
    }
    match panel.close_if_showing(seq).await? {
        Step::Stale(showing) => return Ok(showing),
        Step::Done(true) => return Ok(false),
        Step::Done(false) => {}
    }
    let paths = match resolve(ids).await {
        Ok(paths) => paths,
        Err(_) if !panel.is_current(seq) => return panel.showing().await,
        Err(error) => return Err(error),
    };
    panel.show(seq, paths).await.map(|step| match step {
        Step::Done(_) => true,
        Step::Stale(showing) => showing,
    })
}

/// Applies the current selection to a preview this window is showing; without one it
/// only supersedes older pending requests. An empty selection closes the preview, and
/// so does a selection that can no longer be previewed (the error is returned).
pub async fn run_sync<P: Panel, F: std::future::Future<Output = Result<Vec<PathBuf>, AppError>>>(
    panel: &P,
    seq: u64,
    resolve: impl FnOnce(Vec<String>) -> F,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    if !panel.begin(seq) || !panel.showing().await? {
        return panel.showing().await;
    }
    if ids.is_empty() {
        return panel.close_if_showing(seq).await.map(|_| false);
    }
    match resolve(ids).await {
        Ok(paths) => panel.update(seq, paths).await.map(settled),
        Err(_) if !panel.is_current(seq) => panel.showing().await,
        Err(error) => match panel.close_if_showing(seq).await? {
            Step::Stale(showing) => Ok(showing),
            Step::Done(_) => Err(error),
        },
    }
}

#[cfg(target_os = "macos")]
mod window_panel {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };

    use super::*;

    /// Newest request number per window label.
    static LATEST: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

    fn latest() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
        LATEST
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn forget(label: &str) {
        latest().remove(label);
    }

    pub struct WindowPanel<'a, R: Runtime>(pub &'a WebviewWindow<R>);

    impl<R: Runtime> Panel for WindowPanel<'_, R> {
        fn begin(&self, seq: u64) -> bool {
            let mut map = latest();
            let entry = map.entry(self.0.label().to_string()).or_insert(0);
            if seq > *entry {
                *entry = seq;
                true
            } else {
                false
            }
        }

        fn is_current(&self, seq: u64) -> bool {
            latest().get(self.0.label()) == Some(&seq)
        }

        async fn showing(&self) -> Result<bool, AppError> {
            on_main(self.0, |label, handle| native::is_showing(label, handle)).await
        }

        async fn close_if_showing(&self, seq: u64) -> Result<Step, AppError> {
            on_main(self.0, move |label, handle| {
                if latest().get(label) != Some(&seq) {
                    return native::is_showing(label, handle).map(Step::Stale);
                }
                native::close_if_showing(label, handle).map(Step::Done)
            })
            .await
        }

        async fn show(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError> {
            on_main(self.0, move |label, handle| {
                if latest().get(label) != Some(&seq) {
                    return native::is_showing(label, handle).map(Step::Stale);
                }
                native::show(label, handle, &paths).map(|_| Step::Done(true))
            })
            .await
        }

        async fn update(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError> {
            on_main(self.0, move |label, handle| {
                if latest().get(label) != Some(&seq) {
                    return native::is_showing(label, handle).map(Step::Stale);
                }
                native::update(label, handle, &paths).map(Step::Done)
            })
            .await
        }
    }
}

/// Closes the panel if this window is showing it, otherwise previews `ids`.
/// `seq` orders the window's requests: it must grow with every call.
pub async fn toggle<R: Runtime>(
    window: &WebviewWindow<R>,
    seq: u64,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, seq, ids);
        Err(unsupported("it is only available on macOS"))
    }
    #[cfg(target_os = "macos")]
    run_toggle(&window_panel::WindowPanel(window), seq, resolve, ids).await
}

/// Applies the current selection to a preview this window is showing, and in any
/// case supersedes older pending requests (so a still-pending open cannot show a
/// stale selection).
pub async fn sync<R: Runtime>(
    window: &WebviewWindow<R>,
    seq: u64,
    ids: Vec<String>,
) -> Result<bool, AppError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, seq, ids);
        Err(unsupported("it is only available on macOS"))
    }
    #[cfg(target_os = "macos")]
    run_sync(&window_panel::WindowPanel(window), seq, resolve, ids).await
}

/// Releases everything this window's preview owns (called when the window is destroyed).
pub fn release<R: Runtime>(app: &tauri::AppHandle<R>, label: String) {
    #[cfg(target_os = "macos")]
    {
        window_panel::forget(&label);
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

    use std::sync::{
        Arc, Mutex,
        mpsc::{Receiver, Sender, channel},
    };

    /// In-memory stand-in for the AppKit panel (not native: it only models the guarded
    /// operations so request ordering can be exercised deterministically).
    #[derive(Default)]
    struct FakePanel {
        latest: Mutex<u64>,
        state: Mutex<(bool, Vec<PathBuf>)>,
        begun: Mutex<u32>,
    }

    impl Panel for Arc<FakePanel> {
        fn begin(&self, seq: u64) -> bool {
            let mut latest = self.latest.lock().unwrap();
            let ok = seq > *latest;
            if ok {
                *latest = seq;
            }
            *self.begun.lock().unwrap() += 1;
            ok
        }
        fn is_current(&self, seq: u64) -> bool {
            *self.latest.lock().unwrap() == seq
        }
        async fn showing(&self) -> Result<bool, AppError> {
            Ok(self.state.lock().unwrap().0)
        }
        async fn close_if_showing(&self, seq: u64) -> Result<Step, AppError> {
            let mut state = self.state.lock().unwrap();
            if !self.is_current(seq) {
                return Ok(Step::Stale(state.0));
            }
            let was = state.0;
            state.0 = false;
            Ok(Step::Done(was))
        }
        async fn show(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError> {
            let mut state = self.state.lock().unwrap();
            if !self.is_current(seq) {
                return Ok(Step::Stale(state.0));
            }
            *state = (true, paths);
            Ok(Step::Done(true))
        }
        async fn update(&self, seq: u64, paths: Vec<PathBuf>) -> Result<Step, AppError> {
            let mut state = self.state.lock().unwrap();
            if !self.is_current(seq) {
                return Ok(Step::Stale(state.0));
            }
            if state.0 {
                state.1 = paths;
            }
            Ok(Step::Done(state.0))
        }
    }

    type Gate = Sender<Result<Vec<PathBuf>, AppError>>;

    /// Starts a flow whose item resolution only finishes when its gate is released.
    fn spawn_request(
        panel: &Arc<FakePanel>,
        toggle: bool,
        seq: u64,
        ids: Vec<String>,
    ) -> (
        Gate,
        tauri::async_runtime::JoinHandle<Result<bool, AppError>>,
    ) {
        let (gate, wait): (Gate, Receiver<_>) = channel();
        let panel = panel.clone();
        let target = panel.clone();
        let resolve = move |_: Vec<String>| async move {
            tauri::async_runtime::spawn_blocking(move || wait.recv().unwrap())
                .await
                .unwrap()
        };
        let before = *target.begun.lock().unwrap();
        let task = tauri::async_runtime::spawn(async move {
            if toggle {
                run_toggle(&panel, seq, resolve, ids).await
            } else {
                run_sync(&panel, seq, resolve, ids).await
            }
        });
        while *target.begun.lock().unwrap() == before {
            std::thread::yield_now();
        }
        (gate, task)
    }

    fn p(name: &str) -> Vec<PathBuf> {
        vec![PathBuf::from(name)]
    }
    fn open(panel: &Arc<FakePanel>, name: &str, seq: u64) {
        let (gate, task) = spawn_request(panel, true, seq, vec!["x".into()]);
        gate.send(Ok(p(name))).unwrap();
        assert!(tauri::async_runtime::block_on(task).unwrap().unwrap());
    }
    fn shown(panel: &Arc<FakePanel>) -> (bool, Vec<PathBuf>) {
        panel.state.lock().unwrap().clone()
    }
    fn gone() -> AppError {
        AppError::new(ErrorCategory::NotFound, OPERATION, None, "gone")
    }

    #[test]
    fn older_sync_finishing_last_cannot_overwrite_the_newer_selection() {
        let panel = Arc::new(FakePanel::default());
        open(&panel, "a", 1);
        let (gate_b, b) = spawn_request(&panel, false, 2, vec!["b".into()]);
        let (gate_c, c) = spawn_request(&panel, false, 3, vec!["c".into()]);
        gate_c.send(Ok(p("c"))).unwrap();
        assert!(tauri::async_runtime::block_on(c).unwrap().unwrap());
        gate_b.send(Ok(p("b"))).unwrap();
        assert!(tauri::async_runtime::block_on(b).unwrap().unwrap());
        assert_eq!(shown(&panel), (true, p("c")));
    }

    #[test]
    fn stale_failure_does_not_close_a_newer_preview_or_report_an_error() {
        let panel = Arc::new(FakePanel::default());
        open(&panel, "a", 1);
        let (gate_b, b) = spawn_request(&panel, false, 2, vec!["b".into()]);
        let (gate_c, c) = spawn_request(&panel, false, 3, vec!["c".into()]);
        gate_c.send(Ok(p("c"))).unwrap();
        tauri::async_runtime::block_on(c).unwrap().unwrap();
        gate_b.send(Err(gone())).unwrap();
        assert_eq!(tauri::async_runtime::block_on(b).unwrap(), Ok(true));
        assert_eq!(shown(&panel), (true, p("c")));
    }

    #[test]
    fn stale_failure_after_close_and_reopen_leaves_the_new_preview() {
        let panel = Arc::new(FakePanel::default());
        open(&panel, "a", 1);
        let (gate_b, b) = spawn_request(&panel, false, 2, vec!["b".into()]);
        let (gate_close, close) = spawn_request(&panel, true, 3, vec![]);
        drop(gate_close);
        assert!(!tauri::async_runtime::block_on(close).unwrap().unwrap());
        open(&panel, "d", 4);
        gate_b.send(Err(gone())).unwrap();
        assert_eq!(tauri::async_runtime::block_on(b).unwrap(), Ok(true));
        assert_eq!(shown(&panel), (true, p("d")));
    }

    #[test]
    fn a_current_failed_sync_closes_and_reports_the_error() {
        let panel = Arc::new(FakePanel::default());
        open(&panel, "a", 1);
        let (gate, task) = spawn_request(&panel, false, 2, vec!["b".into()]);
        gate.send(Err(gone())).unwrap();
        let error = tauri::async_runtime::block_on(task).unwrap().unwrap_err();
        assert_eq!(error.category, ErrorCategory::NotFound);
        assert!(!shown(&panel).0);
    }

    #[test]
    fn pending_open_is_invalidated_by_a_later_sync_even_while_closed() {
        // Selection, tab, navigation or an empty tab changing during the first open.
        for ids in [vec![], vec!["other".to_string()]] {
            let panel = Arc::new(FakePanel::default());
            let (gate_open, open_task) = spawn_request(&panel, true, 1, vec!["a".into()]);
            let (gate_sync, sync) = spawn_request(&panel, false, 2, ids);
            drop(gate_sync);
            assert!(!tauri::async_runtime::block_on(sync).unwrap().unwrap());
            gate_open.send(Ok(p("a"))).unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(open_task).unwrap(),
                Ok(false)
            );
            assert!(!shown(&panel).0, "a stale pending open must not show");
        }
    }

    #[test]
    fn stale_toggle_failure_is_not_reported_and_closing_wins_over_a_pending_open() {
        let panel = Arc::new(FakePanel::default());
        let (gate_open, open_task) = spawn_request(&panel, true, 1, vec!["a".into()]);
        let (_gate_sync, sync) = spawn_request(&panel, false, 2, vec!["b".into()]);
        assert!(!tauri::async_runtime::block_on(sync).unwrap().unwrap());
        gate_open.send(Err(gone())).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(open_task).unwrap(),
            Ok(false)
        );
    }

    #[test]
    fn requests_arriving_out_of_order_are_ignored() {
        let panel = Arc::new(FakePanel::default());
        open(&panel, "c", 5);
        let (gate, task) = spawn_request(&panel, false, 4, vec!["b".into()]);
        drop(gate);
        assert_eq!(tauri::async_runtime::block_on(task).unwrap(), Ok(true));
        assert_eq!(shown(&panel), (true, p("c")));
    }
}
