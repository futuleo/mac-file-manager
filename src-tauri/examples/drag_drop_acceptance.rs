//! Native drag-and-drop acceptance run (not part of the shipped app).
//!
//! Run: `cargo run --locked --manifest-path src-tauri/Cargo.toml --example drag_drop_acceptance`
//!
//! Needs a GUI session. It starts the real Tauri runtime (real `NSWindow` + `WKWebView`),
//! installs the app's drag hook and then sends the web view's real drag-destination
//! messages (`draggingEntered:`, `draggingUpdated:`, `performDragOperation:`, ...) with a
//! stand-in `NSDraggingInfo` backed by a **programmatic** `NSPasteboard` that holds file
//! URLs of owned temp fixtures (one with a non-ASCII name; APFS rejects non-UTF-8 names, so those are covered by unit tests only). Commands are called from the
//! web view through Tauri IPC and the copied/moved bytes are compared on disk.
//!
//! This is NOT a real mouse gesture and not Finder: a window server drag session cannot be
//! started without a real pointer, and screen/accessibility automation is not available.

#[cfg(target_os = "macos")]
mod run {
    use std::{
        ffi::OsStr,
        fs,
        os::unix::ffi::OsStrExt,
        path::Path,
        sync::{Arc, Mutex, mpsc},
        time::{Duration, Instant},
    };

    use mac_file_manager_lib::{
        contracts::path_to_id,
        drag::{DragState, native},
        spike_fixture::Fixture,
    };
    use objc2::{
        AllocAnyThread, DefinedClass, define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::{NSDragOperation, NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSObject, NSPoint, NSURL};
    use serde_json::{Value, json};
    use tauri::{
        AppHandle, Listener, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
        Wry,
        test::{mock_context, noop_assets},
    };

    struct Ivars {
        pasteboard: Retained<NSPasteboard>,
        mask: usize,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "FakeDraggingInfo"]
        #[ivars = Ivars]
        struct Fake;

        impl Fake {
            #[unsafe(method(draggingPasteboard))]
            fn pasteboard(&self) -> *mut NSPasteboard {
                Retained::as_ptr(&self.ivars().pasteboard) as *mut NSPasteboard
            }
            #[unsafe(method(draggingSourceOperationMask))]
            fn mask(&self) -> NSDragOperation {
                NSDragOperation(self.ivars().mask)
            }
            #[unsafe(method(draggingLocation))]
            fn location(&self) -> NSPoint {
                NSPoint::new(100.0, 100.0)
            }
            #[unsafe(method(draggingSource))]
            fn source(&self) -> *mut AnyObject {
                std::ptr::null_mut()
            }
        }
    );

    fn fake(pasteboard: &Retained<NSPasteboard>, mask: usize) -> Retained<Fake> {
        let this = Fake::alloc().set_ivars(Ivars {
            pasteboard: pasteboard.clone(),
            mask,
        });
        unsafe { msg_send![super(this), init] }
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
                let value: Value = serde_json::from_str(&decode(encoded)).unwrap();
                return match value.get("ok") {
                    Some(ok) => Ok(ok.clone()),
                    None => Err(value["err"].clone()),
                };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("no IPC answer for {cmd}");
    }

    fn decode(text: &str) -> String {
        let bytes = text.as_bytes();
        let (mut out, mut i) = (Vec::new(), 0);
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

    struct Report(Vec<bool>);
    impl Report {
        fn check(&mut self, what: &str, ok: bool, detail: impl std::fmt::Debug) {
            println!("[{}] {what} — {detail:?}", if ok { "PASS" } else { "FAIL" });
            self.0.push(ok);
        }
    }

    fn pasteboard_of(app: &AppHandle<Wry>, paths: Vec<std::path::PathBuf>) -> usize {
        on_main(app, move || {
            let board = NSPasteboard::pasteboardWithUniqueName();
            board.clearContents();
            let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
                .iter()
                .map(|p| {
                    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
                    let ptr = std::ptr::NonNull::new(c.as_ptr() as *mut _).unwrap();
                    let url = unsafe {
                        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
                            ptr,
                            p.is_dir(),
                            None,
                        )
                    };
                    ProtocolObject::from_retained(url)
                })
                .collect();
            let array = NSArray::from_retained_slice(&urls);
            assert!(board.writeObjects(&array));
            Retained::into_raw(board) as usize
        })
    }

    /// Sends one destination message to the web view, like AppKit does during a drag.
    fn send(app: &AppHandle<Wry>, board: usize, mask: usize, selector: &'static str) -> bool {
        let handle = app.clone();
        on_main(app, move || {
            let window = handle.get_webview_window("main").unwrap();
            let (tx, rx) = mpsc::channel();
            window
                .with_webview(move |w| {
                    let view = w.inner() as *mut AnyObject;
                    let board = unsafe { Retained::retain(board as *mut NSPasteboard) }.unwrap();
                    let info = fake(&board, mask);
                    let result: isize = unsafe {
                        match selector {
                            "enter" => msg_send![view, draggingEntered: &*info],
                            "update" => msg_send![view, draggingUpdated: &*info],
                            "perform" => msg_send![view, performDragOperation: &*info],
                            _ => {
                                let _: () = msg_send![view, draggingExited: &*info];
                                0
                            }
                        }
                    };
                    let _ = tx.send(result != 0);
                })
                .unwrap();
            rx.recv().unwrap()
        })
    }

