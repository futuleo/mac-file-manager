//! Real-Spotlight check of the production search service (not a mock).
//!
//! Creates an exclusively owned, non-dot fixture under `$HOME` containing one file with a
//! unique NAME token and one with a unique CONTENT token, then runs the real
//! `spotlight::start` on the main thread for a name query, a content query and a cancelled
//! query. It queries only that fixture's unique tokens, never changes Spotlight/mdutil
//! settings, and removes the fixture afterwards. Spotlight indexes new files with a delay and
//! offers no completeness signal, so a missing result is reported as "not observed", never as
//! proof of absence. Run: `cargo run --example spotlight_check` (macOS only).

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("spotlight_check runs on macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    use std::{
        collections::BTreeSet,
        path::PathBuf,
        sync::{Arc, Mutex, mpsc},
        time::{Duration, Instant},
    };

    use mac_file_manager_lib::{
        contracts::{SearchEvent, SearchMode, SearchState},
        search::Session,
        spike_fixture::Fixture,
        spotlight,
    };
    use objc2_foundation::{NSDate, NSRunLoop};

    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let fixture = Fixture::create_in(&home, "mfm-spotlight-check").expect("create fixture");
    let token = fixture
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace('-', "")
        .to_lowercase();
    let name_token = format!("{token}nametoken");
    let content_token = format!("{token}contenttoken");
    fixture
        .write(&format!("{name_token}.txt"), "plain body\n")
        .unwrap();
    fixture
        .write("body.txt", &format!("hello {content_token} world\n"))
        .unwrap();
    println!("fixture: {} (owned, non-dot)", fixture.path().display());

    // Work scheduled by the service runs on this (main) thread between run-loop turns.
    let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
    let tx = Mutex::new(tx);
    let schedule: spotlight::Schedule = Arc::new(move |work| {
        let _ = tx.lock().unwrap().send(work);
    });
    let pump = |seconds: f64| {
        let date = NSDate::dateWithTimeIntervalSinceNow(seconds);
        NSRunLoop::currentRunLoop().runUntilDate(&date);
        while let Ok(work) = rx.try_recv() {
            work();
        }
    };

    type Log = Arc<Mutex<Vec<(Duration, SearchEvent)>>>;
    let run =
        |id: &str, mode: SearchMode, query: &str, timeout: Duration, want: &str| -> (bool, Log) {
            let log: Log = Arc::default();
            let begun = Instant::now();
            let sink = log.clone();
            let (session, feed) =
                Session::spawn(id, fixture.path().to_path_buf(), 1000, move |e| {
                    sink.lock().unwrap().push((begun.elapsed(), e));
                });
            spotlight::start(id, fixture.path(), mode, query, feed, schedule.clone())
                .expect("start");
            let found = |log: &Log| {
                log.lock().unwrap().iter().any(|(_, e)| match e {
                    SearchEvent::Results { entries, .. } => entries.iter().any(|f| f.name == want),
                    _ => false,
                })
            };
            while begun.elapsed() < timeout && !found(&log) {
                pump(0.25);
            }
            let observed = found(&log);
            session.close(true);
            spotlight::stop(id);
            pump(0.2);
            (observed, log)
        };
    let report = |label: &str, observed: bool, log: &Log| {
        let log = log.lock().unwrap();
        let names: BTreeSet<String> = log
            .iter()
            .filter_map(|(_, e)| match e {
                SearchEvent::Results { entries, .. } => {
                    Some(entries.iter().map(|f| f.name.clone()))
                }
                _ => None,
            })
            .flatten()
            .collect();
        let live = log
            .iter()
            .find(|(_, e)| {
                matches!(
                    e,
                    SearchEvent::State {
                        state: SearchState::Live,
                        ..
                    }
                )
            })
            .map(|(t, _)| *t);
        let first = log
            .iter()
            .find(|(_, e)| matches!(e, SearchEvent::Results { .. }))
            .map(|(t, _)| *t);
        println!(
            "{label}: {} | results batches={} first_result={first:?} live_at={live:?} names={names:?}",
            if observed {
                "OBSERVED"
            } else {
                "NOT OBSERVED within timeout (indexing delay or not indexed)"
            },
            log.iter()
                .filter(|(_, e)| matches!(e, SearchEvent::Results { .. }))
                .count(),
        );
    };

    let timeout = Duration::from_secs(120);
    let (ok, log) = run(
        "check-name",
        SearchMode::Filename,
        &name_token,
        timeout,
        &format!("{name_token}.txt"),
    );
    report("filename search", ok, &log);
    let (ok2, log) = run(
        "check-content",
        SearchMode::Content,
        &content_token,
        timeout,
        "body.txt",
    );
    report("content search", ok2, &log);

    // Cancellation: start, stop immediately, and verify silence plus a released native query.
    let log: Log = Arc::default();
    let sink = log.clone();
    let begun = Instant::now();
    let (session, feed) = Session::spawn(
        "check-cancel",
        fixture.path().to_path_buf(),
        1000,
        move |e| {
            sink.lock().unwrap().push((begun.elapsed(), e));
        },
    );
    spotlight::start(
        "check-cancel",
        fixture.path(),
        SearchMode::Filename,
        &name_token,
        feed,
        schedule.clone(),
    )
    .expect("start");
    session.close(true);
    spotlight::stop("check-cancel");
    pump(1.0);
    let events = log.lock().unwrap().len();
    println!(
        "cancellation: native query released={} events_after_cancel={} (a single cancelled state is expected)",
        !spotlight::is_running("check-cancel"),
        events
    );
    let code = if ok && ok2 { 0 } else { 2 };
    drop(fixture); // removes the fixture
    std::process::exit(code);
}
