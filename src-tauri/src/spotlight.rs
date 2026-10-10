//! Native Spotlight bridge: one `NSMetadataQuery` per search, driven by the main
//! thread's run loop. Everything here is main-thread only (`MainThreadMarker`),
//! keeps no state outside a thread-local registry, and does no filesystem work:
//! it forwards raw paths to the search worker (`search::Feed`).
//!
//! The query text is bound with `predicateWithFormat:argumentArray:` against a
//! fixed format string (see `search::predicate_format`).

use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    rc::Rc,
};

use dispatch2::DispatchQueue;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, NSObjectProtocol},
    sel,
};
use objc2_foundation::{
    NSArray, NSMetadataItem, NSMetadataQuery, NSMetadataQueryDidFinishGatheringNotification,
    NSMetadataQueryDidStartGatheringNotification, NSMetadataQueryDidUpdateNotification,
    NSMetadataQueryGatheringProgressNotification, NSMetadataQueryUpdateAddedItemsKey,
    NSMetadataQueryUpdateChangedItemsKey, NSMetadataQueryUpdateRemovedItemsKey, NSNotification,
    NSNotificationCenter, NSPredicate, NSString, NSURL,
};

use crate::{
    contracts::{AppError, ErrorCategory, SearchMode, SearchState},
    search::{Feed, predicate_format},
};

/// Results handled per main-thread pass; the remainder continues in a later pass
/// so a big result set never blocks the UI thread for long.
pub const BATCH: usize = 500;
/// Seconds Spotlight coalesces notifications, which paces incremental delivery.
const BATCHING_INTERVAL: f64 = 0.1;

#[derive(Debug)]
struct ObserverIvars {
    id: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MfmSpotlightObserver"]
    #[ivars = ObserverIvars]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    impl Observer {
        #[unsafe(method(didStart:))]
        fn did_start(&self, _n: &NSNotification) {
            on_event(&self.ivars().id, Event::Start, None);
        }

        #[unsafe(method(didProgress:))]
        fn did_progress(&self, _n: &NSNotification) {
            on_event(&self.ivars().id, Event::Progress, None);
        }

        #[unsafe(method(didFinish:))]
        fn did_finish(&self, _n: &NSNotification) {
            on_event(&self.ivars().id, Event::Finish, None);
        }

        #[unsafe(method(didUpdate:))]
        fn did_update(&self, n: &NSNotification) {
            on_event(&self.ivars().id, Event::Update, Some(n));
        }
    }
);

impl Observer {
    fn new(mtm: MainThreadMarker, id: String) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ObserverIvars { id });
        unsafe { msg_send![super(this), init] }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Event {
    Start,
    Progress,
    Finish,
    Update,
}

/// A numbered list of result paths (the query itself, or one update batch).
trait Listing {
    fn len(&self) -> usize;
    fn path(&self, index: usize) -> Option<PathBuf>;
}

/// The live query as the driver sees it.
trait Source: Listing {
    fn disable_updates(&self);
    fn enable_updates(&self);
}

/// Where results go (the search worker's `Feed`).
trait Out {
    fn paths(&self, paths: Vec<PathBuf>);
    fn removed(&self, paths: Vec<PathBuf>);
    fn state(&self, state: SearchState);
    fn should_stop(&self) -> bool;
}

impl Out for Feed {
    fn paths(&self, paths: Vec<PathBuf>) {
        Feed::paths(self, paths)
    }
    fn removed(&self, paths: Vec<PathBuf>) {
        Feed::removed(self, paths)
    }
    fn state(&self, state: SearchState) {
        Feed::state(self, state)
    }
    fn should_stop(&self) -> bool {
        Feed::should_stop(self)
    }
}

struct QuerySource(Retained<NSMetadataQuery>);

impl Listing for QuerySource {
    fn len(&self) -> usize {
        self.0.resultCount()
    }
    fn path(&self, index: usize) -> Option<PathBuf> {
        path_of(&self.0.resultAtIndex(index))
    }
}

impl Source for QuerySource {
    fn disable_updates(&self) {
        self.0.disableUpdates();
    }
    fn enable_updates(&self) {
        self.0.enableUpdates();
    }
}

struct ArrayListing(Retained<NSArray>);

