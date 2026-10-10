//! Engine tests on exclusively owned temporary fixtures; no user files are touched.

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
};

use super::*;
use crate::spike_fixture::Fixture;

struct Ctl {
    cancelled: AtomicBool,
    /// Cancels once this many cancellation checks have happened (deterministic).
    countdown: AtomicI64,
    events: Mutex<Vec<TaskEvent>>,
    answer: Box<dyn Fn(&ConflictPrompt) -> Option<Resolution> + Send + Sync>,
    prompts: Mutex<Vec<ConflictPrompt>>,
}

impl Ctl {
    fn new(answer: impl Fn(&ConflictPrompt) -> Option<Resolution> + Send + Sync + 'static) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            countdown: AtomicI64::new(i64::MAX),
            events: Mutex::new(Vec::new()),
            answer: Box::new(answer),
            prompts: Mutex::new(Vec::new()),
        }
    }

    fn deciding(decision: ConflictDecision, apply_to_all: bool) -> Self {
        Self::new(move |_| {
            Some(Resolution {
                decision,
                apply_to_all,
            })
        })
    }

    fn silent() -> Self {
        Self::new(|_| panic!("no conflict expected"))
    }

    fn terminal(&self) -> TaskEvent {
        let events = self.events.lock().unwrap();
        let terminal: Vec<_> = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    TaskEvent::Finished { .. }
                        | TaskEvent::Cancelled { .. }
                        | TaskEvent::Failed { .. }
                )
            })
            .collect();
        assert_eq!(terminal.len(), 1, "exactly one terminal event: {events:?}");
        terminal[0].clone()
    }

    fn summary(&self) -> (TaskSummary, bool) {
        match self.terminal() {
            TaskEvent::Finished { summary, .. } => (summary, false),
            TaskEvent::Cancelled { summary, .. } => (summary, true),
            other => panic!("unexpected terminal event {other:?}"),
        }
    }

    fn failed_category(&self) -> ErrorCategory {
        match self.terminal() {
            TaskEvent::Failed { error, .. } => error.category,
            other => panic!("expected a failed task, got {other:?}"),
        }
    }
}

impl TaskControl for Ctl {
    fn is_cancelled(&self) -> bool {
        if self.countdown.fetch_sub(1, Ordering::Relaxed) <= 0 {
            self.cancelled.store(true, Ordering::Relaxed);
        }
        self.cancelled.load(Ordering::Relaxed)
    }
    fn emit(&self, event: TaskEvent) {
        self.events.lock().unwrap().push(event);
    }
    fn ask(&self, prompt: &ConflictPrompt) -> Option<Resolution> {
        self.prompts.lock().unwrap().push(prompt.clone());
        (self.answer)(prompt)
    }
}

#[derive(Default)]
struct FakeTrash {
    trashed: Mutex<Vec<PathBuf>>,
    deny: Option<PathBuf>,
}

impl Trasher for FakeTrash {
    fn trash(&self, path: &Path) -> Result<Option<PathBuf>, AppError> {
        if self
            .deny
            .as_ref()
            .is_some_and(|d| d.file_name() == path.file_name())
        {
            return Err(AppError::new(
                ErrorCategory::PermissionDenied,
                "move to the Trash",
                Some(display_name(path)),
                "denied",
            ));
        }
        // Stand-in for the Trash: a sibling folder inside the owned fixture.
        let mut base = path.parent().unwrap();
        // A replacement hands over the item inside its private holding folder.
        if base.to_string_lossy().ends_with(".old") {
            base = base.parent().unwrap();
        }
        let holder = base.join(".fake-trash");
        fs::create_dir_all(&holder).unwrap();
        let to = holder.join(path.file_name().unwrap());
        fs::rename(path, &to).unwrap();
        self.trashed.lock().unwrap().push(path.to_path_buf());
        Ok(Some(to))
    }
}

/// Runs a callback just before delegating to [`FakeTrash`], to simulate concurrent changes.
struct HookTrash<F: Fn(&Path) + Sync> {
    hook: F,
    inner: FakeTrash,
}

impl<F: Fn(&Path) + Sync> Trasher for HookTrash<F> {
    fn trash(&self, path: &Path) -> Result<Option<PathBuf>, AppError> {
        (self.hook)(path);
        self.inner.trash(path)
    }
}

fn fx(prefix: &str) -> Fixture {
    Fixture::create_in(&std::env::temp_dir(), prefix).unwrap()
}

fn dir(fx: &Fixture, name: &str) -> PathBuf {
    let path = fx.path().join(name);
    fs::create_dir(&path).unwrap();
    path
}

