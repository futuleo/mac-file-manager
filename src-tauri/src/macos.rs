//! Native macOS bridge. Uses `objc2` bindings to AppKit/Foundation/QuickLookUI;
//! see README "Native API findings" for why and for the verified behavior.

use std::{
    ffi::CString,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
};

use objc2::{
    ClassType,
    rc::{Retained, autoreleasepool},
    runtime::AnyClass,
};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImageRep, NSWorkspace};
use objc2_foundation::{NSDictionary, NSFileManager, NSProcessInfo, NSString, NSURL};
use objc2_quick_look_ui::QLPreviewPanel;

use crate::contracts::{AppError, ErrorCategory, NativeCapabilities, display_name};

/// macOS version as `major.minor.patch`.
pub fn os_version() -> String {
    let v = NSProcessInfo::processInfo().operatingSystemVersion();
    format!("{}.{}.{}", v.majorVersion, v.minorVersion, v.patchVersion)
}

fn class_available(name: &std::ffi::CStr) -> bool {
    AnyClass::get(name).is_some()
}

pub fn capabilities() -> NativeCapabilities {
    // Referencing the class forces QuickLookUI.framework to be loaded.
    let _ = QLPreviewPanel::class();
    NativeCapabilities {
        spotlight_query: class_available(c"NSMetadataQuery"),
        quick_look_panel: class_available(c"QLPreviewPanel"),
        trash: class_available(c"NSFileManager"),
        system_icons: class_available(c"NSWorkspace"),
        drag_session: class_available(c"NSDraggingSession"),
    }
}

/// File URL built from the raw path bytes, so non-UTF-8 names stay addressable.
fn file_url(path: &Path) -> Option<Retained<NSURL>> {
    file_url_with(path, false)
}

pub(crate) fn file_url_with(path: &Path, is_directory: bool) -> Option<Retained<NSURL>> {
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let ptr = std::ptr::NonNull::new(c_path.as_ptr() as *mut _)?;
    // SAFETY: `ptr` is a valid NUL-terminated string that outlives the call;
    // the method copies it.
    Some(unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            ptr,
            is_directory,
            None,
        )
    })
}

/// Application LaunchServices would use to open `path`, without launching it.
#[cfg(test)]
pub fn default_application(path: &Path) -> Option<String> {
    let url = file_url(path)?;
    let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url)?;
    Some(app.path()?.to_string())
}

/// Opens `path` with its default application. Must run on the main thread
/// (AppKit). `Ok(false)` means LaunchServices declined to open it.
#[allow(deprecated)] // the synchronous `openURL:` is the only variant that reports success
pub fn open_with_default_app(path: &Path) -> Option<bool> {
    let url = file_url(path)?;
    Some(NSWorkspace::sharedWorkspace().openURL(&url))
}

/// Moves `path` to the user's Trash through `NSFileManager`, which keeps the item
/// restorable (never a permanent delete). Returns where it ended up in the Trash.
pub fn trash_item(path: &Path) -> Result<Option<PathBuf>, AppError> {
    let operation = "move to the Trash";
    let is_dir = std::fs::symlink_metadata(path)
        .map_err(|e| AppError::from_io(operation, path, &e))?
        .is_dir();
    let name = display_name(path);
    let url = file_url_with(path, is_dir).ok_or_else(|| {
        AppError::new(
            ErrorCategory::InvalidInput,
            operation,
            Some(name.clone()),
            format!("\"{name}\" has a path that cannot be moved to the Trash."),
        )
    })?;
    autoreleasepool(|_| {
        let mut resulting: Option<Retained<NSURL>> = None;
        match NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        {
            Ok(()) => Ok(resulting
                .and_then(|u| u.path())
                .map(|p| PathBuf::from(p.to_string()))),
            Err(error) => {
                // NSFileNoSuchFileError = 4, NSFileWriteNoPermissionError = 513.
                let category = match error.code() {
                    4 => ErrorCategory::NotFound,
                    513 => ErrorCategory::PermissionDenied,
                    _ => ErrorCategory::Io,
                };
                Err(AppError::new(
                    category,
                    operation,
                    Some(name.clone()),
                    format!(
                        "Could not move \"{name}\" to the Trash: {}",
                        error.localizedDescription()
                    ),
                ))
            }
        }
    })
}

