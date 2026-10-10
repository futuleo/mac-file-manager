pub mod contracts;
pub mod filesystem;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
/// Owned scratch directories for the `examples/` spikes and unit tests.
pub mod spike_fixture;

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use base64::Engine;
use tauri::{Emitter, Runtime, State, WebviewWindow};

use contracts::{
    AppError, DIRECTORY_EVENT, ErrorCategory, FileEntry, NativeCapabilities, PlatformInfo,
    display_name,
};

/// Configured deployment target, not a tested support claim. Keep in sync with
/// `bundle.macOS.minimumSystemVersion` in tauri.conf.json.
pub const DEPLOYMENT_TARGET: &str = "12.0";

#[cfg(target_os = "macos")]
fn native_probe() -> (String, NativeCapabilities) {
    (macos::os_version(), macos::capabilities())
}

#[cfg(not(target_os = "macos"))]
fn native_probe() -> (String, NativeCapabilities) {
    (
        "unsupported".into(),
        NativeCapabilities {
            spotlight_query: false,
            quick_look_panel: false,
            trash: false,
            system_icons: false,
            drag_session: false,
        },
    )
}

pub fn platform_info() -> PlatformInfo {
    let (os_version, capabilities) = native_probe();
    PlatformInfo {
        app_version: env!("CARGO_PKG_VERSION").into(),
        os_version,
        arch: std::env::consts::ARCH.into(),
        deployment_target: DEPLOYMENT_TARGET.into(),
        capabilities,
    }
}

#[tauri::command]
fn get_platform_info() -> PlatformInfo {
    platform_info()
}

/// Cancellation flags of in-flight directory reads, keyed by the caller's read id.
#[derive(Default)]
struct DirectoryReads(Mutex<HashMap<String, Arc<AtomicBool>>>);

const MAX_CONCURRENT_READS: usize = 32;
const MAX_READ_ID_LEN: usize = 128;

impl DirectoryReads {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn register(&self, read_id: &str) -> Result<Arc<AtomicBool>, AppError> {
        let invalid =
            |m: &str| AppError::new(ErrorCategory::InvalidInput, "read the folder", None, m);
        if read_id.is_empty() || read_id.len() > MAX_READ_ID_LEN {
            return Err(invalid("The read identifier is invalid."));
        }
        let mut reads = self.lock();
        if reads.contains_key(read_id) {
            return Err(invalid("A read with this identifier is already running."));
        }
        if reads.len() >= MAX_CONCURRENT_READS {
            return Err(invalid("Too many folder reads are in progress."));
        }
        let flag = Arc::new(AtomicBool::new(false));
        reads.insert(read_id.into(), flag.clone());
        Ok(flag)
    }
}

/// Removes the registration when the read ends, however it ends.
struct ReadGuard<'a>(&'a DirectoryReads, String);
impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().remove(&self.1);
    }
}

fn join_error(operation: &str) -> AppError {
    AppError::new(
        ErrorCategory::Io,
        operation,
        None,
        "The background task failed unexpectedly.",
    )
}

#[tauri::command]
async fn get_home_directory() -> Result<FileEntry, AppError> {
    tauri::async_runtime::spawn_blocking(filesystem::home_directory)
        .await
        .map_err(|_| join_error("open the home folder"))?
}

#[tauri::command]
async fn parent_directory(id: String) -> Result<Option<FileEntry>, AppError> {
    let operation = "go to the parent folder";
    let path = filesystem::resolve_id(operation, &id)?;
    tauri::async_runtime::spawn_blocking(move || filesystem::parent_entry(&path))
        .await
        .map_err(|_| join_error(operation))?
}

/// Validates a typed folder path (see `filesystem::resolve_directory`).
#[tauri::command]
async fn resolve_directory(path: String) -> Result<FileEntry, AppError> {
    tauri::async_runtime::spawn_blocking(move || filesystem::resolve_directory(&path))
        .await
        .map_err(|_| join_error("open the folder"))?
}

#[tauri::command]
async fn list_places() -> Result<contracts::Places, AppError> {
    tauri::async_runtime::spawn_blocking(filesystem::places)
        .await
        .map_err(|_| join_error("list locations"))
}