fn transfer(mode: TransferMode, ctl: &Ctl, sources: Vec<PathBuf>, dest: &Path) {
    run_transfer("t", ctl, &FakeTrash::default(), mode, sources, dest);
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[test]
fn copy_preserves_contents_structure_and_links_without_following_them() {
    let f = fx("mfm-op-copy");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    let tree = src.join("tree");
    fs::create_dir_all(tree.join("sub")).unwrap();
    let big: String = "0123456789".repeat(300_000);
    fs::write(tree.join("big.txt"), &big).unwrap();
    fs::write(tree.join("sub/small.txt"), "small").unwrap();
    fs::write(src.join("empty"), "").unwrap();
    symlink("big.txt", tree.join("link")).unwrap();
    symlink(f.path().join("outside-missing"), tree.join("dangling")).unwrap();
    let ctl = Ctl::silent();
    transfer(
        TransferMode::Copy,
        &ctl,
        vec![tree.clone(), src.join("empty")],
        &dst,
    );
    let (summary, cancelled) = ctl.summary();
    assert!(!cancelled);
    assert_eq!(
        (summary.succeeded, summary.skipped, summary.failed.len()),
        (2, 0, 0)
    );
    assert_eq!(read(&dst.join("tree/big.txt")), big);
    assert_eq!(read(&dst.join("tree/sub/small.txt")), "small");
    assert_eq!(read(&dst.join("empty")), "");
    assert!(
        fs::symlink_metadata(dst.join("tree/link"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        fs::read_link(dst.join("tree/link")).unwrap(),
        Path::new("big.txt")
    );
    assert!(
        fs::symlink_metadata(dst.join("tree/dangling"))
            .unwrap()
            .is_symlink()
    );
    assert!(tree.join("big.txt").exists(), "copy keeps the source");
    assert!(summary.affected.contains(&path_to_id(&dst)));
    let events = ctl.events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(
        e,
        TaskEvent::Progress {
            unit: ProgressUnit::Bytes,
            ..
        }
    )));
    drop(events);
    f.cleanup().unwrap();
}

#[test]
fn a_directory_symlink_is_copied_as_a_link_not_recursed() {
    let f = fx("mfm-op-dirlink");
    let real = dir(&f, "real");
    fs::write(real.join("inside.txt"), "x").unwrap();
    let dst = dir(&f, "dst");
    symlink(&real, f.path().join("ln")).unwrap();
    let ctl = Ctl::silent();
    transfer(TransferMode::Copy, &ctl, vec![f.path().join("ln")], &dst);
    assert!(fs::symlink_metadata(dst.join("ln")).unwrap().is_symlink());
    assert_eq!(ctl.summary().0.succeeded, 1);
    f.cleanup().unwrap();
}

#[test]
fn copying_or_moving_into_itself_or_a_descendant_is_rejected() {
    let f = fx("mfm-op-self");
    let top = dir(&f, "top");
    let child = dir(&f, "top/child");
    fs::write(top.join("a.txt"), "a").unwrap();
    for mode in [TransferMode::Copy, TransferMode::Move] {
        for dest in [&top, &child] {
            let ctl = Ctl::silent();
            transfer(mode, &ctl, vec![top.clone()], dest);
            let (summary, _) = ctl.summary();
            assert_eq!(summary.failed.len(), 1, "{mode:?} into {dest:?}");
            assert_eq!(
                summary.failed[0].error.category,
                ErrorCategory::InvalidInput
            );
        }
    }
    assert_eq!(fs::read_dir(&top).unwrap().count(), 2);
    assert_eq!(fs::read_dir(&child).unwrap().count(), 0);
    // A link that points back into the source does not bypass the check.
    let alias = f.path().join("alias");
    symlink(&child, &alias).unwrap();
    let ctl = Ctl::silent();
    transfer(TransferMode::Copy, &ctl, vec![top.clone()], &alias);
    assert_eq!(ctl.summary().0.failed.len(), 1);
    f.cleanup().unwrap();
}

#[test]
fn moving_an_item_onto_itself_is_rejected_and_nothing_changes() {
    let f = fx("mfm-op-same");
    let file = f.write("a.txt", "a").unwrap();
    let ctl = Ctl::silent();
    transfer(TransferMode::Move, &ctl, vec![file.clone()], f.path());
    assert_eq!(ctl.summary().0.failed.len(), 1);
    assert_eq!(read(&file), "a");
    f.cleanup().unwrap();
}

#[test]
fn copying_onto_the_same_name_asks_and_keep_both_makes_numbered_copies() {
    let f = fx("mfm-op-keep");
    let file = f.write("a.txt", "original").unwrap();
    let ctl = Ctl::deciding(ConflictDecision::KeepBoth, false);
    transfer(TransferMode::Copy, &ctl, vec![file.clone()], f.path());
    let second = Ctl::deciding(ConflictDecision::KeepBoth, false);
    transfer(TransferMode::Copy, &second, vec![file.clone()], f.path());
    assert_eq!(read(&f.path().join("a copy.txt")), "original");
    assert_eq!(read(&f.path().join("a copy 2.txt")), "original");
    let prompts = ctl.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].same_item);
    drop(prompts);
    f.cleanup().unwrap();
}

