//! Native API feasibility spike (not part of the shipped app).
//!
//! Run: `cargo run --manifest-path src-tauri/Cargo.toml --example platform_spike`
//!
//! It only touches a uniquely named fixture directory under `$HOME`, named
//! `mfm-spike-<pid>-<nanos>-<n>` and created exclusively (removed at the end). It proves that, from Rust via objc2 bindings:
//!   1. NSMetadataQuery can be created, scoped, started, polled incrementally
//!      and stopped (Spotlight filename + content predicates).
//!   2. NSFileManager trashes an item and reports where it went (the item is then
//!      removed from the Trash again, because the spike created it).
//!   3. NSWorkspace returns a system icon.
//!   4. The NSDraggingSession class exists at runtime. Starting a drag needs a live
//!      NSView and mouse event, so it cannot be exercised headlessly; see README.
//!      Quick Look is exercised separately by the `quicklook_spike` example.

#[cfg(target_os = "macos")]
mod spike {
    use std::{fs, path::PathBuf, process::Command, time::Duration};

    use mac_file_manager_lib::spike_fixture::Fixture;

    use objc2::{
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    };
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{
        NSArray, NSDate, NSFileManager, NSMetadataItem, NSMetadataQuery, NSPredicate, NSRunLoop,
        NSString, NSURL,
    };

    fn run_loop_for(seconds: f64) {
        let date = NSDate::dateWithTimeIntervalSinceNow(seconds);
        NSRunLoop::currentRunLoop().runUntilDate(&date);
    }

    fn objects(strings: &[&str]) -> Retained<NSArray<AnyObject>> {
        let items: Vec<Retained<AnyObject>> = strings
            .iter()
            .map(|s| Retained::into_super(Retained::into_super(NSString::from_str(s))))
            .collect();
        NSArray::from_retained_slice(&items)
    }

    /// Runs a query until it stops gathering with results, or the timeout elapses.
    /// Returns (paths, saw_results_while_still_gathering, timed_out).
    fn query(
        scope: &str,
        format: &str,
        term: &str,
        timeout: Duration,
    ) -> (Vec<String>, bool, bool) {
        let query = NSMetadataQuery::new();
        let predicate = unsafe {
            NSPredicate::predicateWithFormat_argumentArray(
                &NSString::from_str(format),
                Some(&objects(&[term])),
            )
        };
        query.setPredicate(Some(&predicate));
        unsafe { query.setSearchScopes(&objects(&[scope])) };
        query.setNotificationBatchingInterval(0.1);
        assert!(query.startQuery(), "startQuery failed");

        let deadline = std::time::Instant::now() + timeout;
        let (mut incremental, mut timed_out) = (false, false);
        loop {
            run_loop_for(0.1);
            if query.resultCount() > 0 && query.isGathering() {
                incremental = true;
            }
            if !query.isGathering() && query.resultCount() > 0 {
                break;
            }
            if std::time::Instant::now() > deadline {
                timed_out = true;
                break;
            }
        }
        query.disableUpdates();
        let mut paths = Vec::new();
        for i in 0..query.resultCount() {
            if let Ok(item) = query.resultAtIndex(i).downcast::<NSMetadataItem>() {
                let key = NSString::from_str("kMDItemPath");
                if let Some(Ok(path)) = item
                    .valueForAttribute(&key)
                    .map(|v| v.downcast::<NSString>())
                {
                    paths.push(path.to_string());
                }
            }
        }
        query.stopQuery();
        assert!(query.isStopped(), "stopQuery did not stop the query");
        (paths, incremental, timed_out)
    }

    pub fn main() {
        let pid = std::process::id();
        let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
        // Exclusively created per-run directory (visible under $HOME so Spotlight indexes it).
        let owned = Fixture::create_in(&home, "mfm-spike").expect("create fixture");
        let fixture = owned.path().to_path_buf();
        let needle = format!("needle{pid}");
        owned.write(&format!("{needle}-name.txt"), "plain").unwrap();
        owned
            .write("content.txt", &format!("body {needle}content here"))
            .unwrap();

        let status = Command::new("mdutil")
            .args(["-s", fixture.to_str().unwrap()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        println!("mdutil -s: {status:?}");

        // Already-indexed files prove the query mechanics independently of indexing latency.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let repo = repo.canonicalize().unwrap();
        for (label, format, term) in [
            (
                "indexed filename",
                "kMDItemFSName CONTAINS[cd] %@",
                "plan.md",
            ),
            (
                "indexed content ",
                "kMDItemTextContent CONTAINS[cd] %@",
                "Windows-10-style macOS file manager",
            ),
        ] {
            let (paths, incremental, timed_out) = query(
                repo.to_str().unwrap(),
                format,
                term,
                Duration::from_secs(20),
            );
            println!(
                "NSMetadataQuery {label}: results={} first={:?} results_while_gathering={incremental} timed_out={timed_out}",
                paths.len(),
                paths.first()
            );
        }

        // Brand-new files depend on mds indexing latency; report, do not assert.
        let scope = fixture.to_str().unwrap();
        for (label, format) in [
            ("new filename", "kMDItemFSName CONTAINS[cd] %@"),
            ("new content ", "kMDItemTextContent CONTAINS[cd] %@"),
        ] {
            let (paths, incremental, timed_out) =
                query(scope, format, &needle, Duration::from_secs(45));
            println!(
                "NSMetadataQuery {label}: results={} results_while_gathering={incremental} timed_out={timed_out}",
                paths.len()
            );
        }

        let victim = owned.write("to-trash.txt", "x").unwrap();
        let url = NSURL::fileURLWithPath(&NSString::from_str(victim.to_str().unwrap()));
        let mut result: Option<Retained<NSURL>> = None;
        let trashed = NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut result));
        match (trashed, result) {
            (Ok(()), Some(res)) => {
                let p = res.path().map(|p| p.to_string()).unwrap_or_default();
                println!(
                    "trashItemAtURL ok; now at {p}; source exists={}",
                    victim.exists()
                );
                fs::remove_file(&p).expect("remove the spike's own file from the Trash");
            }
            (r, _) => println!("trashItemAtURL result: {r:?}"),
        }

        let icon = NSWorkspace::sharedWorkspace()
            .iconForFile(&NSString::from_str(fixture.to_str().unwrap()));
        println!("NSWorkspace icon size: {:?}", icon.size());

        println!(
            "NSDraggingSession class registered: {}",
            AnyClass::get(c"NSDraggingSession").is_some()
        );
        owned.cleanup().expect("remove owned fixture");
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    spike::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("macOS only");
}