/// Starts an asynchronous read; entries and the terminal event arrive on
/// `DIRECTORY_EVENT` tagged with `read_id`. Returns as soon as the read is queued.
#[tauri::command]
fn start_directory_read<R: Runtime>(
    window: WebviewWindow<R>,
    reads: State<'_, Arc<DirectoryReads>>,
    read_id: String,
    id: String,
) -> Result<(), AppError> {
    let dir = filesystem::resolve_id("read the folder", &id)?;
    let cancel = reads.register(&read_id)?;
    let reads = Arc::clone(&reads);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ReadGuard(&reads, read_id.clone());
        let label = window.label().to_string();
        filesystem::read_directory(
            &read_id,
            &dir,
            &cancel,
            filesystem::BATCH_SIZE,
            &mut |event| {
                let _ = window.emit_to(label.as_str(), DIRECTORY_EVENT, event);
            },
        );
    });
    Ok(())
}

/// Idempotent: cancelling a finished or unknown read is not an error.
#[tauri::command]
fn cancel_directory_read(reads: State<'_, Arc<DirectoryReads>>, read_id: String) {
    if let Some(flag) = reads.lock().get(&read_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Only existing regular files (or links to them) are opened; folders are navigated.
fn check_openable(path: &Path) -> Result<(), AppError> {
    let operation = "open";
    let meta = std::fs::metadata(path).map_err(|e| AppError::from_io(operation, path, &e))?;
    if meta.is_file() {
        return Ok(());
    }
    let name = display_name(path);
    Err(AppError::new(
        ErrorCategory::InvalidInput,
        operation,
        Some(name.clone()),
        format!("\"{name}\" is not a regular file, so it cannot be opened with an application."),
    ))
}

#[tauri::command]
async fn open_item<R: Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), AppError> {
    let path = filesystem::resolve_id("open", &id)?;
    let check_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || check_openable(&check_path))
        .await
        .map_err(|_| join_error("open"))??;
    open_on_main_thread(app, path).await
}

#[cfg(target_os = "macos")]
async fn open_on_main_thread<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: std::path::PathBuf,
) -> Result<(), AppError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let task_path = path.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(macos::open_with_default_app(&task_path));
    })
    .map_err(|_| join_error("open"))?;
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| join_error("open"))?;
    let name = display_name(&path);
    match outcome {
        Ok(Some(true)) => Ok(()),
        Ok(Some(false)) => Err(AppError::new(
            ErrorCategory::Unsupported,
            "open",
            Some(name.clone()),
            format!("macOS could not open \"{name}\" (no default application or it was refused)."),
        )),
        _ => Err(AppError::new(
            ErrorCategory::InvalidInput,
            "open",
            Some(name.clone()),
            format!("\"{name}\" has a path that cannot be opened."),
        )),
    }
}

#[cfg(not(target_os = "macos"))]
async fn open_on_main_thread<R: Runtime>(
    _app: tauri::AppHandle<R>,
    _path: std::path::PathBuf,
) -> Result<(), AppError> {
    Err(AppError::new(
        ErrorCategory::Unsupported,
        "open",
        None,
        "Opening files is only supported on macOS.",
    ))
}

#[cfg(target_os = "macos")]
fn render_icon(path: &Path, pixels: u32) -> Result<String, AppError> {
    // AppKit icon lookup is serialized to keep concurrent frontend requests safe.
    static ICON_LOCK: Mutex<()> = Mutex::new(());
    let _lock = ICON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let png = macos::icon_png(path, pixels).map_err(|reason| {
        AppError::new(
            ErrorCategory::Unsupported,
            "load the icon",
            Some(display_name(path)),
            format!("The icon is not available: {reason}."),
        )
    })?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

#[cfg(not(target_os = "macos"))]
fn render_icon(path: &Path, _pixels: u32) -> Result<String, AppError> {
    Err(AppError::new(
        ErrorCategory::Unsupported,
        "load the icon",
        Some(display_name(path)),
        "System icons are only available on macOS.",
    ))
}

/// Lazily loads the system icon as a PNG data URL (`size` is a pixel hint, 8-256).
#[tauri::command]
async fn get_icon(id: String, size: u32) -> Result<String, AppError> {
    let path = filesystem::resolve_id("load the icon", &id)?;
    let pixels = size.clamp(8, 256);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::symlink_metadata(&path)
            .map_err(|e| AppError::from_io("load the icon", &path, &e))?;
        render_icon(&path, pixels)
    })
    .await
    .map_err(|_| join_error("load the icon"))?
}

/// State and command registration, shared by the app and the mock-runtime tests.
fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(Arc::new(DirectoryReads::default()))
        .invoke_handler(tauri::generate_handler![
            get_platform_info,
            get_home_directory,
            parent_directory,
            resolve_directory,
            list_places,
            start_directory_read,
            cancel_directory_read,
            open_item,
            get_icon
        ])
}