#[test]
fn skip_leaves_the_destination_alone_and_reports_it() {
    let f = fx("mfm-op-skip");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(src.join("b.txt"), "b").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let ctl = Ctl::deciding(ConflictDecision::Skip, false);
    transfer(
        TransferMode::Copy,
        &ctl,
        vec![src.join("a.txt"), src.join("b.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.skipped), (1, 1));
    assert_eq!(read(&dst.join("a.txt")), "old");
    assert_eq!(read(&dst.join("b.txt")), "b");
    f.cleanup().unwrap();
}

#[test]
fn replace_swaps_a_file_and_puts_the_old_one_in_the_trash() {
    let f = fx("mfm-op-replace");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    let trash = FakeTrash::default();
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Copy,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.failed.len()), (1, 0));
    assert_eq!(read(&dst.join("a.txt")), "new");
    assert_eq!(read(&dst.join(".fake-trash/a.txt")), "old");
    assert_eq!(trash.trashed.lock().unwrap().len(), 1);
    assert_eq!(read(&src.join("a.txt")), "new");
    let leftovers = fs::read_dir(&dst)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".mfm-replace"))
        .count();
    assert_eq!(leftovers, 0);
    f.cleanup().unwrap();
}

#[test]
fn replace_by_move_removes_the_source_and_is_atomic_when_trashing_fails() {
    let f = fx("mfm-op-replace-move");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    run_transfer(
        "t",
        &ctl,
        &FakeTrash::default(),
        TransferMode::Move,
        vec![src.join("a.txt")],
        &dst,
    );
    assert_eq!(ctl.summary().0.succeeded, 1);
    assert_eq!(read(&dst.join("a.txt")), "new");
    assert!(!src.join("a.txt").exists());

    fs::write(src.join("b.txt"), "new-b").unwrap();
    fs::write(dst.join("b.txt"), "old-b").unwrap();
    let denying = FakeTrash {
        deny: Some(dst.join("b.txt")),
        ..Default::default()
    };
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    run_transfer(
        "t",
        &ctl,
        &denying,
        TransferMode::Move,
        vec![src.join("b.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.failed.len()), (0, 1));
    assert_eq!(read(&dst.join("b.txt")), "old-b");
    assert_eq!(read(&src.join("b.txt")), "new-b");
    f.cleanup().unwrap();
}

#[test]
fn folders_are_never_replaced_or_merged() {
    let f = fx("mfm-op-dirconflict");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    for (side, text) in [(&src, "src"), (&dst, "dst")] {
        fs::create_dir(side.join("box")).unwrap();
        fs::write(side.join("box/f.txt"), text).unwrap();
    }
    let ctl = Ctl::deciding(ConflictDecision::Replace, true);
    transfer(TransferMode::Copy, &ctl, vec![src.join("box")], &dst);
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.skipped), (0, 1));
    assert_eq!(read(&dst.join("box/f.txt")), "dst");
    assert!(!ctl.prompts.lock().unwrap()[0].replaceable());

    let ctl = Ctl::deciding(ConflictDecision::KeepBoth, false);
    transfer(TransferMode::Copy, &ctl, vec![src.join("box")], &dst);
    assert_eq!(read(&dst.join("box copy/f.txt")), "src");
    assert_eq!(read(&dst.join("box/f.txt")), "dst");
    f.cleanup().unwrap();
}

#[test]
fn apply_to_all_asks_only_once() {
    let f = fx("mfm-op-all");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    for name in ["1.txt", "2.txt", "3.txt"] {
        fs::write(src.join(name), "new").unwrap();
        fs::write(dst.join(name), "old").unwrap();
    }
    let ctl = Ctl::deciding(ConflictDecision::Skip, true);
    let sources = ["1.txt", "2.txt", "3.txt"]
        .iter()
        .map(|n| src.join(n))
        .collect();
    transfer(TransferMode::Copy, &ctl, sources, &dst);
    assert_eq!(ctl.prompts.lock().unwrap().len(), 1);
    assert_eq!(ctl.summary().0.skipped, 3);
    f.cleanup().unwrap();
}

#[test]
fn a_missing_source_fails_only_that_item_and_the_rest_still_runs() {
    let f = fx("mfm-op-missing");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("ok.txt"), "ok").unwrap();
    let ctl = Ctl::silent();
    transfer(
        TransferMode::Copy,
        &ctl,
        vec![src.join("gone.txt"), src.join("ok.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!(summary.succeeded, 1);
    assert_eq!(summary.failed.len(), 1);
    assert_eq!(summary.failed[0].error.category, ErrorCategory::NotFound);
    assert_eq!(read(&dst.join("ok.txt")), "ok");
    f.cleanup().unwrap();
}

#[test]
fn bad_destinations_fail_the_whole_task_with_a_typed_error() {
    let f = fx("mfm-op-baddest");
    let file = f.write("a.txt", "a").unwrap();
    let ctl = Ctl::silent();
    transfer(TransferMode::Copy, &ctl, vec![file.clone()], &file);
    assert_eq!(ctl.failed_category(), ErrorCategory::InvalidInput);
    let ctl = Ctl::silent();
    transfer(
        TransferMode::Copy,
        &ctl,
        vec![file.clone()],
        &f.path().join("nope"),
    );
    assert_eq!(ctl.failed_category(), ErrorCategory::NotFound);
    f.cleanup().unwrap();
}

#[test]
fn unreadable_and_unwritable_items_are_reported_without_stopping_the_task() {
    let f = fx("mfm-op-perm");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    let locked = src.join("locked.txt");
    fs::write(&locked, "secret").unwrap();
    fs::write(src.join("ok.txt"), "ok").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let ctl = Ctl::silent();
    transfer(
        TransferMode::Copy,
        &ctl,
        vec![locked.clone(), src.join("ok.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    if !is_root() {
        assert_eq!(summary.failed.len(), 1);
        assert_eq!(
            summary.failed[0].error.category,
            ErrorCategory::PermissionDenied
        );
        assert!(!dst.join("locked.txt").exists(), "no partial output");
    }
    assert_eq!(read(&dst.join("ok.txt")), "ok");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).unwrap();

    fs::set_permissions(&dst, fs::Permissions::from_mode(0o500)).unwrap();
    let ctl = Ctl::silent();
    transfer(TransferMode::Copy, &ctl, vec![src.join("ok.txt")], &dst);
    if !is_root() {
        assert_eq!(ctl.failed_category(), ErrorCategory::PermissionDenied);
    }
    fs::set_permissions(&dst, fs::Permissions::from_mode(0o700)).unwrap();
    f.cleanup().unwrap();
}

#[test]
fn cancelling_before_start_does_nothing_and_reports_cancelled() {
    let f = fx("mfm-op-cancel0");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "a").unwrap();
    let ctl = Ctl::silent();
    ctl.cancelled.store(true, Ordering::Relaxed);
    transfer(TransferMode::Move, &ctl, vec![src.join("a.txt")], &dst);
    let (summary, cancelled) = ctl.summary();
    assert!(cancelled);
    assert_eq!(summary.succeeded, 0);
    assert!(src.join("a.txt").exists());
    assert!(!dst.join("a.txt").exists());
    f.cleanup().unwrap();
}

#[test]
fn cancelling_at_a_conflict_stops_remaining_work_and_keeps_completed_items() {
    let f = fx("mfm-op-cancel1");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    for n in ["1.txt", "2.txt", "3.txt"] {
        fs::write(src.join(n), n).unwrap();
    }
    fs::write(dst.join("2.txt"), "old").unwrap();
    let ctl = Ctl::new(|_| None);
    let sources = ["1.txt", "2.txt", "3.txt"]
        .iter()
        .map(|n| src.join(n))
        .collect();
    transfer(TransferMode::Copy, &ctl, sources, &dst);
    let (summary, cancelled) = ctl.summary();
    assert!(cancelled);
    assert_eq!(
        summary.succeeded, 1,
        "completed work is reported, not rolled back"
    );
    assert_eq!(read(&dst.join("1.txt")), "1.txt");
    assert!(!dst.join("3.txt").exists());
    assert_eq!(read(&dst.join("2.txt")), "old");
    f.cleanup().unwrap();
}

#[test]
fn cancelling_mid_file_removes_the_partial_file() {
    let f = fx("mfm-op-cancel2");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    let size = 32 * 1024 * 1024;
    fs::write(src.join("big.bin"), vec![7u8; size]).unwrap();
    let ctl = Ctl::silent();
    let finished = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !finished.load(Ordering::Relaxed) {
                let started = ctl.events.lock().unwrap().iter().any(
                    |e| matches!(e, TaskEvent::Progress { completed: Some(done), .. } if *done > 0),
                );
                if started {
                    ctl.cancelled.store(true, Ordering::Relaxed);
                    break;
                }
                std::thread::yield_now();
            }
        });
        transfer(TransferMode::Copy, &ctl, vec![src.join("big.bin")], &dst);
        finished.store(true, Ordering::Relaxed);
    });
    // On a very fast disk the copy can complete before the cancel is observed.
    let (summary, cancelled) = ctl.summary();
    if cancelled {
        assert!(!dst.join("big.bin").exists());
        assert_eq!(summary.succeeded, 0);
    } else {
        assert_eq!(fs::read(dst.join("big.bin")).unwrap().len(), size);
    }
    f.cleanup().unwrap();
}

