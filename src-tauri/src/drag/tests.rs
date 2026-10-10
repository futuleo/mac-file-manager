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

#[test]
fn modifier_masks_choose_operations() {
    assert_eq!(Mask::from_bits(1 | 16), BOTH);
    assert_eq!(Mask::from_bits(2 | 4 | 8), Mask::default());
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

    let ok = state.hover(id, Some(dst.clone())).unwrap();
    assert_eq!(ok.operation, Some(TransferMode::Move));
    assert_eq!(state.operation(id), Some(TransferMode::Move));

    for bad in [
        src.clone(),
        src.join("child"),
        file.clone(),
        root.join("missing"),
    ] {
        let hover = state.hover(id, Some(bad)).unwrap();
        assert_eq!(hover.operation, None);
        assert!(hover.reason.is_some());
        assert_eq!(state.accept(id), None);
    }
    let none = state.hover(id, None).unwrap();
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
    state.hover(id, Some(dst.clone())).unwrap();
    assert_eq!(state.accept(id), Some(TransferMode::Copy));
    assert!(state.take_drop(id + 1).is_err());
    let pending = state.take_drop(id).unwrap();
    assert_eq!(
        pending,
        PendingDrop {
            sources: vec![a.clone()],
            destination: dst.clone(),
            mode: TransferMode::Copy
        }
    );
    assert!(state.take_drop(id).is_err());

    // A newer drag invalidates an older accepted one.
    let old = state.enter(vec![a.clone()], false, COPY);
    state.hover(old, Some(dst.clone())).unwrap();
    state.accept(old);
    let _new = state.enter(vec![a], false, COPY);
    assert!(state.take_drop(old).is_err());
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
    state.hover(id, Some(dst)).unwrap();
    state.accept(id);
    assert_eq!(state.take_drop(id).unwrap().sources, vec![odd.clone()]);
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
