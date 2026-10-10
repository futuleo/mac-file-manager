//! Native macOS menu bar. Navigation and tab commands are enabled and forwarded to
//! the frontend as `MENU_EVENT` (the Command key equivalents are consumed by the
//! menu, so the page never sees them). Cut/Copy/Paste are forwarded too: the
//! frontend applies them to files, or hands them back through `edit_action` when a
//! text field has focus.

use tauri::{
    AppHandle, Emitter, Manager, Wry,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::contracts::MENU_EVENT;

/// Menu item ids the frontend acts on (see `src/App.tsx`).
const FORWARDED: [&str; 21] = [
    "new-tab",
    "close-tab",
    "next-tab",
    "previous-tab",
    "open",
    "select-all",
    "refresh",
    "back",
    "forward",
    "enclosing-folder",
    "home",
    "address",
    "hidden-items",
    "new-folder",
    "copy",
    "cut",
    "paste",
    "rename",
    "trash",
    "search",
    "quick-look",
];

pub fn forward(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == "close-window" {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.close();
        }
    } else if FORWARDED.contains(&id) {
        let _ = app.emit_to("main", MENU_EVENT, id);
    }
}

fn enabled(
    app: &AppHandle,
    id: &str,
    text: &str,
    accelerator: &str,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, true, Some(accelerator))
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "File Manager",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &enabled(app, "new-tab", "New Tab", "CmdOrCtrl+T")?,
            &enabled(app, "new-folder", "New Folder", "Shift+CmdOrCtrl+N")?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "open", "Open", "CmdOrCtrl+O")?,
            &MenuItem::with_id(app, "rename", "Rename", true, None::<&str>)?,
            &MenuItem::with_id(app, "quick-look", "Quick Look", true, None::<&str>)?,
            &enabled(app, "trash", "Move to Trash", "CmdOrCtrl+Backspace")?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "close-tab", "Close Tab", "CmdOrCtrl+W")?,
            &enabled(app, "close-window", "Close Window", "Shift+CmdOrCtrl+W")?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "cut", "Cut", "CmdOrCtrl+X")?,
            &enabled(app, "copy", "Copy", "CmdOrCtrl+C")?,
            &enabled(app, "paste", "Paste", "CmdOrCtrl+V")?,
            &enabled(app, "select-all", "Select All", "CmdOrCtrl+A")?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "search", "Search This Folder", "CmdOrCtrl+F")?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &enabled(app, "refresh", "Refresh", "CmdOrCtrl+R")?,
            &enabled(
                app,
                "hidden-items",
                "Show or Hide Hidden Items",
                "Shift+CmdOrCtrl+.",
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &enabled(app, "back", "Back", "CmdOrCtrl+[")?,
            &enabled(app, "forward", "Forward", "CmdOrCtrl+]")?,
            &enabled(app, "enclosing-folder", "Enclosing Folder", "CmdOrCtrl+Up")?,
            &enabled(app, "home", "Home", "Shift+CmdOrCtrl+H")?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "address", "Go to Folder…", "CmdOrCtrl+L")?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "next-tab", "Show Next Tab", "Shift+CmdOrCtrl+]")?,
            &enabled(
                app,
                "previous-tab",
                "Show Previous Tab",
                "Shift+CmdOrCtrl+[",
            )?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window])
}