#[test]
fn move_on_one_volume_renames_and_keeps_contents() {
    let f = fx("mfm-op-move");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::create_dir(src.join("folder")).unwrap();
    fs::write(src.join("folder/x.txt"), "x").unwrap();
    fs::write(src.join("a.txt"), "a").unwrap();
    let ctl = Ctl::silent();
    transfer(
        TransferMode::Move,
        &ctl,
        vec![src.join("folder"), src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.failed.len()), (2, 0));
    assert_eq!(read(&dst.join("folder/x.txt")), "x");
    assert_eq!(read(&dst.join("a.txt")), "a");
    assert!(!src.join("folder").exists() && !src.join("a.txt").exists());
    assert!(summary.affected.contains(&path_to_id(&src)));
    assert!(summary.affected.contains(&path_to_id(&dst)));
    f.cleanup().unwrap();
}

// A second volume is not available to tests (creating one needs system
// permission), so the copy-then-delete branch is driven directly on one volume.
#[test]
fn cross_volume_fallback_deletes_the_source_only_after_a_complete_copy() {
    let f = fx("mfm-op-xdev");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    let tree = src.join("tree");
    fs::create_dir_all(tree.join("sub")).unwrap();
    fs::write(tree.join("a.txt"), "a").unwrap();
    fs::write(tree.join("sub/b.txt"), "b").unwrap();
    symlink("a.txt", tree.join("ln")).unwrap();
    let ctl = Ctl::silent();
    let trash = FakeTrash::default();
    let mut run = Run::new("t", &ctl, &trash, "move");
    assert!(
        run.move_across_volumes(&tree, &dst.join("tree"), 0)
            .unwrap()
    );
    assert_eq!((run.succeeded, run.failed.len()), (1, 0));
    assert_eq!(read(&dst.join("tree/sub/b.txt")), "b");
    assert!(!tree.exists(), "fully copied source is removed");

    let tree2 = src.join("tree2");
    fs::create_dir(&tree2).unwrap();
    fs::write(tree2.join("ok.txt"), "ok").unwrap();
    fs::write(tree2.join("bad.txt"), "bad").unwrap();
    fs::set_permissions(tree2.join("bad.txt"), fs::Permissions::from_mode(0o000)).unwrap();
    let mut run = Run::new("t", &ctl, &trash, "move");
    run.move_across_volumes(&tree2, &dst.join("tree2"), 0)
        .unwrap();
    if !is_root() {
        assert!(!run.failed.is_empty());
        assert_eq!(
            read(&tree2.join("ok.txt")),
            "ok",
            "incomplete copy keeps sources"
        );
        assert!(tree2.join("bad.txt").exists());
    }
    fs::set_permissions(tree2.join("bad.txt"), fs::Permissions::from_mode(0o600)).unwrap();
    f.cleanup().unwrap();
}