impl Listing for ArrayListing {
    fn len(&self) -> usize {
        self.0.count()
    }
    fn path(&self, index: usize) -> Option<PathBuf> {
        path_of(&self.0.objectAtIndex(index))
    }
}

enum Work {
    /// Index-based drain of the query's results (initial gathering).
    Gather,
    /// A batch Spotlight reported in a live update, read `BATCH` items at a time.
    Items {
        items: Box<dyn Listing>,
        next: usize,
        removing: bool,
    },
}

/// What the caller does after a pass, once no borrow of the core is held.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Idle,
    /// More queued work: continue in a later, genuinely deferred main-thread turn.
    Continue,
    Stop,
}

/// The queue and bookkeeping of one search. It never schedules or re-enters itself:
/// `pass` does one bounded unit of work and reports what is left.
struct Core {
    source: Box<dyn Source>,
    out: Box<dyn Out>,
    queue: VecDeque<Work>,
    gather_queued: bool,
    processed: usize,
    finished_gathering: bool,
    live_announced: bool,
    updates_disabled: bool,
    pass_scheduled: bool,
}

impl Core {
    fn new(source: Box<dyn Source>, out: Box<dyn Out>) -> Self {
        Core {
            source,
            out,
            queue: VecDeque::new(),
            gather_queued: false,
            processed: 0,
            finished_gathering: false,
            live_announced: false,
            updates_disabled: false,
            pass_scheduled: false,
        }
    }

    fn queue_gather(&mut self) {
        if !self.gather_queued {
            self.gather_queued = true;
            self.queue.push_back(Work::Gather);
        }
        // The indices of a settled query shift when items disappear: freeze live updates
        // until the initial pass is fully read, then release them.
        if self.finished_gathering && !self.updates_disabled {
            self.source.disable_updates();
            self.updates_disabled = true;
        }
    }

    fn started(&mut self) {
        self.out.state(SearchState::Gathering);
    }

    fn progressed(&mut self) {
        self.queue_gather();
    }

    fn finished(&mut self) {
        self.finished_gathering = true;
        self.queue_gather();
    }

    /// Live update batches (removals first: an item removed and re-added in one
    /// batch ends up present). Ignored until the initial pass ended, because the
    /// index-based drain covers everything before that.
    fn updated(&mut self, batches: Vec<(Box<dyn Listing>, bool)>) {
        if !self.finished_gathering {
            return;
        }
        for (items, removing) in batches {
            self.queue.push_back(Work::Items {
                items,
                next: 0,
                removing,
            });
        }
    }

    /// Handles at most `BATCH` results, in order. `deferred` marks the pass that
    /// the previously requested continuation runs.
    fn pass(&mut self, deferred: bool) -> Outcome {
        if deferred {
            self.pass_scheduled = false;
        }
        if self.out.should_stop() {
            return Outcome::Stop;
        }
        let mut budget = BATCH;
        while budget > 0 {
            let Some(work) = self.queue.pop_front() else {
                break;
            };
            match work {
                Work::Gather => {
                    let count = self.source.len();
                    let take = count.saturating_sub(self.processed).min(budget);
                    let paths: Vec<PathBuf> = (self.processed..self.processed + take)
                        .filter_map(|i| self.source.path(i))
                        .collect();
                    self.processed += take;
                    budget -= take;
                    self.out.paths(paths);
                    if self.processed < count {
                        self.queue.push_front(Work::Gather);
                    } else {
                        self.gather_queued = false;
                    }
                }
                Work::Items {
                    items,
                    next,
                    removing,
                } => {
                    let count = items.len();
                    let take = count.saturating_sub(next).min(budget);
                    let paths: Vec<PathBuf> =
                        (next..next + take).filter_map(|i| items.path(i)).collect();
                    budget -= take;
                    if removing {
                        self.out.removed(paths);
                    } else {
                        self.out.paths(paths);
                    }
                    if next + take < count {
                        self.queue.push_front(Work::Items {
                            items,
                            next: next + take,
                            removing,
                        });
                    }
                }
            }
        }
        if !self.queue.is_empty() {
            if self.pass_scheduled {
                return Outcome::Idle;
            }
            self.pass_scheduled = true;
            return Outcome::Continue;
        }
        if self.finished_gathering && !self.live_announced {
            self.live_announced = true;
            self.out.state(SearchState::Live);
        }
        if self.updates_disabled {
            self.updates_disabled = false;
            self.source.enable_updates();
        }
        Outcome::Idle
    }
}

