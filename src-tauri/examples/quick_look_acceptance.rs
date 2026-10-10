//! Native Quick Look acceptance run (not part of the shipped app).
//!
//! Run: `cargo run --locked --manifest-path src-tauri/Cargo.toml --example quick_look_acceptance`
//!
//! Needs a GUI session. It starts the real Tauri runtime (a real `NSWindow` with a
//! real `WKWebView`; the page itself is empty because there are no bundled
//! assets) with the application's command registration, creates a window named
//! `main`, and then calls the real `quick_look_toggle` / `quick_look_sync` commands
//! from the WebView through Tauri IPC. After every step it reads the state of the
//! system `QLPreviewPanel` on the main thread. Only exclusively owned temp fixtures
//! (an image, a PDF and a text file) are previewed. It does not need screen
//! recording or accessibility permission, so it checks panel state, not pixels:
//! it cannot show that the preview is rendered correctly on screen.

#[cfg(target_os = "macos")]
mod run {
    use std::{
        path::{Path, PathBuf},
        sync::mpsc,
        time::{Duration, Instant},
    };

    use base64::Engine;
    use mac_file_manager_lib::{
        contracts::path_to_id,
        quick_look::native::{self, Snapshot},
        spike_fixture::Fixture,
    };
    use serde_json::Value;
    use tauri::{
        AppHandle, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
        test::{mock_context, noop_assets},
    };

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const PDF: &str = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Quick Look PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n";