#[test]
fn rename_changes_the_name_without_ever_replacing_another_item() {
    let f = fx("mfm-op-rename");
    let a = f.write("a.txt", "a").unwrap();
    f.write("b.txt", "b").unwrap();
    let renamed = rename_item(&a, "c.txt").unwrap();
    assert_eq!(read(&renamed), "a");
    assert!(!a.exists());
    let err = rename_item(&renamed, "b.txt").unwrap_err();
    assert_eq!(err.category, ErrorCategory::AlreadyExists);
    assert_eq!(read(&f.path().join("b.txt")), "b");
    assert_eq!(read(&renamed), "a");
    let too_long = "n".repeat(300);
    for bad in ["", "x/y", ".", "..", "a\0b", too_long.as_str()] {
        assert_eq!(
            rename_item(&renamed, bad).unwrap_err().category,
            ErrorCategory::InvalidInput,
            "{bad:?}"
        );
    }
    assert_eq!(
        rename_item(&f.path().join("missing"), "z")
            .unwrap_err()
            .category,
        ErrorCategory::NotFound
    );
    assert_eq!(rename_item(&renamed, "c.txt").unwrap(), renamed);
    let cased = rename_item(&renamed, "C.txt").unwrap();
    assert_eq!(read(&cased), "a");
    assert!(
        fs::read_dir(f.path())
            .unwrap()
            .any(|e| e.unwrap().file_name() == "C.txt")
    );
    f.cleanup().unwrap();
}

#[test]
fn create_folder_picks_free_names_and_rejects_collisions() {
    let f = fx("mfm-op-mkdir");
    let first = create_folder(f.path(), None).unwrap();
    let second = create_folder(f.path(), None).unwrap();
    assert_eq!(first.file_name().unwrap(), "New folder");
    assert_eq!(second.file_name().unwrap(), "New folder 2");
    let named = create_folder(f.path(), Some("Mine")).unwrap();
    assert!(named.is_dir());
    assert_eq!(
        create_folder(f.path(), Some("Mine")).unwrap_err().category,
        ErrorCategory::AlreadyExists
    );
    assert_eq!(
        create_folder(f.path(), Some("a/b")).unwrap_err().category,
        ErrorCategory::InvalidInput
    );
    let file = f.write("file", "x").unwrap();
    assert!(create_folder(&file, None).is_err());
    assert_eq!(
        create_folder(&f.path().join("nope"), None)
            .unwrap_err()
            .category,
        ErrorCategory::NotFound
    );
    f.cleanup().unwrap();
}

#[test]
fn unique_names_keep_extensions_for_files_but_not_for_folders() {
    let f = fx("mfm-op-unique");
    f.write("v1.2", "x").unwrap();
    assert_eq!(
        unique_name(f.path(), OsStr::new("v1.2"), true)
            .file_name()
            .unwrap(),
        "v1.2 copy"
    );
    assert_eq!(
        unique_name(f.path(), OsStr::new("v1.2"), false)
            .file_name()
            .unwrap(),
        "v1 copy.2"
    );
    f.cleanup().unwrap();
}