struct Native {
    core: Rc<RefCell<Core>>,
    /// The native objects; absent only for drivers that fake the query.
    handles: Option<(Retained<NSMetadataQuery>, Retained<Observer>)>,
}

thread_local! {
    static SESSIONS: RefCell<HashMap<String, Rc<Native>>> = RefCell::new(HashMap::new());
    #[cfg(test)]
    static TEST_DEFER: RefCell<Option<Rc<dyn Fn(Box<dyn FnOnce() + Send>)>>> =
        const { RefCell::new(None) };
}

fn lookup(id: &str) -> Option<Rc<Native>> {
    SESSIONS.with(|s| s.borrow().get(id).cloned())
}

/// Runs `work` in a later main-queue turn, never inline, even when called on the
/// main thread (Tauri's `run_on_main_thread` runs inline there, which re-entered
/// the pump). Each continuation therefore starts on a fresh, shallow stack and the
/// run loop gets to service input between batches.
fn defer(work: Box<dyn FnOnce() + Send>) {
    #[cfg(test)]
    if let Some(hook) = TEST_DEFER.with(|d| d.borrow().clone()) {
        hook(work);
        return;
    }
    DispatchQueue::main().exec_async(work);
}

fn failure(message: &str) -> AppError {
    AppError::new(ErrorCategory::Io, "search", None, message)
}

fn string_array(items: &[&str]) -> Retained<NSArray<AnyObject>> {
    let objects: Vec<Retained<AnyObject>> = items
        .iter()
        .map(|s| Retained::into_super(Retained::into_super(NSString::from_str(s))))
        .collect();
    NSArray::from_retained_slice(&objects)
}

/// The predicate for a normalized query. The text is a bound argument.
pub fn predicate(mode: SearchMode, query: &str) -> Retained<NSPredicate> {
    // SAFETY: the format has exactly one `%@` and one object argument is bound.
    unsafe {
        NSPredicate::predicateWithFormat_argumentArray(
            &NSString::from_str(predicate_format(mode)),
            Some(&string_array(&[query])),
        )
    }
}

fn scope_url(path: &Path) -> Option<Retained<NSURL>> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let ptr = std::ptr::NonNull::new(c_path.as_ptr() as *mut _)?;
    // SAFETY: `ptr` is a valid NUL-terminated string for the duration of the call.
    Some(unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(ptr, true, None)
    })
}

/// Starts a query on the main thread. The caller has validated the scope.
/// Continuations of large result sets are deferred onto the main dispatch queue,
/// so the thread must service its run loop (the app's event loop does).
pub fn start(
    id: &str,
    scope: &Path,
    mode: SearchMode,
    query_text: &str,
    feed: Feed,
) -> Result<(), AppError> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| failure("The search must be started on the main thread."))?;
    if lookup(id).is_some() {
        return Err(failure("This search is already running."));
    }
    let url = scope_url(scope).ok_or_else(|| failure("The folder path cannot be searched."))?;
    let query = NSMetadataQuery::new();
    query.setPredicate(Some(&predicate(mode, query_text)));
    let scopes: Retained<NSArray<AnyObject>> =
        NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(url))]);
    // SAFETY: the array holds NSURL objects, which search scopes accept.
    unsafe { query.setSearchScopes(&scopes) };
    query.setNotificationBatchingInterval(BATCHING_INTERVAL);

    let observer = Observer::new(mtm, id.to_string());
    let center = NSNotificationCenter::defaultCenter();
    let query_object: &AnyObject = &query;
    // Observers are registered before the query starts so no notification is missed.
    // SAFETY: the selectors exist on `Observer` and take one NSNotification.
    unsafe {
        for (selector, name) in [
            (
                sel!(didStart:),
                NSMetadataQueryDidStartGatheringNotification,
            ),
            (
                sel!(didProgress:),
                NSMetadataQueryGatheringProgressNotification,
            ),
            (
                sel!(didFinish:),
                NSMetadataQueryDidFinishGatheringNotification,
            ),
            (sel!(didUpdate:), NSMetadataQueryDidUpdateNotification),
        ] {
            center.addObserver_selector_name_object(
                &observer,
                selector,
                Some(name),
                Some(query_object),
            );
        }
    }

    let core = Core::new(Box::new(QuerySource(query.clone())), Box::new(feed));
    let native = Rc::new(Native {
        core: Rc::new(RefCell::new(core)),
        handles: Some((query.clone(), observer)),
    });
    SESSIONS.with(|s| s.borrow_mut().insert(id.to_string(), native));
    if !query.startQuery() {
        teardown(id);
        return Err(failure("Spotlight could not start the search."));
    }
    Ok(())
}