/// Sends a standard editing action to the first responder, exactly as the
/// native Edit menu does, so text fields keep native copy/cut/paste/select-all.
/// Must run on the main thread.
pub fn send_edit_action(action: &str) -> bool {
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::NSApplication;
    let selector = match action {
        "copy" => sel!(copy:),
        "cut" => sel!(cut:),
        "paste" => sel!(paste:),
        "selectAll" => sel!(selectAll:),
        _ => return false,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // SAFETY: the selectors are the standard NSResponder editing actions and no
    // sender or target is passed.
    unsafe { NSApplication::sharedApplication(mtm).sendAction_to_from(selector, None, None) }
}

/// PNG of the system icon for `path`, using the representation closest to
/// `pixels` (the smallest one that is at least that large). Only UTF-8 paths are
/// supported because `iconForFile:` takes an `NSString`.
pub fn icon_png(path: &Path, pixels: u32) -> Result<Vec<u8>, String> {
    let path_str = path
        .to_str()
        .ok_or("icons are not available for names that are not valid UTF-8")?;
    // Background worker threads have no Cocoa autorelease pool, so one is created
    // per call; everything autoreleased by AppKit is drained when it ends. The PNG
    // is copied into an owned Vec before the pool is left.
    autoreleasepool(|_| {
        let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path_str));
        let tiff = image
            .TIFFRepresentation()
            .ok_or("the icon has no bitmap data")?;
        let reps = NSBitmapImageRep::imageRepsWithData(&tiff);
        let want = pixels as isize;
        let rep: Retained<NSImageRep> = reps
            .iter()
            .filter(|r| r.pixelsWide() >= want)
            .min_by_key(|r| r.pixelsWide())
            .or_else(|| reps.iter().max_by_key(|r| r.pixelsWide()))
            .ok_or("the icon has no representations")?;
        let bitmap = rep
            .downcast::<NSBitmapImageRep>()
            .map_err(|_| "unsupported icon representation")?;
        // SAFETY: an empty properties dictionary is valid for PNG encoding.
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or("PNG encoding failed")?;
        Ok(png.to_vec())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spike_fixture::Fixture;

    #[test]
    fn icons_are_png_sized_near_the_request_and_lazy_per_call() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-icon-test").unwrap();
        let file = fx.write("a.txt", "x").unwrap();
        let small = icon_png(&file, 16).unwrap();
        let large = icon_png(&file, 128).unwrap();
        assert_eq!(&small[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&large[..8], b"\x89PNG\r\n\x1a\n");
        // PNG IHDR width is at bytes 16..20.
        let width = |b: &[u8]| u32::from_be_bytes(b[16..20].try_into().unwrap());
        assert!(width(&small) >= 16 && width(&small) < width(&large));
        assert!(width(&large) >= 128);
        let dir_icon = icon_png(fx.path(), 32).unwrap();
        assert_eq!(&dir_icon[..4], b"\x89PNG");
        fx.cleanup().unwrap();
    }

    #[test]
    fn repeated_icon_rendering_on_one_background_thread_stays_valid() {
        // Bounded functional check of the per-call autorelease pool on a reused
        // worker thread; it does not measure memory growth.
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-icon-loop").unwrap();
        let file = fx.write("a.txt", "x").unwrap();
        let dir = fx.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            for i in 0..300u32 {
                let target = if i % 2 == 0 { &file } else { &dir };
                let png = icon_png(target, [16, 32, 64][(i % 3) as usize]).unwrap();
                assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
            }
        });
        worker.join().unwrap();
        fx.cleanup().unwrap();
    }

    #[test]
    fn icons_reject_non_utf8_paths() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let path = Path::new(&OsString::from_vec(b"/tmp/\xff".to_vec())).to_path_buf();
        assert!(icon_png(&path, 16).is_err());
    }

    #[test]
    fn default_application_lookup_does_not_launch_anything() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-open-test").unwrap();
        let file = fx.write("note.txt", "x").unwrap();
        let app = default_application(&file).expect("a default app for .txt");
        assert!(app.ends_with(".app"), "{app}");
        // File URLs from raw bytes: invalid UTF-8 and NUL.
        assert!(file_url(Path::new(std::ffi::OsStr::from_bytes(b"/tmp/\xff"))).is_some());
        assert!(file_url(Path::new(std::ffi::OsStr::from_bytes(b"/tmp/a\0b"))).is_none());
        fx.cleanup().unwrap();
    }

    #[test]
    fn trashing_moves_an_owned_fixture_to_the_trash_and_is_restorable() {
        let fx = Fixture::create_in(&std::env::temp_dir(), "mfm-trash-test").unwrap();
        let file = fx.write("victim.txt", "payload").unwrap();
        let dir = fx.path().join("folder");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("inner.txt"), "inner").unwrap();
        let file_result = trash_item(&file).unwrap().expect("resulting location");
        let dir_result = trash_item(&dir).unwrap().expect("resulting location");
        assert!(!file.exists() && !dir.exists());
        // The item is in the Trash (recoverable), not deleted.
        assert_eq!(std::fs::read_to_string(&file_result).unwrap(), "payload");
        assert_eq!(
            std::fs::read_to_string(dir_result.join("inner.txt")).unwrap(),
            "inner"
        );
        // Only the items this test trashed are removed from the Trash again.
        std::fs::remove_file(&file_result).unwrap();
        std::fs::remove_dir_all(&dir_result).unwrap();
        let missing = trash_item(&fx.path().join("missing")).unwrap_err();
        assert_eq!(missing.category, ErrorCategory::NotFound);
        fx.cleanup().unwrap();
    }

    #[test]
    fn native_classes_are_available_on_this_machine() {
        let caps = super::capabilities();
        assert!(caps.spotlight_query && caps.quick_look_panel);
        assert!(caps.trash && caps.system_icons && caps.drag_session);
        assert!(super::os_version().split('.').count() == 3);
    }
}
