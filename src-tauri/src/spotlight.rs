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
    sync::Arc,
};

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

/// Schedules work onto the main thread (the app uses Tauri's
/// `run_on_main_thread`; a standalone driver uses its own queue).
pub type Schedule = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

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

enum Work {
    /// Index-based drain of the query's results (initial gathering).
    Gather,
    /// A batch Spotlight reported in a live update, read `BATCH` items at a time.
    Items {
        array: Retained<NSArray>,
        next: usize,
        removing: bool,
    },
}

struct Native {
    id: String,
    query: Retained<NSMetadataQuery>,
    observer: Retained<Observer>,
    feed: Feed,
    schedule: Schedule,
    queue: VecDeque<Work>,
    gather_queued: bool,
    processed: usize,
    finished_gathering: bool,
    live_announced: bool,
    updates_disabled: bool,
    pass_scheduled: bool,
}

thread_local! {
    static SESSIONS: RefCell<HashMap<String, Rc<RefCell<Native>>>> = RefCell::new(HashMap::new());
}

fn lookup(id: &str) -> Option<Rc<RefCell<Native>>> {
    SESSIONS.with(|s| s.borrow().get(id).cloned())
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

fn failure(message: &str) -> AppError {
    AppError::new(ErrorCategory::Io, "search", None, message)
}

/// Starts a query on the main thread. The caller has validated the scope.
pub fn start(
    id: &str,
    scope: &Path,
    mode: SearchMode,
    query_text: &str,
    feed: Feed,
    schedule: Schedule,
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

    let native = Rc::new(RefCell::new(Native {
        id: id.to_string(),
        query: query.clone(),
        observer,
        feed,
        schedule,
        queue: VecDeque::new(),
        gather_queued: false,
        processed: 0,
        finished_gathering: false,
        live_announced: false,
        updates_disabled: false,
        pass_scheduled: false,
    }));
    SESSIONS.with(|s| s.borrow_mut().insert(id.to_string(), native.clone()));
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
    let native = native.borrow();
    // SAFETY: the observer was registered with this centre in `start`.
    unsafe { NSNotificationCenter::defaultCenter().removeObserver(&native.observer) };
    native.query.stopQuery();
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
    if native.borrow().feed.should_stop() {
        teardown(id);
        return;
    }
    {
        let mut n = native.borrow_mut();
        match event {
            Event::Start => n.feed.state(SearchState::Gathering),
            Event::Progress => queue_gather(&mut n),
            Event::Finish => {
                n.finished_gathering = true;
                queue_gather(&mut n);
            }
            Event::Update => {
                // Before the initial pass ends, the index-based drain covers everything.
                if n.finished_gathering {
                    if let Some(note) = note {
                        // SAFETY: these are Foundation's documented userInfo keys.
                        let (added, changed, removed) = unsafe {
                            (
                                items_in(note, NSMetadataQueryUpdateAddedItemsKey),
                                items_in(note, NSMetadataQueryUpdateChangedItemsKey),
                                items_in(note, NSMetadataQueryUpdateRemovedItemsKey),
                            )
                        };
                        // Removals first: an item removed and re-added in one batch ends up present.
                        for (array, removing) in [(removed, true), (added, false), (changed, false)]
                        {
                            if let Some(array) = array {
                                n.queue.push_back(Work::Items {
                                    array,
                                    next: 0,
                                    removing,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    pump(id);
}

fn queue_gather(n: &mut Native) {
    if !n.gather_queued {
        n.gather_queued = true;
        n.queue.push_back(Work::Gather);
    }
    // The indices of a settled query shift when items disappear: freeze live updates
    // until the initial pass is fully read, then release them.
    if n.finished_gathering && !n.updates_disabled {
        n.query.disableUpdates();
        n.updates_disabled = true;
    }
}

/// Handles at most `BATCH` results, forwarding them in order, and schedules the
/// rest for another main-thread turn.
fn pump(id: &str) {
    let Some(native) = lookup(id) else { return };
    let mut n = native.borrow_mut();
    n.pass_scheduled = false;
    if n.feed.should_stop() {
        drop(n);
        teardown(id);
        return;
    }
    let mut budget = BATCH;
    while budget > 0 {
        let Some(work) = n.queue.pop_front() else {
            break;
        };
        match work {
            Work::Gather => {
                let count = n.query.resultCount();
                let take = count.saturating_sub(n.processed).min(budget);
                let paths: Vec<PathBuf> = (n.processed..n.processed + take)
                    .filter_map(|i| path_of(&n.query.resultAtIndex(i)))
                    .collect();
                n.processed += take;
                budget -= take;
                n.feed.paths(paths);
                if n.processed < count {
                    n.queue.push_front(Work::Gather);
                } else {
                    n.gather_queued = false;
                }
            }
            Work::Items {
                array,
                next,
                removing,
            } => {
                let count = array.count();
                let take = count.saturating_sub(next).min(budget);
                let paths: Vec<PathBuf> = (next..next + take)
                    .filter_map(|i| path_of(&array.objectAtIndex(i)))
                    .collect();
                budget -= take;
                if removing {
                    n.feed.removed(paths);
                } else {
                    n.feed.paths(paths);
                }
                if next + take < count {
                    n.queue.push_front(Work::Items {
                        array,
                        next: next + take,
                        removing,
                    });
                }
            }
        }
    }
    if !n.queue.is_empty() {
        if !n.pass_scheduled {
            n.pass_scheduled = true;
            let schedule = n.schedule.clone();
            let id = n.id.clone();
            schedule(Box::new(move || pump(&id)));
        }
        return;
    }
    if n.finished_gathering && !n.live_announced {
        n.live_announced = true;
        n.feed.state(SearchState::Live);
    }
    if n.updates_disabled {
        n.updates_disabled = false;
        n.query.enableUpdates();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSDictionary;

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
        let schedule: Schedule = Arc::new(|work| work());
        let error = start(
            "t",
            &std::env::temp_dir(),
            SearchMode::Filename,
            "x",
            feed,
            schedule,
        )
        .unwrap_err();
        assert_eq!(error.category, ErrorCategory::Io);
        assert!(!is_running("t"));
        session.close(false);
    }
}