#[test]
fn trash_reports_per_item_results_and_never_deletes() {
    let f = fx("mfm-op-trash");
    let a = f.write("a.txt", "a").unwrap();
    let b = f.write("b.txt", "b").unwrap();
    let c = f.write("c.txt", "c").unwrap();
    let trash = FakeTrash {
        deny: Some(b.clone()),
        ..Default::default()
    };
    let ctl = Ctl::silent();
    run_trash(
        "t",
        &ctl,
        &trash,
        vec![a.clone(), b.clone(), f.path().join("gone"), c.clone()],
    );
    let (summary, _) = ctl.summary();
    assert_eq!(summary.succeeded, 2);
    assert_eq!(summary.failed.len(), 2);
    assert!(b.exists(), "a denied item is left untouched");
    assert_eq!(read(&f.path().join(".fake-trash/a.txt")), "a");
    assert!(summary.affected.contains(&path_to_id(f.path())));

    let ctl = Ctl::silent();
    run_trash("t", &ctl, &trash, vec![PathBuf::from("/")]);
    assert_eq!(ctl.summary().0.failed.len(), 1);

    let ctl = Ctl::silent();
    ctl.cancelled.store(true, Ordering::Relaxed);
    run_trash("t", &ctl, &trash, vec![b.clone()]);
    let (summary, cancelled) = ctl.summary();
    assert!(cancelled && summary.succeeded == 0 && b.exists());
    f.cleanup().unwrap();
}

#[test]
fn many_failures_are_capped_but_counted() {
    let f = fx("mfm-op-cap");
    let dst = dir(&f, "dst");
    let sources: Vec<PathBuf> = (0..600)
        .map(|n| f.path().join(format!("missing-{n}")))
        .collect();
    let ctl = Ctl::silent();
    transfer(TransferMode::Copy, &ctl, sources, &dst);
    let (summary, _) = ctl.summary();
    assert_eq!(summary.failed.len() as u64 + summary.failed_omitted, 600);
    assert!(summary.failed_omitted > 0);
    f.cleanup().unwrap();
}

#[test]
fn move_replace_keeps_a_source_edited_after_it_was_copied() {
    let f = fx("mfm-op-edit");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "original").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let edited = src.join("a.txt");
    let trash = HookTrash {
        hook: |_: &Path| fs::write(&edited, "new edit not copied").unwrap(),
        inner: FakeTrash::default(),
    };
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Move,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!(read(&src.join("a.txt")), "new edit not copied");
    assert_eq!(read(&dst.join("a.txt")), "original");
    assert_eq!((summary.succeeded, summary.failed.len()), (0, 1));
    assert!(
        summary.failed[0]
            .error
            .message
            .contains("changed after it was copied")
    );
    f.cleanup().unwrap();
}

#[test]
fn move_replace_keeps_a_source_whose_path_was_replaced() {
    let f = fx("mfm-op-swapped");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "original").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let path = src.join("a.txt");
    let trash = HookTrash {
        hook: |_: &Path| {
            fs::remove_file(&path).unwrap();
            fs::write(&path, "original").unwrap();
        },
        inner: FakeTrash::default(),
    };
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Move,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert!(src.join("a.txt").exists(), "a replacement is never deleted");
    assert_eq!((summary.succeeded, summary.failed.len()), (0, 1));
    f.cleanup().unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn cross_volume_cleanup_keeps_changed_children_and_folders_behind_changed_paths() {
    let f = fx("mfm-op-xcleanup");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    let tree = src.join("tree");
    fs::create_dir_all(tree.join("sub")).unwrap();
    fs::write(tree.join("a.txt"), "a").unwrap();
    fs::write(tree.join("sub/b.txt"), "b").unwrap();
    let ctl = Ctl::silent();
    let trash = FakeTrash::default();
    let mut run = Run::new("t", &ctl, &trash, "move");
    let mut copied: Option<Copied> = Some(Vec::new());
    assert_eq!(
        run.copy_node(&tree, &dst.join("tree"), true, &mut copied)
            .unwrap(),
        Node::Done
    );
    // After the copy: one child is edited, and the sub folder is swapped for another.
    fs::write(tree.join("a.txt"), "a, edited").unwrap();
    let moved_aside = src.join("sub-original");
    fs::rename(tree.join("sub"), &moved_aside).unwrap();
    fs::create_dir(tree.join("sub")).unwrap();
    fs::write(tree.join("sub/b.txt"), "someone else's b").unwrap();
    run.remove_copied_sources(copied.unwrap(), 0);
    assert_eq!(read(&tree.join("a.txt")), "a, edited");
    assert_eq!(read(&tree.join("sub/b.txt")), "someone else's b");
    assert_eq!(read(&moved_aside.join("b.txt")), "b");
    assert_eq!(run.succeeded, 0);
    assert!(run.failure_count() >= 2);
    f.cleanup().unwrap();
}

