//! Search sessions: request validation, the registry of running searches and the
//! worker that turns raw Spotlight paths into `SearchEvent`s.
//!
//! The native `NSMetadataQuery` lives on the main thread (`spotlight.rs`) and only
//! forwards paths through a `Feed`. Everything that can block (stat calls, scope
//! checks) happens on the session's own worker thread, one ordered stream per
//! search. A search is closed exactly once; after that no event is emitted, so a
//! late native notification can never reach a newer search or tab.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::Duration,
};

use crate::{
    contracts::{
        AppError, ErrorCategory, SearchEvent, SearchMode, SearchState, display_name, path_to_id,
    },
    filesystem,
};

pub const MAX_QUERY_CHARS: usize = 256;
/// Most distinct matches delivered to the UI; beyond it the query is stopped.
pub const MAX_RESULTS: usize = 10_000;
pub const MAX_CONCURRENT_SEARCHES: usize = 16;
const MAX_ID_LEN: usize = 128;
const POLL: Duration = Duration::from_millis(200);
const OPERATION: &str = "search";

/// Fixed predicate formats. The user's text is only ever bound as the `%@`
/// argument of `predicateWithFormat:argumentArray:`; it is never concatenated
/// into a format string or passed to a shell.
pub fn predicate_format(mode: SearchMode) -> &'static str {
    match mode {
        SearchMode::Filename => "kMDItemFSName CONTAINS[cd] %@",
        SearchMode::Content => "kMDItemTextContent CONTAINS[cd] %@",
    }
}

