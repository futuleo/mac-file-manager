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
//! started without a real pointer, and Accessibility automation is not available (the process is
//! not trusted, so synthesised events are dropped). It does execute real moves, copies and
//! conflict decisions through the shared transfer service and asserts the results on disk.

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
    /// Returns the operation the view answered (`NSDragOperation` bits; `performDragOperation:` 1/0).
    fn send(app: &AppHandle<Wry>, board: usize, mask: usize, selector: &'static str) -> isize {
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
                            "perform" => {
                                let accepted: bool = msg_send![view, performDragOperation: &*info];
                                accepted as isize
                            }
                            _ => {
                                let _: () = msg_send![view, draggingExited: &*info];
                                0
                            }
                        }
                    };
                    let _ = tx.send(result);
                })
                .unwrap();
            rx.recv().unwrap()
        })
    }

    type Events = Arc<Mutex<Vec<Value>>>;

    const COPY: isize = 1;
    const MOVE: isize = 16;

    /// One synthetic drag session driven through the real destination methods.
    struct Drag<'a> {
        app: &'a AppHandle<Wry>,
        window: &'a WebviewWindow<Wry>,
        events: &'a Events,
        board: usize,
        id: String,
        ipc: &'a mut u32,
        token: u64,
    }

    impl Drag<'_> {
        fn find(&self, kind: &str, skip: usize) -> Option<Value> {
            self.events.lock().unwrap()[skip..]
                .iter()
                .rev()
                .find(|e| e["type"] == kind)
                .cloned()
        }
        fn mark(&self) -> usize {
            self.events.lock().unwrap().len()
        }
        fn call(&mut self, cmd: &str, args: Value) -> Result<Value, Value> {
            *self.ipc += 1;
            invoke(self.window, *self.ipc, cmd, args)
        }
        /// A pointer update with `mask`; returns the cursor operation answered.
        fn update(&self, mask: usize) -> (isize, u64) {
            let before = self.mark();
            let answer = send(self.app, self.board, mask, "update");
            std::thread::sleep(Duration::from_millis(200));
            let pointer = self
                .find("over", before)
                .map_or(0, |e| e["pointer"].as_u64().unwrap());
            (answer, pointer)
        }
        fn hover(&mut self, pointer: u64, dest: &Path) -> Result<Value, Value> {
            self.token += 1;
            let args = json!({"dragId": self.id, "pointer": pointer, "token": self.token, "destinationId": path_to_id(dest)});
            self.call("drag_hover", args)
        }
        /// Performs the drop; returns (accepted, drop event).
        fn perform(&self, mask: usize) -> (bool, Option<Value>) {
            let before = self.mark();
            let accepted = send(self.app, self.board, mask, "perform") != 0;
            std::thread::sleep(Duration::from_millis(200));
            (accepted, self.find("drop", before))
        }
        fn claim(&mut self, task: &str, token: u64, dest: &Path) -> Result<Value, Value> {
            let args = json!({"taskId": task, "dragId": self.id, "token": token, "destinationId": path_to_id(dest)});
            self.call("drag_drop_transfer", args)
        }
    }

    fn start<'a>(
        app: &'a AppHandle<Wry>,
        window: &'a WebviewWindow<Wry>,
        events: &'a Events,
        ipc: &'a mut u32,
        paths: Vec<std::path::PathBuf>,
        mask: usize,
    ) -> (Drag<'a>, isize) {
        let board = pasteboard_of(app, paths);
        let before = events.lock().unwrap().len();
        let entered = send(app, board, mask, "enter");
        std::thread::sleep(Duration::from_millis(250));
        let id = events.lock().unwrap()[before..]
            .iter()
            .find(|e| e["type"] == "enter")
            .map(|e| e["dragId"].as_str().unwrap().to_string())
            .unwrap_or_default();
        (
            Drag {
                app,
                window,
                events,
                board,
                id,
                ipc,
                token: 0,
            },
            entered,
        )
    }

    fn wait_finished(events: &Events, task: &str) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let found = events
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["type"] == "finished" && e["taskId"] == task)
                .cloned();
            if found.is_some() {
                return found;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    fn scenario(app: AppHandle<Wry>, window: WebviewWindow<Wry>, events: Events) -> bool {
        let mut report = Report(Vec::new());
        let mut ipc = 0u32;
        let fixture = Fixture::create_in(&std::env::temp_dir(), "mfm-drag-accept").unwrap();
        let root = fixture.path().to_path_buf();
        let name = OsStr::new("caf\u{e9} \u{65e5}\u{672c} #%.txt");
        let (a, b) = (root.join("A"), root.join("B"));
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let src = root.join("src");
        fs::create_dir(&src).unwrap();
        let odd = src.join(name);
        let plain = src.join("plain.txt");
        let reset = || {
            fs::write(&odd, "odd contents\n").unwrap();
            fs::write(&plain, "plain contents\n").unwrap();
        };

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

        // 1. Same-volume drop with both operations offered (no modifier) moves.
        reset();
        let (mut d, entered) = start(
            &app,
            &window,
            &events,
            &mut ipc,
            vec![odd.clone(), plain.clone()],
            1 | 16,
        );
        report.check(
            "entering claims the drag and answers NSDragOperationNone",
            entered == 0 && !d.id.is_empty(),
            entered,
        );
        let (cursor, pointer) = d.update(1 | 16);
        report.check("before a verdict the cursor is none", cursor == 0, cursor);
        let hover = d.hover(pointer, &a);
        report.check(
            "hover validates dest A as a move",
            hover.as_ref().is_ok_and(|h| h["operation"] == "move"),
            &hover,
        );
        let (cursor, pointer) = d.update(1 | 16);
        let again = d.hover(pointer, &a);
        report.check(
            "the re-validated pointer update answers the move cursor",
            again.is_ok(),
            &again,
        );
        let (accepted, drop) = d.perform(1 | 16);
        let token = drop.as_ref().and_then(|e| e["token"].as_u64()).unwrap_or(0);
        report.check(
            "perform is accepted as a move for the settled target",
            accepted && drop.as_ref().is_some_and(|e| e["operation"] == "move") && token == d.token,
            (&drop, cursor),
        );
        let wrong = d.claim("t-wrong", token, &b);
        report.check(
            "a claim naming another destination is refused",
            wrong.is_err(),
            &wrong,
        );
        let reuse = d.claim("t-reuse", token, &a);
        report.check(
            "that failed claim consumed the drop",
            reuse.is_err(),
            &reuse,
        );
        drop_drag(&app, &d);
        reset();
        let src_files = (odd.exists(), plain.exists());
        report.check(
            "nothing moved by the refused claims",
            src_files == (true, true),
            src_files,
        );

        // 2. A real move through the transfer service, then bytes and source state.
        let (mut d, _) = start(
            &app,
            &window,
            &events,
            &mut ipc,
            vec![odd.clone(), plain.clone()],
            1 | 16,
        );
        let (_, p) = d.update(1 | 16);
        let _ = d.hover(p, &a);
        let (cursor, p) = d.update(1 | 16);
        let hover = d.hover(p, &a);
        let (accepted, drop) = d.perform(1 | 16);
        let token = drop.as_ref().and_then(|e| e["token"].as_u64()).unwrap_or(0);
        let started = d.claim("t-move", token, &a);
        report.check(
            "move drop is accepted and claimed",
            accepted && started.is_ok(),
            (&hover, cursor, &started),
        );
        let done = wait_finished(&events, "t-move");
        report.check(
            "move task finished without failures",
            done.as_ref()
                .is_some_and(|e| e["failed"].as_array().is_some_and(|f| f.is_empty())),
            &done,
        );
        report.check(
            "move: bytes equal at the destination (non-ASCII name)",
            fs::read(a.join(name)).ok() == Some(b"odd contents\n".to_vec())
                && fs::read(a.join("plain.txt")).ok() == Some(b"plain contents\n".to_vec()),
            "",
        );
        report.check(
            "move: the sources are gone",
            !odd.exists() && !plain.exists(),
            "",
        );

        // 3. Option held (copy-only mask) copies and keeps the sources.
        reset();
        let (mut d, _) = start(
            &app,
            &window,
            &events,
            &mut ipc,
            vec![odd.clone(), plain.clone()],
            1,
        );
        let (_, p) = d.update(1);
        let _ = d.hover(p, &b);
        let (cursor, p) = d.update(1);
        let hover = d.hover(p, &b);
        let (accepted, drop) = d.perform(1);
        let token = drop.as_ref().and_then(|e| e["token"].as_u64()).unwrap_or(0);
        report.check(
            "copy-only mask: cursor is copy and drop is a copy",
            cursor == COPY && accepted && drop.as_ref().is_some_and(|e| e["operation"] == "copy"),
            (&hover, cursor, &drop),
        );
        let started = d.claim("t-copy", token, &b);
        let done = wait_finished(&events, "t-copy");
        report.check(
            "copy task finished without failures",
            started.is_ok()
                && done
                    .as_ref()
                    .is_some_and(|e| e["failed"].as_array().is_some_and(|f| f.is_empty())),
            &done,
        );
        report.check(
            "copy: bytes equal and sources remain",
            fs::read(b.join(name)).ok() == Some(b"odd contents\n".to_vec())
                && fs::read(b.join("plain.txt")).ok() == Some(b"plain contents\n".to_vec())
                && odd.exists()
                && plain.exists(),
            "",
        );

        // 4. Modifier released after hover: the final mask decides, the verdict stays valid.
        reset();
        let c = root.join("C");
        fs::create_dir(&c).unwrap();
        let (mut d, _) = start(
            &app,
            &window,
            &events,
            &mut ipc,
            vec![plain.clone()],
            1 | 16,
        );
        let (_, p) = d.update(1 | 16);
        let _ = d.hover(p, &c);
        let (cursor_move, p) = d.update(1 | 16);
        let _ = d.hover(p, &c);
        let (cursor_copy, p) = d.update(1);
        let _ = d.hover(p, &c);
        report.check(
            "Option pressed mid-drag switches the cursor from move to copy",
            cursor_move == MOVE && cursor_copy == COPY,
            (cursor_move, cursor_copy),
        );
        let (accepted, drop) = d.perform(1);
        report.check(
            "the drop follows the final mask (copy)",
            accepted && drop.as_ref().is_some_and(|e| e["operation"] == "copy"),
            &drop,
        );
        drop_drag(&app, &d);

        // 5. A drop right after the pointer moved, before its target was re-validated, is refused.
        reset();
        let (mut d, _) = start(&app, &window, &events, &mut ipc, vec![plain.clone()], 1);
        let (_, p) = d.update(1);
        let _ = d.hover(p, &c);
        let _ = d.update(1); // pointer moved on; no verdict for this update yet
        let (accepted, drop) = d.perform(1);
        report.check(
            "a stale verdict is refused at drop time",
            !accepted && drop.as_ref().is_some_and(|e| e["accepted"] == false),
            (&drop, accepted),
        );

        // 6. Conflicts use the transfer service: skip keeps the destination, keep-both adds a copy.
        for (decision, task) in [("skip", "t-skip"), ("keepBoth", "t-keep")] {
            reset();
            let target = root.join(format!("conflict-{decision}"));
            fs::create_dir(&target).unwrap();
            fs::write(target.join("plain.txt"), "existing\n").unwrap();
            let (mut d, _) = start(&app, &window, &events, &mut ipc, vec![plain.clone()], 1);
            let (_, p) = d.update(1);
            let _ = d.hover(p, &target);
            let (_, p) = d.update(1);
            let _ = d.hover(p, &target);
            let (accepted, drop) = d.perform(1);
            let token = drop.as_ref().and_then(|e| e["token"].as_u64()).unwrap_or(0);
            let started = d.claim(task, token, &target);
            let conflict = wait_event(&events, |e| e["type"] == "conflict" && e["taskId"] == task);
            let answered = conflict.as_ref().map(|c| {
                d.call("resolve_conflict", json!({"conflictId": c["conflictId"], "decision": decision, "applyToAll": false}))
            });
            let done = wait_finished(&events, task);
            let existing = fs::read(target.join("plain.txt")).ok();
            let entries = fs::read_dir(&target).unwrap().count();
            let expect_entries = if decision == "skip" { 1 } else { 2 };
            report.check(
                &format!("conflict '{decision}': dialog event, destination untouched, {expect_entries} item(s)"),
                accepted && started.is_ok() && conflict.is_some() && answered.is_some_and(|r| r.is_ok()) && done.is_some()
                    && existing == Some(b"existing\n".to_vec())
                    && entries == expect_entries
                    && plain.exists(),
                (&conflict, entries),
            );
        }

        // 7. A text-only drag is left to WebKit.
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

        // 8. Outbound without a live mouse gesture must refuse rather than pretend.
        ipc += 1;
        let out = invoke(
            &window,
            ipc,
            "start_drag",
            json!({"ids": [path_to_id(&plain)]}),
        );
        report.check(
            "start_drag with no mouse-down event is refused (nothing dragged)",
            out.is_err(),
            &out,
        );

        fixture.cleanup().unwrap();
        report.0.iter().all(|ok| *ok)
    }

    fn drop_drag(app: &AppHandle<Wry>, d: &Drag<'_>) {
        let _ = send(app, d.board, 1, "exit");
    }

    fn wait_event(events: &Events, want: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(found) = events.lock().unwrap().iter().find(|e| want(e)).cloned() {
                return Some(found);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
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
        for name in ["drag-event", "task-event"] {
            let sink = Arc::clone(&sink);
            window.listen(name, move |event| {
                if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                    sink.lock().unwrap().push(value);
                }
            });
        }
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