#[test]
fn a_stale_replace_decision_never_trashes_a_directory_that_took_the_name() {
    let f = fx("mfm-op-stale");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let target = dst.join("a.txt");
    let aside = f.path().join("old-a.txt");
    let calls = AtomicUsize::new(0);
    let ctl = Ctl::new(move |prompt| {
        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
            assert_eq!(prompt.destination_kind, EntryKind::File);
            fs::rename(&target, &aside).unwrap();
            fs::create_dir(&target).unwrap();
            fs::write(target.join("sentinel"), "keep me").unwrap();
            Some(Resolution {
                decision: ConflictDecision::Replace,
                apply_to_all: true,
            })
        } else {
            assert_eq!(prompt.destination_kind, EntryKind::Directory);
            Some(Resolution {
                decision: ConflictDecision::Skip,
                apply_to_all: false,
            })
        }
    });
    let trash = FakeTrash::default();
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Copy,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!(
        ctl.prompts.lock().unwrap().len(),
        2,
        "consent was asked again"
    );
    assert_eq!(
        (summary.succeeded, summary.skipped, summary.failed.len()),
        (0, 1, 0)
    );
    assert_eq!(read(&dst.join("a.txt/sentinel")), "keep me");
    assert!(trash.trashed.lock().unwrap().is_empty());
    assert_eq!(read(&f.path().join("old-a.txt")), "old");
    f.cleanup().unwrap();
}

#[test]
fn replacement_consent_does_not_carry_over_to_a_different_file_at_the_name() {
    let f = fx("mfm-op-stale2");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(dst.join("a.txt"), "old").unwrap();
    let target = dst.join("a.txt");
    let aside = f.path().join("old-a.txt");
    let calls = AtomicUsize::new(0);
    let ctl = Ctl::new(move |_| {
        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
            fs::rename(&target, &aside).unwrap();
            fs::write(&target, "someone else's file").unwrap();
            Some(Resolution {
                decision: ConflictDecision::Replace,
                apply_to_all: true,
            })
        } else {
            Some(Resolution {
                decision: ConflictDecision::Skip,
                apply_to_all: false,
            })
        }
    });
    let trash = FakeTrash::default();
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Copy,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!(ctl.prompts.lock().unwrap().len(), 2);
    assert_eq!(summary.skipped, 1);
    assert_eq!(read(&dst.join("a.txt")), "someone else's file");
    assert!(trash.trashed.lock().unwrap().is_empty());
    let leftovers = fs::read_dir(&dst)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".mfm-replace"))
        .count();
    assert_eq!(leftovers, 0);
    f.cleanup().unwrap();
}

#[test]
fn cancelling_a_folder_copy_discloses_the_partly_copied_folder() {
    let mut saw_child = false;
    for countdown in 0..40 {
        let f = fx("mfm-op-partial");
        let src = dir(&f, "src");
        let dst = dir(&f, "dst");
        let tree = src.join("tree");
        fs::create_dir(&tree).unwrap();
        for n in ["a", "b", "c"] {
            fs::write(tree.join(n), n).unwrap();
        }
        let ctl = Ctl::silent();
        ctl.countdown.store(countdown, Ordering::Relaxed);
        transfer(TransferMode::Copy, &ctl, vec![tree.clone()], &dst);
        let (summary, cancelled) = ctl.summary();
        let copy = dst.join("tree");
        if cancelled && copy.exists() {
            assert_eq!(summary.succeeded, 0, "the folder is not counted as done");
            assert_eq!(summary.partial, vec![path_to_id(&copy)]);
            saw_child |= fs::read_dir(&copy).unwrap().count() > 0;
            assert!(tree.join("a").exists(), "the source is untouched");
        } else if !cancelled {
            assert!(summary.partial.is_empty());
        }
        f.cleanup().unwrap();
    }
    assert!(
        saw_child,
        "some run cancelled after a child had been copied"
    );
}

/// Copy + Replace of `a.txt` whose Trash call runs `hook(target)` and is then denied.
fn denied_replace(
    prefix: &str,
    hook: impl Fn(&Path, &Path) + Sync,
) -> (Fixture, PathBuf, PathBuf, TaskSummary) {
    let f = fx(prefix);
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "incoming original").unwrap();
    fs::write(dst.join("a.txt"), "old original").unwrap();
    let target = dst.join("a.txt");
    let aside = f.path().to_path_buf();
    let trash = HookTrash {
        hook: |_: &Path| hook(&target, &aside),
        inner: FakeTrash {
            deny: Some(PathBuf::from("a.txt")),
            ..Default::default()
        },
    };
    let ctl = Ctl::deciding(ConflictDecision::Replace, false);
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Copy,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    (f, src, dst, summary)
}

fn failure_text(summary: &TaskSummary) -> String {
    summary
        .failed
        .iter()
        .map(|f| f.error.message.clone())
        .collect::<Vec<_>>()
        .join(" | ")
}

fn find_holder(dst: &Path) -> Option<PathBuf> {
    fs::read_dir(dst)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().ends_with(".old"))
}

#[test]
fn denied_trash_restores_the_original_and_removes_only_the_unchanged_new_copy() {
    let (f, src, dst, summary) = denied_replace("mfm-op-rb1", |_, _| {});
    assert_eq!((summary.succeeded, summary.failed.len()), (0, 1));
    assert_eq!(read(&dst.join("a.txt")), "old original");
    assert_eq!(read(&src.join("a.txt")), "incoming original");
    assert!(find_holder(&dst).is_none());
    assert_eq!(fs::read_dir(&dst).unwrap().count(), 1, "no leftovers");
    f.cleanup().unwrap();
}

