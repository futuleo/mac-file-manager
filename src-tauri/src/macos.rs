//! Native macOS bridge. Uses `objc2` bindings to AppKit/Foundation/QuickLookUI;
//! see README "Native API findings" for why and for the verified behavior.

use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};

use objc2::{
    ClassType,
    rc::{Retained, autoreleasepool},
    runtime::AnyClass,
};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImageRep, NSWorkspace};
use objc2_foundation::{NSDictionary, NSProcessInfo, NSString, NSURL};
use objc2_quick_look_ui::QLPreviewPanel;

use crate::contracts::NativeCapabilities;

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
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let ptr = std::ptr::NonNull::new(c_path.as_ptr() as *mut _)?;
    // SAFETY: `ptr` is a valid NUL-terminated string that outlives the call;
    // the method copies it.
    Some(unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(ptr, false, None)
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
    fn native_classes_are_available_on_this_machine() {
        let caps = super::capabilities();
        assert!(caps.spotlight_query && caps.quick_look_panel);
        assert!(caps.trash && caps.system_icons && caps.drag_session);
        assert!(super::os_version().split('.').count() == 3);
    }
}