/// Trims the query and rejects empty, oversized or control-character text.
pub fn normalize_query(query: &str) -> Result<String, AppError> {
    let invalid = |m: &str| AppError::new(ErrorCategory::InvalidInput, OPERATION, None, m);
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(invalid("Type something to search for."));
    }
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(invalid(&format!(
            "The search text is too long (at most {MAX_QUERY_CHARS} characters)."
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(invalid("The search text contains control characters."));
    }
    Ok(trimmed.to_string())
}

/// Verifies that the scope is a readable folder, so a missing or protected
/// folder is an error instead of an empty search. Returns the canonical path,
/// which is what Spotlight reports (e.g. `/private/var` for `/var`).
pub fn check_scope(path: &Path) -> Result<PathBuf, AppError> {
    let fail = |e: &std::io::Error| AppError::from_io("search the folder", path, e);
    let meta = std::fs::metadata(path).map_err(|e| fail(&e))?;
    if !meta.is_dir() {
        let name = display_name(path);
        return Err(AppError::new(
            ErrorCategory::InvalidInput,
            "search the folder",
            Some(name.clone()),
            format!("\"{name}\" is not a folder, so it cannot be searched."),
        ));
    }
    std::fs::read_dir(path).map_err(|e| fail(&e))?;
    std::fs::canonicalize(path).map_err(|e| fail(&e))
}

/// What the native side reports; processed in order by the worker.
pub enum Msg {
    Paths(Vec<PathBuf>),
    Removed(Vec<PathBuf>),
    State(SearchState),
    Failed(AppError),
}

/// The native query's handle for reporting. Cheap to clone; never blocks.
#[derive(Clone)]
pub struct Feed {
    tx: Sender<Msg>,
    stop: Arc<AtomicBool>,
}

impl Feed {
    pub fn paths(&self, paths: Vec<PathBuf>) {
        if !paths.is_empty() {
            let _ = self.tx.send(Msg::Paths(paths));
        }
    }
    pub fn removed(&self, paths: Vec<PathBuf>) {
        if !paths.is_empty() {
            let _ = self.tx.send(Msg::Removed(paths));
        }
    }
    pub fn state(&self, state: SearchState) {
        let _ = self.tx.send(Msg::State(state));
    }
    pub fn failed(&self, error: AppError) {
        let _ = self.tx.send(Msg::Failed(error));
    }
    /// True once the search was cancelled or hit its result limit: the native
    /// query should stop and release itself.
    pub fn should_stop(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
}

type Sink = Box<dyn Fn(SearchEvent) + Send + Sync>;

pub struct Session {
    id: String,
    scope: PathBuf,
    limit: usize,
    /// Serializes emission with closing, so nothing is emitted after `close`.
    emit_lock: Mutex<()>,
    closed: AtomicBool,
    stop: Arc<AtomicBool>,
    sink: Sink,
    tx: Mutex<Option<Sender<Msg>>>,
}

impl Session {
    /// `scope` must be the canonical folder (see `check_scope`).
    pub fn spawn(
        id: &str,
        scope: PathBuf,
        limit: usize,
        sink: impl Fn(SearchEvent) + Send + Sync + 'static,
    ) -> (Arc<Session>, Feed) {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Session {
            id: id.to_string(),
            scope,
            limit,
            emit_lock: Mutex::new(()),
            closed: AtomicBool::new(false),
            stop: stop.clone(),
            sink: Box::new(sink),
            tx: Mutex::new(Some(tx.clone())),
        });
        let worker = session.clone();
        std::thread::spawn(move || worker.run(rx));
        (session, Feed { tx, stop })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn emit(&self, event: SearchEvent) {
        let _guard = self.emit_lock.lock().unwrap_or_else(|e| e.into_inner());
        if !self.is_closed() {
            (self.sink)(event);
        }
    }

    /// Ends the search for good. Idempotent. With `announce` the caller learns
    /// of the cancellation through one final `Cancelled` state event.
    pub fn close(&self, announce: bool) {
        let _guard = self.emit_lock.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stop.store(true, Ordering::Release);
        self.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
        if announce {
            (self.sink)(SearchEvent::State {
                search_id: self.id.clone(),
                state: SearchState::Cancelled,
            });
        }
    }

    /// Reports a failure and closes the search (the failure is terminal).
    pub fn fail(&self, error: AppError) {
        self.emit(SearchEvent::Failed {
            search_id: self.id.clone(),
            error,
        });
        self.close(false);
    }

    fn in_scope(&self, path: &Path) -> bool {
        path != self.scope && path.starts_with(&self.scope)
    }

    fn run(&self, rx: mpsc::Receiver<Msg>) {
        let mut delivered: HashSet<String> = HashSet::new();
        let mut limited = false;
        loop {
            if self.is_closed() {
                return;
            }
            let msg = match rx.recv_timeout(POLL) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            match msg {
                Msg::Paths(paths) => {
                    if !limited {
                        limited = self.deliver(paths, &mut delivered);
                    }
                }
                Msg::Removed(paths) => self.remove(paths, &mut delivered),
                Msg::State(state) => {
                    // Spotlight cannot say the folder vanished; check when it settles.
                    if state == SearchState::Live {
                        if let Err(error) = check_scope(&self.scope) {
                            self.fail(error);
                            return;
                        }
                    }
                    self.emit(SearchEvent::State {
                        search_id: self.id.clone(),
                        state,
                    });
                }
                Msg::Failed(error) => {
                    self.fail(error);
                    return;
                }
            }
        }
    }

    /// Returns true when the result limit was reached.
    fn deliver(&self, paths: Vec<PathBuf>, delivered: &mut HashSet<String>) -> bool {
        let mut entries = Vec::new();
        let mut skipped = 0;
        let mut limited = false;
        for path in paths {
            if self.is_closed() {
                return false;
            }
            if !self.in_scope(&path) {
                continue;
            }
            match filesystem::entry_for_path(&path) {
                Ok(entry) => {
                    if delivered.len() >= self.limit && !delivered.contains(&entry.id) {
                        limited = true;
                        break;
                    }
                    delivered.insert(entry.id.clone());
                    entries.push(entry);
                }
                Err(_) => skipped += 1,
            }
        }
        if !entries.is_empty() || skipped > 0 {
            self.emit(SearchEvent::Results {
                search_id: self.id.clone(),
                entries,
                skipped,
            });
        }
        if limited {
            self.stop.store(true, Ordering::Release);
            self.emit(SearchEvent::Limited {
                search_id: self.id.clone(),
                limit: self.limit as u64,
            });
        }
        limited
    }

    fn remove(&self, paths: Vec<PathBuf>, delivered: &mut HashSet<String>) {
        let ids: Vec<String> = paths
            .iter()
            .filter(|p| self.in_scope(p))
            .map(|p| path_to_id(p))
            .filter(|id| delivered.remove(id))
            .collect();
        if !ids.is_empty() {
            self.emit(SearchEvent::Removed {
                search_id: self.id.clone(),
                ids,
            });
        }
    }
}

/// Running searches by the caller's id.
#[derive(Default)]
pub struct Searches(Mutex<HashMap<String, Arc<Session>>>);

impl Searches {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Session>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Validates the id and capacity, then registers the session `make` builds.
    pub fn register(
        &self,
        search_id: &str,
        make: impl FnOnce() -> (Arc<Session>, Feed),
    ) -> Result<(Arc<Session>, Feed), AppError> {
        let invalid = |m: &str| AppError::new(ErrorCategory::InvalidInput, OPERATION, None, m);
        if search_id.is_empty() || search_id.len() > MAX_ID_LEN {
            return Err(invalid("The search identifier is invalid."));
        }
        let mut searches = self.lock();
        if searches.contains_key(search_id) {
            return Err(invalid("A search with this identifier is already running."));
        }
        if searches.len() >= MAX_CONCURRENT_SEARCHES {
            return Err(invalid("Too many searches are running. Clear one first."));
        }
        let (session, feed) = make();
        searches.insert(search_id.to_string(), session.clone());
        Ok((session, feed))
    }

    /// Removes and returns a search; unknown ids are not an error (idempotent cancel).
    pub fn take(&self, search_id: &str) -> Option<Arc<Session>> {
        self.lock().remove(search_id)
    }

    pub fn take_all(&self) -> Vec<(String, Arc<Session>)> {
        self.lock().drain().collect()
    }

    /// Drops registrations of searches that ended on their own (failure).
    pub fn prune_closed(&self) {
        self.lock().retain(|_, s| !s.is_closed());
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spike_fixture::Fixture;
    use std::time::Instant;

    type Events = Arc<Mutex<Vec<SearchEvent>>>;

    fn session(scope: &Path, limit: usize) -> (Arc<Session>, Feed, Events) {
        let events: Events = Arc::default();
        let sink = events.clone();
        let (session, feed) = Session::spawn("s1", scope.to_path_buf(), limit, move |e| {
            sink.lock().unwrap().push(e)
        });
        (session, feed, events)
    }

    fn wait(events: &Events, done: impl Fn(&[SearchEvent]) -> bool) -> Vec<SearchEvent> {
        let start = Instant::now();
        loop {
            let snapshot = events.lock().unwrap().clone();
            if done(&snapshot) {
                return snapshot;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "{snapshot:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn scope_of(fx: &Fixture) -> PathBuf {
        check_scope(fx.path()).unwrap()
    }

    #[test]
    fn query_is_trimmed_and_validated() {
        assert_eq!(normalize_query("  hello world \n").unwrap(), "hello world");
        for bad in [
            "",
            "   ",
            "a\u{0}b",
            "a\tb",
            &"x".repeat(MAX_QUERY_CHARS + 1),
        ] {
            assert_eq!(
                normalize_query(bad).unwrap_err().category,
                ErrorCategory::InvalidInput,
                "{bad:?}"
            );
        }
        // Predicate-looking text is ordinary text; it is bound, not interpreted.
        assert!(normalize_query("x\" OR TRUEPREDICATE OR \"y").is_ok());
        assert_eq!(
            normalize_query(&"é".repeat(MAX_QUERY_CHARS))
                .unwrap()
                .chars()
                .count(),
            MAX_QUERY_CHARS
        );
    }

    #[test]
    fn formats_have_exactly_one_bound_argument_and_no_user_text() {
        for mode in [SearchMode::Filename, SearchMode::Content] {
            let format = predicate_format(mode);
            assert_eq!(format.matches("%@").count(), 1);
            assert!(format.ends_with("CONTAINS[cd] %@"));
        }
        assert!(predicate_format(SearchMode::Filename).starts_with("kMDItemFSName"));
        assert!(predicate_format(SearchMode::Content).starts_with("kMDItemTextContent"));
    }

    #[test]
    fn scope_errors_are_reported_not_treated_as_empty() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-search-scope").unwrap();
        let file = fx.write("a.txt", "x").unwrap();
        assert_eq!(
            check_scope(&fx.path().join("missing"))
                .unwrap_err()
                .category,
            ErrorCategory::NotFound
        );
        assert_eq!(
            check_scope(&file).unwrap_err().category,
            ErrorCategory::InvalidInput
        );
        let locked = fx.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = check_scope(&locked);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Skipped for privileged users, who can read anything.
        if let Err(error) = denied {
            assert_eq!(error.category, ErrorCategory::PermissionDenied);
        }
        assert!(check_scope(fx.path()).unwrap().is_absolute());
        fx.cleanup().unwrap();
    }

    #[test]
    fn results_are_scoped_deduplicated_and_stale_items_counted() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-search-pipe").unwrap();
        let inside = fx.write("inside.txt", "hello").unwrap();
        let outside = Fixture::create_in(&std::env::temp_dir(), "mfm-search-out").unwrap();
        let elsewhere = outside.write("elsewhere.txt", "x").unwrap();
        let scope = scope_of(&fx);
        let (session, feed, events) = session(&scope, MAX_RESULTS);
        let inside = scope.join(inside.file_name().unwrap());

        feed.state(SearchState::Gathering);
        feed.paths(vec![
            inside.clone(),
            inside.clone(),
            scope.clone(),
            elsewhere,
            scope.join("gone.txt"),
        ]);
        feed.state(SearchState::Live);
        let seen = wait(&events, |e| {
            e.iter().any(|x| {
                matches!(
                    x,
                    SearchEvent::State {
                        state: SearchState::Live,
                        ..
                    }
                )
            })
        });
        let entries: Vec<_> = seen
            .iter()
            .flat_map(|e| match e {
                SearchEvent::Results { entries, .. } => entries.clone(),
                _ => vec![],
            })
            .collect();
        assert_eq!(
            entries.len(),
            2,
            "duplicates are upserts of the same id: {seen:?}"
        );
        assert!(entries.iter().all(|e| e.id == path_to_id(&inside)));
        let skipped: u64 = seen
            .iter()
            .map(|e| match e {
                SearchEvent::Results { skipped, .. } => *skipped,
                _ => 0,
            })
            .sum();
        assert_eq!(skipped, 1);
        assert!(matches!(
            seen[0],
            SearchEvent::State {
                state: SearchState::Gathering,
                ..
            }
        ));

        feed.removed(vec![inside.clone(), scope.join("never-delivered")]);
        let seen = wait(&events, |e| {
            e.iter().any(|x| matches!(x, SearchEvent::Removed { .. }))
        });
        let removed = seen.iter().find_map(|e| match e {
            SearchEvent::Removed { ids, .. } => Some(ids.clone()),
            _ => None,
        });
        assert_eq!(removed, Some(vec![path_to_id(&inside)]));
        session.close(true);
        fx.cleanup().unwrap();
        outside.cleanup().unwrap();
    }

    #[test]
    fn cancel_announces_once_and_silences_late_events() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-search-cancel").unwrap();
        let file = fx.write("late.txt", "x").unwrap();
        let scope = scope_of(&fx);
        let (session, feed, events) = session(&scope, MAX_RESULTS);
        assert!(!feed.should_stop());
        session.close(true);
        session.close(true);
        assert!(session.is_closed());
        assert!(feed.should_stop());
        feed.paths(vec![scope.join(file.file_name().unwrap())]);
        feed.state(SearchState::Live);
        feed.failed(AppError::new(ErrorCategory::Io, "search", None, "late"));
        session.fail(AppError::new(ErrorCategory::Io, "search", None, "late"));
        std::thread::sleep(Duration::from_millis(400));
        let seen = events.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![SearchEvent::State {
                search_id: "s1".into(),
                state: SearchState::Cancelled
            }]
        );
        fx.cleanup().unwrap();
    }

    #[test]
    fn result_limit_stops_delivery_and_is_reported() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-search-limit").unwrap();
        let scope = scope_of(&fx);
        let paths: Vec<PathBuf> = (0..5)
            .map(|i| {
                scope.join(
                    fx.write(&format!("f{i}.txt"), "x")
                        .unwrap()
                        .file_name()
                        .unwrap(),
                )
            })
            .collect();
        let (session, feed, events) = session(&scope, 3);
        feed.paths(paths.clone());
        let seen = wait(&events, |e| {
            e.iter().any(|x| matches!(x, SearchEvent::Limited { .. }))
        });
        let count: usize = seen
            .iter()
            .map(|e| match e {
                SearchEvent::Results { entries, .. } => entries.len(),
                _ => 0,
            })
            .sum();
        assert_eq!(count, 3);
        assert!(feed.should_stop());
        feed.paths(paths);
        std::thread::sleep(Duration::from_millis(300));
        let after = events.lock().unwrap().len();
        assert_eq!(after, seen.len(), "nothing is delivered after the limit");
        session.close(false);
        fx.cleanup().unwrap();
    }

    #[test]
    fn native_failure_is_terminal_and_a_vanished_scope_is_an_error() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-search-fail").unwrap();
        let scope = scope_of(&fx);
        let (_session, feed, events) = session(&scope, MAX_RESULTS);
        feed.failed(AppError::new(ErrorCategory::Io, "search", None, "boom"));
        let seen = wait(&events, |e| !e.is_empty());
        assert!(matches!(&seen[0], SearchEvent::Failed { error, .. } if error.message == "boom"));
        feed.state(SearchState::Live);

        let (_session, feed, events) = session(&scope, MAX_RESULTS);
        fx.cleanup().unwrap();
        feed.state(SearchState::Live);
        let seen = wait(&events, |e| !e.is_empty());
        assert!(
            matches!(&seen[0], SearchEvent::Failed { error, .. } if error.category == ErrorCategory::NotFound)
        );
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[test]
    fn registry_rejects_duplicates_invalid_ids_and_overflow() {
        let searches = Searches::default();
        let make = |id: &str| {
            let id = id.to_string();
            move || Session::spawn(&id, PathBuf::from("/"), 1, |_| {})
        };
        let first = searches.register("a", make("a")).unwrap().0;
        assert!(searches.register("a", make("a")).is_err());
        assert!(searches.register("", make("")).is_err());
        let long = "x".repeat(200);
        assert!(searches.register(&long, make(&long)).is_err());
        for i in 1..MAX_CONCURRENT_SEARCHES {
            searches.register(&format!("s{i}"), make("s")).unwrap();
        }
        assert!(searches.register("overflow", make("o")).is_err());
        assert_eq!(searches.len(), MAX_CONCURRENT_SEARCHES);
        first.close(false);
        searches.prune_closed();
        assert!(searches.register("again", make("again")).is_ok());
        assert!(searches.take("missing").is_none());
        for (_, s) in searches.take_all() {
            s.close(false);
        }
        assert!(searches.is_empty());
    }
}
