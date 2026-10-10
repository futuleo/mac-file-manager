//! Quick Look feasibility spike (not part of the shipped app).
//!
//! Run: `cargo run --manifest-path src-tauri/Cargo.toml --example quicklook_spike`
//!
//! Creates a tiny text file in an exclusively created `mfm-spike-ql-*` directory under the system temp dir, shows the shared
//! QLPreviewPanel for it using a Rust-defined data source, pumps the AppKit run
//! loop briefly and reports whether the panel became visible with the expected
//! item. The file is removed afterwards. This needs a GUI session.

#[cfg(target_os = "macos")]
mod spike {
    use mac_file_manager_lib::spike_fixture::Fixture;

    use objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::Retained,
        runtime::{NSObject, NSObjectProtocol, ProtocolObject},
    };
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    use objc2_foundation::{NSDate, NSInteger, NSRunLoop, NSString, NSURL};
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource};

    #[derive(Debug)]
    struct Ivars {
        url: Retained<NSURL>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MfmSpikeQuickLookSource"]
        #[ivars = Ivars]
        struct Source;

        unsafe impl NSObjectProtocol for Source {}

        unsafe impl QLPreviewPanelDataSource for Source {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn number_of_items(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                1
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn item_at(
                &self,
                _panel: Option<&QLPreviewPanel>,
                _index: NSInteger,
            ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                Some(ProtocolObject::from_retained(self.ivars().url.clone()))
            }
        }
    );

    pub fn main() {
        let mtm = MainThreadMarker::new().expect("main thread");
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);

        let base = std::env::temp_dir();
        let fixture = Fixture::create_in(&base, "mfm-spike-ql").expect("create fixture");
        let file = fixture.write("quicklook.txt", "Quick Look spike").unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(file.to_str().unwrap()));

        let source: Retained<Source> = unsafe {
            msg_send![
                super(Source::alloc(mtm).set_ivars(Ivars { url: url.clone() })),
                init
            ]
        };
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }.expect("panel");
        unsafe {
            let data_source = ProtocolObject::from_ref(&*source);
            panel.setDataSource(Some(data_source));
            panel.reloadData();
        }
        panel.makeKeyAndOrderFront(None);
        let until = NSDate::dateWithTimeIntervalSinceNow(3.0);
        NSRunLoop::currentRunLoop().runUntilDate(&until);

        let current = unsafe { panel.currentPreviewItem() }
            .and_then(|item| unsafe { item.previewItemURL() })
            .and_then(|u| u.path())
            .map(|p| p.to_string());
        println!("panel visible: {}", panel.isVisible());
        println!("current preview item: {current:?}");
        panel.orderOut(None);
        fixture.cleanup().expect("remove owned fixture");
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    spike::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macOS only");
}