#[test]
fn denied_trash_keeps_edits_made_in_place_to_the_installed_copy() {
    let (f, _, dst, summary) = denied_replace("mfm-op-rb2", |target, _| {
        fs::write(target, "new edits while Trash pending").unwrap();
    });
    assert_eq!(read(&dst.join("a.txt")), "new edits while Trash pending");
    let holder = find_holder(&dst).expect("original kept in its holding folder");
    assert_eq!(read(&holder.join("a.txt")), "old original");
    let text = failure_text(&summary);
    assert!(
        text.contains("changed while it was being replaced") && text.contains(".old"),
        "{text}"
    );
    assert_eq!(summary.succeeded, 0);
    f.cleanup().unwrap();
}

#[test]
fn denied_trash_keeps_an_unrelated_file_that_took_the_name() {
    let (f, _, dst, summary) = denied_replace("mfm-op-rb3", |target, aside| {
        fs::rename(target, aside.join("installed-copy")).unwrap();
        fs::write(target, "unrelated file").unwrap();
    });
    assert_eq!(read(&dst.join("a.txt")), "unrelated file");
    assert_eq!(read(&f.path().join("installed-copy")), "incoming original");
    let holder = find_holder(&dst).unwrap();
    assert_eq!(read(&holder.join("a.txt")), "old original");
    assert!(failure_text(&summary).contains("nothing was deleted"));
    f.cleanup().unwrap();
}

#[test]
fn denied_trash_with_a_vanished_target_puts_the_original_back() {
    let (f, _, dst, summary) =
        denied_replace("mfm-op-rb4", |target, _| fs::remove_file(target).unwrap());
    assert_eq!(read(&dst.join("a.txt")), "old original");
    assert!(find_holder(&dst).is_none());
    assert_eq!(summary.failed.len(), 1);
    f.cleanup().unwrap();
}

#[test]
fn denied_trash_with_a_vanished_target_and_taken_name_reports_the_recovery_location() {
    // The target vanishes and the original cannot come back because a folder now holds the name.
    let (f, _, dst, summary) = denied_replace("mfm-op-rb5", |target, _| {
        fs::remove_file(target).unwrap();
        fs::create_dir(target).unwrap();
        fs::write(target.join("sentinel"), "keep").unwrap();
    });
    assert_eq!(read(&dst.join("a.txt/sentinel")), "keep");
    let holder = find_holder(&dst).unwrap();
    assert_eq!(read(&holder.join("a.txt")), "old original");
    assert!(failure_text(&summary).contains(".old"));
    f.cleanup().unwrap();
}

#[test]
fn a_replace_swap_that_displaces_an_unapproved_item_keeps_everything() {
    let f = fx("mfm-op-rb6");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "incoming original").unwrap();
    fs::write(dst.join("a.txt"), "old original").unwrap();
    let target = dst.join("a.txt");
    let aside = f.path().join("old-a");
    let calls = AtomicUsize::new(0);
    let ctl = Ctl::new(move |_| {
        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
            fs::rename(&target, &aside).unwrap();
            fs::write(&target, "someone else's file").unwrap();
            Some(Resolution {
                decision: ConflictDecision::Replace,
                apply_to_all: false,
            })
        } else {
            Some(Resolution {
                decision: ConflictDecision::Skip,
                apply_to_all: false,
            })
        }
    });
    transfer(TransferMode::Copy, &ctl, vec![src.join("a.txt")], &dst);
    assert_eq!(read(&dst.join("a.txt")), "someone else's file");
    assert_eq!(read(&f.path().join("old-a")), "old original");
    assert_eq!(fs::read_dir(&dst).unwrap().count(), 1);
    f.cleanup().unwrap();
}

#[test]
fn a_source_that_became_a_folder_after_the_file_prompt_is_not_used_for_replace() {
    let f = fx("mfm-op-srcdir");
    let src = dir(&f, "src");
    let dst = dir(&f, "dst");
    fs::write(src.join("a.txt"), "incoming").unwrap();
    fs::write(dst.join("a.txt"), "old original").unwrap();
    let source = src.join("a.txt");
    let aside = f.path().join("a-moved");
    let ctl = Ctl::new(move |prompt| {
        assert_eq!(prompt.source_kind, EntryKind::File);
        assert_eq!(prompt.destination_kind, EntryKind::File);
        fs::rename(&source, &aside).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("sentinel"), "dir child").unwrap();
        Some(Resolution {
            decision: ConflictDecision::Replace,
            apply_to_all: false,
        })
    });
    let trash = FakeTrash::default();
    run_transfer(
        "t",
        &ctl,
        &trash,
        TransferMode::Copy,
        vec![src.join("a.txt")],
        &dst,
    );
    let (summary, _) = ctl.summary();
    assert_eq!((summary.succeeded, summary.failed.len()), (0, 1));
    assert_eq!(read(&dst.join("a.txt")), "old original");
    assert!(trash.trashed.lock().unwrap().is_empty());
    assert_eq!(read(&src.join("a.txt/sentinel")), "dir child");
    assert_eq!(read(&f.path().join("a-moved")), "incoming");
    assert_eq!(fs::read_dir(&dst).unwrap().count(), 1);
    f.cleanup().unwrap();
}