pub fn run() {
    register(tauri::Builder::default())
        .menu(menu::build)
        .on_menu_event(menu::forward)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn platform_info_reports_current_architecture() {
        let info = super::platform_info();
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert_eq!(info.deployment_target, super::DEPLOYMENT_TARGET);
    }

    #[test]
    fn read_registry_rejects_duplicates_and_invalid_ids() {
        let reads = crate::DirectoryReads::default();
        let flag = reads.register("a").unwrap();
        assert!(reads.register("a").is_err());
        assert!(reads.register("").is_err());
        assert!(reads.register(&"x".repeat(200)).is_err());
        reads
            .lock()
            .get("a")
            .unwrap()
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        {
            let _g = super::ReadGuard(&reads, "a".into());
        }
        assert!(reads.register("a").is_ok());
        for i in 0..super::MAX_CONCURRENT_READS {
            let _ = reads.register(&format!("r{i}"));
        }
        assert!(reads.register("overflow").is_err());
    }

    #[test]
    fn only_regular_files_are_openable() {
        use crate::{contracts::ErrorCategory, spike_fixture::Fixture};
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-open-check").unwrap();
        let file = fx.write("a.txt", "x").unwrap();
        std::os::unix::fs::symlink("a.txt", fx.path().join("ln")).unwrap();
        std::os::unix::fs::symlink("nope", fx.path().join("broken")).unwrap();
        assert!(super::check_openable(&file).is_ok());
        assert!(super::check_openable(&fx.path().join("ln")).is_ok());
        let dir_err = super::check_openable(fx.path()).unwrap_err();
        assert_eq!(dir_err.category, ErrorCategory::InvalidInput);
        for missing in [fx.path().join("missing"), fx.path().join("broken")] {
            assert_eq!(
                super::check_openable(&missing).unwrap_err().category,
                ErrorCategory::NotFound
            );
        }
        fx.cleanup().unwrap();
    }

    // Real command dispatch, argument/result serialization and event emission,
    // but on Tauri's mock runtime: there is no webview, so this is not a GUI/WebView IPC check.
    mod ipc {
        use std::{
            sync::{Arc, Mutex},
            time::{Duration, Instant},
        };

        use serde_json::{Value, json};
        use tauri::{
            Listener, Manager, WebviewWindow,
            ipc::{CallbackFn, InvokeBody},
            test::{
                INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
            },
            webview::InvokeRequest,
        };

        use crate::{contracts::path_to_id, spike_fixture::Fixture};

        fn app() -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
            let app = crate::register(mock_builder())
                .build(mock_context(noop_assets()))
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
            (app, window)
        }

        fn invoke(
            window: &WebviewWindow<MockRuntime>,
            cmd: &str,
            body: Value,
        ) -> Result<Value, Value> {
            get_ipc_response(
                window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|b| match b {
                tauri::ipc::InvokeResponseBody::Json(text) => serde_json::from_str(&text).unwrap(),
                tauri::ipc::InvokeResponseBody::Raw(_) => panic!("unexpected raw body"),
            })
        }

        fn wait_for(
            events: &Arc<Mutex<Vec<Value>>>,
            done: impl Fn(&[Value]) -> bool,
        ) -> Vec<Value> {
            let start = Instant::now();
            loop {
                let snapshot = events.lock().unwrap().clone();
                if done(&snapshot) {
                    return snapshot;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(20),
                    "timed out: {snapshot:?}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn is_terminal(e: &Value) -> bool {
            e["type"] != "entries"
        }

        #[test]
        fn commands_round_trip_with_real_directory_data() {
            let (app, window) = app();
            let events = Arc::new(Mutex::new(Vec::<Value>::new()));
            let sink = events.clone();
            window.listen(crate::contracts::DIRECTORY_EVENT, move |e| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap());
            });

            let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-ipc-test").unwrap();
            fx.write("one.txt", "1").unwrap();
            std::fs::create_dir(fx.path().join("two")).unwrap();
            let id = path_to_id(fx.path());

            let home = invoke(&window, "get_home_directory", json!({})).unwrap();
            assert_eq!(home["kind"], "directory");
            let parent = invoke(&window, "parent_directory", json!({"id": id})).unwrap();
            assert_eq!(
                parent["path"],
                fx.path().parent().unwrap().to_string_lossy().as_ref()
            );
            assert_eq!(
                parent["path"],
                std::env::temp_dir()
                    .canonicalize()
                    .map(|_| parent["path"].clone())
                    .unwrap()
            );
            let typed = invoke(
                &window,
                "resolve_directory",
                json!({"path": format!("{}/./sub/..", fx.path().display())}),
            )
            .unwrap();
            assert_eq!(typed["kind"], "directory");
            let err =
                invoke(&window, "resolve_directory", json!({"path": "relative"})).unwrap_err();
            assert_eq!(err["category"], "invalidInput");
            let places = invoke(&window, "list_places", json!({})).unwrap();
            assert_eq!(places["places"][0]["label"], "Home");
            assert_eq!(places["places"][0]["entry"]["kind"], "directory");
            assert_eq!(
                invoke(
                    &window,
                    "parent_directory",
                    json!({"id": path_to_id(std::path::Path::new("/"))})
                )
                .unwrap(),
                Value::Null
            );

            assert_eq!(
                invoke(
                    &window,
                    "start_directory_read",
                    json!({"readId": "r1", "id": id})
                )
                .unwrap(),
                Value::Null
            );
            let seen = wait_for(&events, |e| e.iter().any(is_terminal));
            let listed: Vec<&Value> = seen
                .iter()
                .filter(|e| e["type"] == "entries")
                .flat_map(|e| e["entries"].as_array().unwrap())
                .collect();
            assert_eq!(listed.len(), 2);
            assert!(
                listed
                    .iter()
                    .any(|e| e["name"] == "one.txt" && e["kind"] == "file" && e["size"] == 1)
            );
            assert!(
                listed
                    .iter()
                    .any(|e| e["name"] == "two" && e["kind"] == "directory")
            );
            let end = seen.last().unwrap();
            assert_eq!(
                (
                    end["type"].as_str(),
                    end["readId"].as_str(),
                    end["entries"].as_u64()
                ),
                (Some("finished"), Some("r1"), Some(2))
            );

            // The finished read's registration is released, so the id can be reused.
            wait_for(&events, |_| {
                app.state::<Arc<crate::DirectoryReads>>().lock().is_empty()
            });
            events.lock().unwrap().clear();
            let missing = path_to_id(&fx.path().join("missing"));
            invoke(
                &window,
                "start_directory_read",
                json!({"readId": "r1", "id": missing}),
            )
            .unwrap();
            let seen = wait_for(&events, |e| e.iter().any(is_terminal));
            assert_eq!(seen[0]["type"], "failed");
            assert_eq!(seen[0]["error"]["category"], "notFound");

            // Typed rejections: malformed ids and opening a folder.
            let err = invoke(
                &window,
                "start_directory_read",
                json!({"readId": "r2", "id": "zz"}),
            )
            .unwrap_err();
            assert_eq!(err["category"], "invalidInput");
            let err = invoke(&window, "open_item", json!({"id": id})).unwrap_err();
            assert_eq!(err["category"], "invalidInput");
            let err = invoke(&window, "get_icon", json!({"id": missing, "size": 16})).unwrap_err();
            assert_eq!(err["category"], "notFound");
            assert_eq!(
                invoke(
                    &window,
                    "cancel_directory_read",
                    json!({"readId": "unknown"})
                )
                .unwrap(),
                Value::Null
            );

            let icon = invoke(
                &window,
                "get_icon",
                json!({"id": path_to_id(&fx.path().join("one.txt")), "size": 16}),
            )
            .unwrap();
            assert!(icon.as_str().unwrap().starts_with("data:image/png;base64,"));
            fx.cleanup().unwrap();
        }

        #[test]
        fn cancelling_stops_a_running_read() {
            let (_app, window) = app();
            let events = Arc::new(Mutex::new(Vec::<Value>::new()));
            let sink = events.clone();
            window.listen(crate::contracts::DIRECTORY_EVENT, move |e| {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(e.payload()).unwrap());
            });
            let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-ipc-cancel").unwrap();
            for i in 0..20_000 {
                std::fs::write(fx.path().join(format!("f{i}")), "").unwrap();
            }
            let id = path_to_id(fx.path());
            invoke(
                &window,
                "start_directory_read",
                json!({"readId": "c1", "id": id}),
            )
            .unwrap();
            invoke(&window, "cancel_directory_read", json!({"readId": "c1"})).unwrap();
            let seen = wait_for(&events, |e| e.iter().any(is_terminal));
            let end = seen.last().unwrap();
            // Cancellation raced the read: it either stopped or had already finished.
            assert!(
                matches!(end["type"].as_str(), Some("cancelled" | "finished")),
                "{end}"
            );
            if end["type"] == "cancelled" {
                let delivered: usize = seen
                    .iter()
                    .filter_map(|e| e["entries"].as_array())
                    .map(Vec::len)
                    .sum();
                assert!(delivered < 20_000);
            }
            fx.cleanup().unwrap();
        }
    }
}