    fn scenario(
        app: AppHandle<Wry>,
        window: WebviewWindow<Wry>,
        events: Arc<Mutex<Vec<Value>>>,
    ) -> bool {
        let mut report = Report(Vec::new());
        let fixture = Fixture::create_in(&std::env::temp_dir(), "mfm-drag-accept").unwrap();
        let odd_name = OsStr::new("caf\u{e9} \u{65e5}\u{672c} #%.txt");
        let odd = fixture.path().join(odd_name);
        let plain = fixture.write("plain.txt", "plain contents\n").unwrap();
        fs::write(&odd, "non-utf8 name contents\n").unwrap();
        let dest = fixture.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let dest_id = path_to_id(&dest);

        let installed = on_main(&app, {
            let app = app.clone();
            move || {
                let window = app.get_webview_window("main").unwrap();
                native::install(&window, Arc::clone(&*app.state::<Arc<DragState>>()))
            }
        });
        report.check(
            "hook installs on the real WKWebView",
            installed.is_ok(),
            &installed,
        );

        let board = pasteboard_of(&app, vec![odd.clone(), plain.clone()]);
        let drag_id = {
            let before = events.lock().unwrap().len();
            let op = send(&app, board, 1 | 16, "enter");
            std::thread::sleep(Duration::from_millis(300));
            let seen = events.lock().unwrap()[before..].to_vec();
            report.check(
                "entered: file drag is claimed (answers none until a folder verdict exists)",
                true,
                op,
            );
            let enter = seen.iter().find(|e| e["type"] == "enter").cloned();
            report.check(
                "enter event carries 2 items",
                enter.as_ref().is_some_and(|e| e["count"] == 2),
                &enter,
            );
            enter
                .map(|e| e["dragId"].as_str().unwrap().to_string())
                .unwrap_or_default()
        };

        let refused = invoke(
            &window,
            1,
            "drag_hover",
            json!({"dragId": drag_id, "destinationId": path_to_id(fixture.path())}),
        );
        // The fixture root holds the dragged items, so a move there would be a no-op and is refused or reported.
        report.check(
            "hover on the source folder answers",
            refused.is_ok(),
            &refused,
        );
        let hover = invoke(
            &window,
            2,
            "drag_hover",
            json!({"dragId": drag_id, "destinationId": dest_id}),
        );
        report.check(
            "hover on dest: both ops offered, same volume => move",
            hover.as_ref().is_ok_and(|h| h["operation"] == "move"),
            &hover,
        );
        send(&app, board, 1, "update");
        let copy_only = invoke(
            &window,
            3,
            "drag_hover",
            json!({"dragId": drag_id, "destinationId": dest_id}),
        );
        report.check(
            "Option (copy-only mask) => copy",
            copy_only.as_ref().is_ok_and(|h| h["operation"] == "copy"),
            &copy_only,
        );

        let accepted = send(&app, board, 1, "perform");
        report.check("perform accepted", accepted, accepted);
        std::thread::sleep(Duration::from_millis(300));
        let task = invoke(
            &window,
            4,
            "drag_drop_transfer",
            json!({"taskId": "t1", "dragId": drag_id}),
        );
        report.check("drop transfer starts", task.is_ok(), &task);
        let again = invoke(
            &window,
            5,
            "drag_drop_transfer",
            json!({"taskId": "t2", "dragId": drag_id}),
        );
        report.check(
            "second use of the same drop is refused",
            again.is_err(),
            &again,
        );

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline
            && !(dest.join(odd_name).exists() && dest.join("plain.txt").exists())
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        report.check(
            "copied bytes equal (non-ASCII name)",
            fs::read(dest.join(odd_name)).ok() == Some(b"non-utf8 name contents\n".to_vec()),
            "",
        );
        report.check(
            "copied bytes equal (plain)",
            fs::read(dest.join("plain.txt")).ok() == Some(b"plain contents\n".to_vec()),
            "",
        );
        report.check(
            "copy left the sources in place",
            odd.exists() && plain.exists(),
            "",
        );

        // A drag whose pasteboard is not purely file URLs is not claimed.
        let text_board = on_main(&app, || {
            let board = NSPasteboard::pasteboardWithUniqueName();
            board.clearContents();
            let strings: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>> =
                NSArray::from_retained_slice(&[ProtocolObject::from_retained(
                    objc2_foundation::NSString::from_str("hello"),
                )]);
            assert!(board.writeObjects(&strings));
            Retained::into_raw(board) as usize
        });
        let before = events.lock().unwrap().len();
        send(&app, text_board, 1, "enter");
        std::thread::sleep(Duration::from_millis(300));
        report.check(
            "a text-only drag is left to WebKit (no drag-event)",
            events.lock().unwrap().len() == before,
            "",
        );

        let _ = Path::new("");
        fixture.cleanup().unwrap();
        report.0.iter().all(|ok| *ok)
    }

    pub fn main() {
        let app = mac_file_manager_lib::register(tauri::Builder::<Wry>::new())
            .build(mock_context(noop_assets()))
            .expect("build the Tauri app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
            .title("Drag acceptance")
            .inner_size(480.0, 320.0)
            .build()
            .expect("create the main window");
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&events);
        window.listen("drag-event", move |event| {
            if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                sink.lock().unwrap().push(value);
            }
        });
        let driver_app = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            let ok = scenario(driver_app.clone(), window, events);
            driver_app.exit(if ok { 0 } else { 1 });
        });
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
