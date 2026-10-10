use std::{ffi::OsStr, fs, os::unix::ffi::OsStrExt, path::PathBuf};

use super::*;

fn fixture(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mfm-drag-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

const COPY: Mask = Mask {
    copy: true,
    moving: false,
};
const MOVE: Mask = Mask {
    copy: false,
    moving: true,
};
const BOTH: Mask = Mask {
    copy: true,
    moving: true,
};

/// One pointer update followed by a settled hover request.
fn settle(state: &DragState, id: u64, token: u64, dest: Option<PathBuf>) -> Hover {
    let pointer = state.moved(id);
    state.hover(id, pointer, token, dest).unwrap()
}

#[test]
fn modifier_masks_choose_operations() {
    assert_eq!(Mask::from_bits(1 | 16), BOTH);
    assert_eq!(Mask::from_bits(2 | 8), Mask::default());
    // Finder's mask while Command is held is generic alone; its default mask is 55.
    assert_eq!(Mask::from_bits(4), MOVE);
    assert_eq!(Mask::from_bits(55), BOTH);
    assert_eq!(Mask::from_bits(1), COPY);
    assert_eq!(Mask::from_bits(4 | 1), COPY);
    assert_eq!(choose_operation(COPY, true), Some(TransferMode::Copy));
    assert_eq!(choose_operation(MOVE, false), Some(TransferMode::Move));
    assert_eq!(choose_operation(BOTH, true), Some(TransferMode::Move));
    assert_eq!(choose_operation(BOTH, false), Some(TransferMode::Copy));
    assert_eq!(choose_operation(Mask::default(), true), None);
}

#[test]
fn hover_validates_destinations() {
    let root = fixture("hover");
    let (src, dst, file) = (root.join("src"), root.join("dst"), root.join("f.txt"));
    fs::create_dir_all(src.join("child")).unwrap();
    fs::create_dir(&dst).unwrap();
    fs::write(&file, "x").unwrap();
    let state = DragState::default();
    let id = state.enter(vec![src.clone()], false, BOTH);

    let ok = settle(&state, id, 1, Some(dst.clone()));
    assert_eq!(ok.operation, Some(TransferMode::Move));
    assert_eq!(state.operation(id), Some(TransferMode::Move));

    let mut token = 1;
    for bad in [
        src.clone(),
        src.join("child"),
        file.clone(),
        root.join("missing"),
    ] {
        token += 1;
        let hover = settle(&state, id, token, Some(bad));
        assert_eq!(hover.operation, None);
        assert!(hover.reason.is_some());
        assert_eq!(state.accept(id), None);
    }
    let none = settle(&state, id, 10, None);
    assert_eq!(none.operation, None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn drop_runs_once_and_stale_ids_are_refused() {
    let root = fixture("once");
    let (a, dst) = (root.join("a.txt"), root.join("dst"));
    fs::write(&a, "a").unwrap();
    fs::create_dir(&dst).unwrap();
    let state = DragState::default();
    let id = state.enter(vec![a.clone()], false, COPY);
    settle(&state, id, 1, Some(dst.clone()));
    assert_eq!(state.accept(id), Some((TransferMode::Copy, 1)));
    assert!(state.take_drop(id + 1, 1, &dst).is_err());
    let pending = state.take_drop(id, 1, &dst).unwrap();
    assert_eq!(
        pending,
        PendingDrop {
            sources: vec![a.clone()],
            destination: dst.clone(),
            mode: TransferMode::Copy
        }
    );
    assert!(state.take_drop(id, 1, &dst).is_err());

    // A newer drag invalidates an older accepted one.
    let old = state.enter(vec![a.clone()], false, COPY);
    settle(&state, old, 1, Some(dst.clone()));
    state.accept(old);
    let _new = state.enter(vec![a], false, COPY);
    assert!(state.take_drop(old, 1, &dst).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn drop_without_a_verdict_is_not_accepted() {
    let root = fixture("noverdict");
    let a = root.join("a");
    fs::write(&a, "a").unwrap();
    let state = DragState::default();
    let id = state.enter(vec![a], false, BOTH);
    assert_eq!(state.accept(id), None);
    state.leave(id);
    assert_eq!(state.accept(id), None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn non_utf8_paths_stay_lossless() {
    let root = fixture("bytes");
    let name = OsStr::from_bytes(b"caf\xe9-\xff.txt");
    let odd = root.join(name);
    if fs::write(&odd, "x").is_err() {
        fs::remove_dir_all(root).unwrap();
        return; // the filesystem rejects non-UTF-8 names
    }
    let dst = root.join("dst");
    fs::create_dir(&dst).unwrap();
    let state = DragState::default();
    let id = state.enter(vec![odd.clone()], false, COPY);
    settle(&state, id, 1, Some(dst.clone()));
    state.accept(id);
    assert_eq!(
        state.take_drop(id, 1, &dst).unwrap().sources,
        vec![odd.clone()]
    );
    let ids = [path_to_id(&odd)];
    assert_eq!(resolve_sources(&ids).unwrap(), vec![odd]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn outbound_outcomes_never_claim_more_than_known() {
    let root = fixture("out");
    let a = root.join("a");
    fs::write(&a, "a").unwrap();
    let state = DragState::default();
    for (bits, want) in [
        (0, SourceOutcome::Cancelled),
        (1, SourceOutcome::HandedOffCopy),
        (16, SourceOutcome::HandedOffMove),
        (2, SourceOutcome::Unexpected),
    ] {
        state.begin_outbound(vec![a.clone()]);
        match state.end_outbound(bits) {
            Some(DragEvent::SourceEnded { outcome, count, .. }) => {
                assert_eq!((outcome, count), (want, 1));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(state.end_outbound(bits).is_none());
    }
    state.begin_outbound(vec![a.clone()]);
    state.mark_handled_here();
    assert!(matches!(
        state.end_outbound(16),
        Some(DragEvent::SourceEnded {
            outcome: SourceOutcome::HandledHere,
            ..
        })
    ));
    state.begin_outbound(vec![a]);
    state.abandon_outbound();
    assert!(state.end_outbound(1).is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn resolve_sources_rejects_bad_input() {
    assert!(resolve_sources(&[]).is_err());
    assert!(resolve_sources(&["zz".to_string()]).is_err());
    assert!(resolve_sources(&[path_to_id(std::path::Path::new("/definitely/missing/x"))]).is_err());
}

fn two_folders(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let root = fixture(name);
    let (a, b, file) = (root.join("A"), root.join("B"), root.join("f.txt"));
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(&file, "x").unwrap();
    (root, a, b, file)
}

#[test]
fn a_pending_hover_voids_the_previous_target() {
    let (root, a, b, file) = two_folders("pending");
    let state = DragState::default();
    let id = state.enter(vec![file], false, BOTH);
    settle(&state, id, 1, Some(a.clone()));
    // Pointer moves to B and B's validation is still running when the drop arrives.
    let pointer = state.moved(id);
    let paths = state.begin_hover(id, 2).unwrap();
    assert_eq!(state.accept(id), None, "A's verdict must not carry over");
    // The late answer cannot revive anything for a refused drop either.
    let verdict = evaluate(&paths, b.clone());
    state.finish_hover(id, pointer, 2, Some(verdict)).unwrap();
    assert_eq!(state.accept(id), Some((TransferMode::Move, 2)));
    assert_eq!(
        state.take_drop(id, 2, &a).unwrap_err().category,
        ErrorCategory::InvalidInput
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reordered_hover_completions_cannot_overwrite_the_newer_target() {
    let (root, a, b, file) = two_folders("reorder");
    let state = DragState::default();
    let id = state.enter(vec![file], false, BOTH);
    let p1 = state.moved(id);
    let paths = state.begin_hover(id, 1).unwrap();
    let old = evaluate(&paths, a.clone());
    let p2 = state.moved(id);
    state.begin_hover(id, 2).unwrap();
    // The older request finishes after the newer one started: refused, stores nothing.
    assert!(state.finish_hover(id, p1, 1, Some(old)).is_err());
    assert_eq!(state.accept(id), None);
    let fresh = evaluate(&paths, b.clone());
    state.finish_hover(id, p2, 2, Some(fresh)).unwrap();
    // Finishing the newer one first, then the older, also keeps the newer verdict.
    assert!(state.begin_hover(id, 1).is_err());
    assert_eq!(state.accept(id), Some((TransferMode::Move, 2)));
    let pending = state.take_drop(id, 2, &b).unwrap();
    assert_eq!(pending.destination, b);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_verdict_for_an_earlier_pointer_update_is_not_accepted() {
    let (root, a, _b, file) = two_folders("pointer");
    let state = DragState::default();
    let id = state.enter(vec![file], false, BOTH);
    settle(&state, id, 1, Some(a.clone()));
    state.moved(id);
    assert_eq!(state.accept(id), None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn claims_must_match_the_accepted_token_and_destination() {
    let (root, a, b, file) = two_folders("claim");
    let state = DragState::default();
    for (token, dest) in [(7, &a), (1, &b)] {
        let id = state.enter(vec![file.clone()], false, BOTH);
        settle(&state, id, 1, Some(a.clone()));
        assert!(state.accept(id).is_some());
        assert!(state.take_drop(id, token, dest).is_err());
        // The failed claim consumed the drop: nothing can be retried with other values.
        assert!(state.take_drop(id, 1, &a).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}
