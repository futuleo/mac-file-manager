//! Native macOS menu bar. Navigation and tab commands are enabled and forwarded to
//! the frontend as `MENU_EVENT` (the Command key equivalents are consumed by the
//! menu, so the page never sees them). Commands that later slices implement are
//! present with their standard shortcuts but disabled, so nothing pretends to work.

use tauri::{
    AppHandle, Emitter, Manager, Wry,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::contracts::MENU_EVENT;

/// Menu item ids the frontend acts on (see `src/App.tsx`).
const FORWARDED: [&str; 13] = [
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

fn planned(
    app: &AppHandle,
    id: &str,
    text: &str,
    accelerator: &str,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, false, Some(accelerator))
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
            &planned(app, "new-folder", "New Folder", "Shift+CmdOrCtrl+N")?,
            &PredefinedMenuItem::separator(app)?,
            &enabled(app, "open", "Open", "CmdOrCtrl+O")?,
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
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &enabled(app, "select-all", "Select All", "CmdOrCtrl+A")?,
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