/// Stops and releases the query. Idempotent; main thread only.
pub fn stop(id: &str) {
    teardown(id);
}

/// Whether a query is currently registered on this thread (for tests and drivers).
pub fn is_running(id: &str) -> bool {
    lookup(id).is_some()
}

fn teardown(id: &str) {
    let Some(native) = SESSIONS.with(|s| s.borrow_mut().remove(id)) else {
        return;
    };
    if let Some((query, observer)) = &native.handles {
        // SAFETY: the observer was registered with this centre in `start`.
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer) };
        query.stopQuery();
    }
}

fn path_of(item: &AnyObject) -> Option<PathBuf> {
    let item = item.downcast_ref::<NSMetadataItem>()?;
    let value = item.valueForAttribute(&NSString::from_str("kMDItemPath"))?;
    let text = value.downcast_ref::<NSString>()?;
    Some(PathBuf::from(text.to_string()))
}

fn items_in(note: &NSNotification, key: &NSString) -> Option<Retained<NSArray>> {
    let info = note.userInfo()?;
    let value = info.objectForKey(key)?;
    value.downcast::<NSArray>().ok()
}

fn on_event(id: &str, event: Event, note: Option<&NSNotification>) {
    let Some(native) = lookup(id) else { return };
    let core = native.core.clone();
    if core.borrow().out.should_stop() {
        teardown(id);
        return;
    }
    {
        let mut c = core.borrow_mut();
        match event {
            Event::Start => c.started(),
            Event::Progress => c.progressed(),
            Event::Finish => c.finished(),
            Event::Update => {
                if let Some(note) = note {
                    // SAFETY: these are Foundation's documented userInfo keys.
                    let (added, changed, removed) = unsafe {
                        (
                            items_in(note, NSMetadataQueryUpdateAddedItemsKey),
                            items_in(note, NSMetadataQueryUpdateChangedItemsKey),
                            items_in(note, NSMetadataQueryUpdateRemovedItemsKey),
                        )
                    };
                    let batches = [(removed, true), (added, false), (changed, false)]
                        .into_iter()
                        .filter_map(|(array, removing)| {
                            array.map(|a| (Box::new(ArrayListing(a)) as Box<dyn Listing>, removing))
                        })
                        .collect();
                    c.updated(batches);
                }
            }
        }
    }
    pump(id, false);
}