    fn canonical(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// The panel fades out after `orderOut`, so closing is polled for.
    fn closed(app: &AppHandle<Wry>) -> Snapshot {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let s = snapshot(app);
            if !s.visible || Instant::now() > deadline {
                return s;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn on_main<T: Send + 'static>(
        app: &AppHandle<Wry>,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> T {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(work());
        })
        .unwrap();
        rx.recv_timeout(Duration::from_secs(10))
            .expect("main thread")
    }

    fn snapshot(app: &AppHandle<Wry>) -> Snapshot {
        on_main(app, || native::snapshot("main"))
    }

    /// Calls an app command from the WebView and returns its JSON result or error.
    fn invoke(window: &WebviewWindow<Wry>, n: u32, cmd: &str, args: Value) -> Result<Value, Value> {
        let script = format!(
            "window.__TAURI_INTERNALS__.invoke({cmd:?}, {args}).then(\
             (v) => {{ location.hash = 'r{n}=' + encodeURIComponent(JSON.stringify({{ok: v}})); }},\
             (e) => {{ location.hash = 'r{n}=' + encodeURIComponent(JSON.stringify({{err: e}})); }});"
        );
        window.eval(&script).unwrap();
        let prefix = format!("r{n}=");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(fragment) = window
                .url()
                .ok()
                .and_then(|u| u.fragment().map(String::from))
                && let Some(encoded) = fragment.strip_prefix(&prefix)
            {
                let text = urlencoding_decode(encoded);
                let value: Value = serde_json::from_str(&text).unwrap();
                return match value.get("ok") {
                    Some(ok) => Ok(ok.clone()),
                    None => Err(value["err"].clone()),
                };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("no IPC answer for {cmd}");
    }

    fn urlencoding_decode(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    struct Report(Vec<(String, bool)>);

    impl Report {
        fn check(&mut self, what: &str, ok: bool, detail: impl std::fmt::Debug) {
            println!("[{}] {what} — {detail:?}", if ok { "PASS" } else { "FAIL" });
            self.0.push((what.to_string(), ok));
        }
    }

    fn scenario(app: AppHandle<Wry>, window: WebviewWindow<Wry>) -> bool {
        let mut report = Report(Vec::new());
        let fixture = Fixture::create_in(&std::env::temp_dir(), "mfm-ql-accept").unwrap();
        let text = fixture
            .write("note.txt", "Quick Look text fixture\n")
            .unwrap();
        let image = fixture
            .write_bytes(
                "pixel.png",
                &base64::engine::general_purpose::STANDARD
                    .decode(PNG_1X1)
                    .unwrap(),
            )
            .unwrap();
        let pdf = fixture.write("doc.pdf", PDF).unwrap();
        let ids = |paths: &[&PathBuf]| -> Value {
            paths
                .iter()
                .map(|p| path_to_id(p))
                .collect::<Vec<_>>()
                .into()
        };
        let args = |paths: &[&PathBuf]| serde_json::json!({ "ids": ids(paths) });
        let mut n = 0;
        let mut call = |window: &WebviewWindow<Wry>, cmd: &str, a: Value| {
            n += 1;
            invoke(window, n, cmd, a)
        };

        // The window must be key for the panel to find its controller.
        window.set_focus().unwrap();
        on_main(&app, || {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            #[allow(deprecated)]
            NSApplication::sharedApplication(MainThreadMarker::new().unwrap())
                .activateIgnoringOtherApps(true);
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !window.is_focused().unwrap_or(false) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        report.check(
            "Tauri window is key",
            window.is_focused().unwrap_or(false),
            (),
        );

        let before = snapshot(&app);
        report.check(
            "no panel owned before the first request",
            !before.owned,
            &before,
        );

        // 1. Text file opens through WebView IPC.
        let r = call(&window, "quick_look_toggle", args(&[&text]));
        let s = snapshot(&app);
        report.check("text: toggle returns true", r == Ok(true.into()), &r);
        report.check(
            "text: panel visible, owned by this window, item is the fixture",
            s.visible && s.owned && s.item_count == 1 && s.current_path == Some(canonical(&text)),
            &s,
        );
        let (controller, source) = on_main(&app, || {
            (
                native::controller_address("main"),
                native::data_source_address(),
            )
        });
        report.check(
            "panel data source is this window's controller",
            controller.is_some() && controller == source,
            (controller, source),
        );

        // 2. Selection change while open: image + PDF (multi-selection).
        let r = call(&window, "quick_look_sync", args(&[&image, &pdf]));
        let s = snapshot(&app);
        report.check(
            "image+pdf: sync keeps it open with 2 items, first is the image",
            r == Ok(true.into())
                && s.visible
                && s.owned
                && s.item_count == 2
                && s.current_path == Some(canonical(&image)),
            (&r, &s),
        );
        let r = call(&window, "quick_look_sync", args(&[&pdf]));
        let s = snapshot(&app);
        report.check(
            "pdf: selection change shows the PDF",
            r == Ok(true.into())
                && s.owned
                && s.item_count == 1
                && s.current_path == Some(canonical(&pdf)),
            (&r, &s),
        );

        // 3. Tab change to an empty selection clears the preview.
        let r = call(&window, "quick_look_sync", args(&[]));
        let s = closed(&app);
        report.check(
            "empty selection closes the preview",
            r == Ok(false.into()) && !s.visible && !s.owned,
            (&r, &s),
        );
        let r = call(&window, "quick_look_sync", args(&[&text]));
        report.check(
            "sync without an open preview does nothing",
            r == Ok(false.into()) && !closed(&app).visible,
            &r,
        );

        // 4. A file that disappears: the preview is closed and the error is typed.
        call(&window, "quick_look_toggle", args(&[&image])).unwrap();
        std::fs::remove_file(&image).unwrap();
        let r = call(&window, "quick_look_sync", args(&[&image]));
        let s = closed(&app);
        report.check(
            "vanished file: typed notFound error and the panel is closed",
            matches!(&r, Err(e) if e["category"] == "notFound") && !s.visible && !s.owned,
            (&r, &s),
        );

        // 5. Toggle closes; an invalid request is a typed error and opens nothing.
        call(&window, "quick_look_toggle", args(&[&pdf])).unwrap();
        let r = call(&window, "quick_look_toggle", args(&[]));
        report.check(
            "second toggle closes",
            r == Ok(false.into()) && !closed(&app).visible,
            &r,
        );
        let r = call(&window, "quick_look_toggle", args(&[]));
        report.check(
            "empty toggle is invalidInput and shows nothing",
            matches!(&r, Err(e) if e["category"] == "invalidInput") && !closed(&app).visible,
            &r,
        );
        let r = call(
            &window,
            "quick_look_toggle",
            serde_json::json!({ "ids": ["zz"] }),
        );
        report.check(
            "malformed id is invalidInput",
            matches!(&r, Err(e) if e["category"] == "invalidInput") && !closed(&app).visible,
            &r,
        );

        // 6. Window close tears down the controller and the panel.
        call(&window, "quick_look_toggle", args(&[&text])).unwrap();
        let open = snapshot(&app);
        report.check(
            "preview open before the window closes",
            open.visible && open.owned,
            &open,
        );
        window.destroy().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut after = snapshot(&app);
        while (after.visible || native_installed(&app)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            after = snapshot(&app);
        }
        report.check(
            "window close: panel hidden, controller released, data source cleared",
            !after.visible
                && !after.owned
                && !native_installed(&app)
                && on_main(&app, native::data_source_address).is_none(),
            &after,
        );

        fixture.cleanup().unwrap();
        let failed = report.0.iter().filter(|(_, ok)| !ok).count();
        println!("{} checks, {failed} failed", report.0.len());
        failed == 0
    }

    fn native_installed(app: &AppHandle<Wry>) -> bool {
        on_main(app, || native::is_installed("main"))
    }

    pub fn main() {
        let app = mac_file_manager_lib::register(tauri::Builder::<Wry>::new())
            .build(mock_context(noop_assets()))
            .expect("build the Tauri app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
            .title("Quick Look acceptance")
            .inner_size(480.0, 320.0)
            .build()
            .expect("create the main window");
        // Mirror the app's window-event cleanup.
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                mac_file_manager_lib::quick_look::release(&handle, "main".to_string());
            }
        });
        let driver_app = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let ok = scenario(driver_app.clone(), window);
            driver_app.exit(if ok { 0 } else { 1 });
        });
        // Closing the only window must not end the run before its state is inspected.
        app.run(|_, event| {
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    run::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macOS only");
}