/// One bounded pass, then (with no borrow held) either a deferred continuation,
/// teardown, or nothing.
fn pump(id: &str, deferred: bool) {
    let Some(native) = lookup(id) else { return };
    let core = native.core.clone();
    drop(native);
    let outcome = core.borrow_mut().pass(deferred);
    match outcome {
        Outcome::Idle => {}
        Outcome::Stop => teardown(id),
        Outcome::Continue => {
            let id = id.to_string();
            defer(Box::new(move || pump(&id, true)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSDictionary;
    use std::cell::Cell;

    fn names(items: &[&str]) -> Vec<Retained<NSDictionary<NSString, AnyObject>>> {
        items
            .iter()
            .map(|name| {
                let key = NSString::from_str("kMDItemFSName");
                let value: Retained<AnyObject> =
                    Retained::into_super(Retained::into_super(NSString::from_str(name)));
                NSDictionary::from_retained_objects(&[&*key], &[value])
            })
            .collect()
    }

    fn matches(mode: SearchMode, query: &str, name: &str) -> bool {
        let predicate = predicate(mode, query);
        let dict = &names(&[name])[0];
        // SAFETY: the dictionary is a valid key-value-coding object for the predicate.
        unsafe { predicate.evaluateWithObject(Some(dict.as_ref())) }
    }

    #[test]
    fn query_text_is_data_not_predicate_syntax() {
        let hostile = "x\" OR TRUEPREDICATE OR kMDItemFSName == \"y";
        assert!(!matches(SearchMode::Filename, hostile, "ordinary.txt"));
        assert!(matches(
            SearchMode::Filename,
            hostile,
            &format!("a{hostile}b.txt")
        ));
        for text in ["*", "?", "%@", "%K", "' OR 1=1 --", "$x", "{}", "a;b"] {
            assert!(
                !matches(SearchMode::Filename, text, "ordinary.txt"),
                "{text}"
            );
            assert!(
                matches(SearchMode::Filename, text, &format!("<{text}>")),
                "{text}"
            );
        }
        // Case- and diacritic-insensitive containment.
        assert!(matches(SearchMode::Filename, "CAFE", "Menu Café.txt"));
        assert!(!matches(SearchMode::Filename, "tea", "Menu Café.txt"));
    }

    #[test]
    fn modes_use_different_attributes() {
        let filename = predicate(SearchMode::Filename, "needle")
            .predicateFormat()
            .to_string();
        let content = predicate(SearchMode::Content, "needle")
            .predicateFormat()
            .to_string();
        assert!(filename.contains("kMDItemFSName"), "{filename}");
        assert!(content.contains("kMDItemTextContent"), "{content}");
    }

    #[test]
    fn starting_off_the_main_thread_fails_closed() {
        // Cargo runs tests on worker threads, so there is no main-thread marker.
        assert!(MainThreadMarker::new().is_none());
        let (session, feed) = crate::search::Session::spawn("t", std::env::temp_dir(), 1, |_| {});
        let error = start("t", &std::env::temp_dir(), SearchMode::Filename, "x", feed).unwrap_err();
        assert_eq!(error.category, ErrorCategory::Io);
        assert!(!is_running("t"));
        session.close(false);
    }

    // The pump below runs against a fake query: the batching, scheduling and
    // re-entrancy logic is real, the Spotlight results are not.

    #[derive(Debug, Clone, PartialEq)]
    enum Seen {
        Paths(usize),
        Removed(usize),
        State(SearchState),
    }

    struct FakeList(Rc<Cell<usize>>);

    impl Listing for FakeList {
        fn len(&self) -> usize {
            self.0.get()
        }
        fn path(&self, index: usize) -> Option<PathBuf> {
            Some(PathBuf::from(format!("/scope/{index}.txt")))
        }
    }

    impl Source for FakeList {
        fn disable_updates(&self) {}
        fn enable_updates(&self) {}
    }

    struct Recorder(Rc<RefCell<Vec<Seen>>>, Rc<Cell<bool>>);

    impl Out for Recorder {
        fn paths(&self, paths: Vec<PathBuf>) {
            self.0.borrow_mut().push(Seen::Paths(paths.len()));
        }
        fn removed(&self, paths: Vec<PathBuf>) {
            self.0.borrow_mut().push(Seen::Removed(paths.len()));
        }
        fn state(&self, state: SearchState) {
            self.0.borrow_mut().push(Seen::State(state));
        }
        fn should_stop(&self) -> bool {
            self.1.get()
        }
    }

    type Pending = Rc<RefCell<VecDeque<Box<dyn FnOnce() + Send>>>>;

    struct Harness {
        count: Rc<Cell<usize>>,
        seen: Rc<RefCell<Vec<Seen>>>,
        stop: Rc<Cell<bool>>,
        pending: Pending,
        id: &'static str,
    }

    impl Harness {
        /// `inline` mimics Tauri's `run_on_main_thread` on the main thread: the
        /// work runs immediately, inside the caller. Otherwise it is queued.
        fn new(id: &'static str, results: usize, inline: bool) -> Harness {
            let count = Rc::new(Cell::new(results));
            let seen: Rc<RefCell<Vec<Seen>>> = Rc::default();
            let stop = Rc::new(Cell::new(false));
            let pending: Pending = Rc::default();
            let queue = pending.clone();
            let hook: Rc<dyn Fn(Box<dyn FnOnce() + Send>)> = Rc::new(move |work| {
                if inline {
                    work();
                } else {
                    queue.borrow_mut().push_back(work);
                }
            });
            TEST_DEFER.with(|d| *d.borrow_mut() = Some(hook));
            let mut core = Core::new(
                Box::new(FakeList(count.clone())),
                Box::new(Recorder(seen.clone(), stop.clone())),
            );
            core.started();
            core.finished();
            SESSIONS.with(|s| {
                s.borrow_mut().insert(
                    id.to_string(),
                    Rc::new(Native {
                        core: Rc::new(RefCell::new(core)),
                        handles: None,
                    }),
                )
            });
            Harness {
                count,
                seen,
                stop,
                pending,
                id,
            }
        }

        fn run_deferred(&self) -> usize {
            let mut turns = 0;
            loop {
                let next = self.pending.borrow_mut().pop_front();
                let Some(work) = next else { return turns };
                work();
                turns += 1;
            }
        }

        fn delivered(&self) -> usize {
            self.seen
                .borrow()
                .iter()
                .map(|s| match s {
                    Seen::Paths(n) => *n,
                    _ => 0,
                })
                .sum()
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            TEST_DEFER.with(|d| *d.borrow_mut() = None);
            SESSIONS.with(|s| s.borrow_mut().remove(self.id));
        }
    }

    #[test]
    fn a_batch_boundary_is_exact_and_needs_no_continuation() {
        for inline in [true, false] {
            let h = Harness::new("boundary", BATCH, inline);
            pump(h.id, false);
            assert_eq!(h.delivered(), BATCH);
            assert!(h.pending.borrow().is_empty());
            assert_eq!(
                h.seen.borrow().last(),
                Some(&Seen::State(SearchState::Live))
            );
        }
    }

    #[test]
    fn one_result_past_the_boundary_continues_without_reentering_the_pump() {
        // Inline scheduling used to re-enter the pump with the core still borrowed:
        // 500 results passed and 501 panicked.
        for results in [BATCH + 1, 2 * BATCH, 2 * BATCH + 1, 7 * BATCH + 3] {
            let h = Harness::new("inline", results, true);
            pump(h.id, false);
            assert_eq!(h.delivered(), results);
            assert_eq!(
                h.seen.borrow().last(),
                Some(&Seen::State(SearchState::Live))
            );
        }
    }

    #[test]
    fn continuations_are_deferred_and_each_turn_is_bounded() {
        let h = Harness::new("deferred", 2 * BATCH + 200, false);
        pump(h.id, false);
        // Only the first batch ran; the rest waits for a later main-thread turn.
        assert_eq!(h.delivered(), BATCH);
        assert_eq!(h.pending.borrow().len(), 1);
        let next = h.pending.borrow_mut().pop_front().unwrap();
        next();
        assert_eq!(h.delivered(), 2 * BATCH);
        assert_eq!(h.pending.borrow().len(), 1);
        h.run_deferred();
        assert_eq!(
            *h.seen.borrow(),
            vec![
                Seen::State(SearchState::Gathering),
                Seen::Paths(BATCH),
                Seen::Paths(BATCH),
                Seen::Paths(200),
                Seen::State(SearchState::Live),
            ]
        );
    }

    #[test]
    fn events_arriving_while_a_continuation_is_pending_do_not_stack_continuations() {
        let h = Harness::new("pending", BATCH + 50, false);
        pump(h.id, false);
        pump(h.id, false);
        assert_eq!(h.delivered(), BATCH + 50);
        assert_eq!(h.pending.borrow().len(), 1, "one continuation at a time");
        h.run_deferred();
        assert_eq!(h.delivered(), BATCH + 50);
    }

    #[test]
    fn a_stopped_search_is_torn_down_by_its_continuation() {
        let h = Harness::new("stopped", 3 * BATCH, false);
        pump(h.id, false);
        assert!(is_running(h.id));
        h.stop.set(true);
        assert_eq!(h.run_deferred(), 1);
        assert!(!is_running(h.id), "released without any query notification");
        assert_eq!(h.delivered(), BATCH);
    }

    #[test]
    fn live_update_batches_are_chunked_and_removals_precede_additions() {
        let h = Harness::new("updates", 0, false);
        pump(h.id, false);
        let native = lookup(h.id).unwrap();
        let removed = Rc::new(Cell::new(BATCH + 10));
        let added = Rc::new(Cell::new(5));
        native.core.borrow_mut().updated(vec![
            (Box::new(FakeList(removed)) as Box<dyn Listing>, true),
            (Box::new(FakeList(added)), false),
        ]);
        h.seen.borrow_mut().clear();
        pump(h.id, false);
        h.run_deferred();
        assert_eq!(
            *h.seen.borrow(),
            vec![Seen::Removed(BATCH), Seen::Removed(10), Seen::Paths(5)]
        );
        h.count.set(0);
    }
}
