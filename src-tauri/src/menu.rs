//! Native menus laid out like Typora's. Items that act on the document are forwarded to
//! the focused window as a `menu` event carrying the item id (see web/src/editor/commands.ts).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_dialog::DialogExt;

use crate::library::Recent;
use crate::settings::Store;
use crate::themes::{self, Source};
use crate::windows;

type Item<'a> = (&'a str, &'a str, Option<&'a str>);

const FILE_TOP: &[Item] = &[
    ("new", "New", Some("CmdOrCtrl+N")),
    ("open", "Open…", Some("CmdOrCtrl+O")),
    ("open-folder", "Open Folder…", None),
    ("quick-open", "Open Quickly…", Some("CmdOrCtrl+Shift+O")),
];

/// Saving, after File › Open Recent.
const FILE_SAVE: &[Item] = &[
    ("-", "", None),
    ("save", "Save", Some("CmdOrCtrl+S")),
    ("save-as", "Save As…", Some("CmdOrCtrl+Shift+S")),
    ("reload", "Reload from Disk", None),
    ("-", "", None),
];

/// File › Export, in Typora's order.
const EXPORT: &[Item] = &[
    ("export-pdf", "PDF", None),
    ("export-html", "HTML", None),
    ("export-html-plain", "HTML (without styles)", None),
    ("-", "", None),
    ("export-docx", "Word (.docx)", None),
    ("export-odt", "OpenOffice", None),
    ("export-rtf", "RTF", None),
    ("export-epub", "Epub", None),
    ("export-latex", "LaTeX", None),
    ("export-mediawiki", "Media Wiki", None),
    ("export-rst", "reStructuredText", None),
    ("export-textile", "Textile", None),
    ("export-opml", "OPML", None),
];

const FILE_BOTTOM: &[Item] = &[
    ("print", "Print…", Some("CmdOrCtrl+P")),
    ("-", "", None),
    ("close", "Close", Some("CmdOrCtrl+W")),
];

const EDIT_TOP: &[Item] = &[
    ("undo", "Undo", Some("CmdOrCtrl+Z")),
    ("redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
];

/// Edit › Find and Replace.
const FIND: &[Item] = &[
    ("find", "Find…", Some("CmdOrCtrl+F")),
    ("find-next", "Find Next", Some("CmdOrCtrl+G")),
    ("find-previous", "Find Previous", Some("CmdOrCtrl+Shift+G")),
    ("-", "", None),
    ("replace", "Replace…", Some("CmdOrCtrl+Alt+F")),
];

const PARAGRAPH: &[Item] = &[
    ("heading-1", "Heading 1", Some("CmdOrCtrl+1")),
    ("heading-2", "Heading 2", Some("CmdOrCtrl+2")),
    ("heading-3", "Heading 3", Some("CmdOrCtrl+3")),
    ("heading-4", "Heading 4", Some("CmdOrCtrl+4")),
    ("heading-5", "Heading 5", Some("CmdOrCtrl+5")),
    ("heading-6", "Heading 6", Some("CmdOrCtrl+6")),
    ("-", "", None),
    ("paragraph", "Paragraph", Some("CmdOrCtrl+0")),
    ("-", "", None),
    ("heading-up", "Increase Heading Level", Some("CmdOrCtrl+=")),
    (
        "heading-down",
        "Decrease Heading Level",
        Some("CmdOrCtrl+-"),
    ),
    ("-", "", None),
    ("table", "Table", Some("CmdOrCtrl+Alt+T")),
    ("code-fence", "Code Fences", Some("CmdOrCtrl+Alt+C")),
    ("math-block", "Math Block", Some("CmdOrCtrl+Alt+B")),
    ("-", "", None),
    ("quote", "Quote", Some("CmdOrCtrl+Alt+Q")),
    ("-", "", None),
    ("ordered-list", "Ordered List", Some("CmdOrCtrl+Alt+O")),
    ("bullet-list", "Unordered List", Some("CmdOrCtrl+Alt+U")),
    ("task-list", "Task List", Some("CmdOrCtrl+Alt+X")),
    ("-", "", None),
    ("hr", "Horizontal Line", Some("CmdOrCtrl+Alt+-")),
    ("toc", "Table of Contents", None),
];

const FORMAT: &[Item] = &[
    ("strong", "Strong", Some("CmdOrCtrl+B")),
    ("em", "Emphasis", Some("CmdOrCtrl+I")),
    ("code", "Code", Some("Ctrl+`")),
    ("strike", "Strike", Some("Ctrl+Shift+`")),
    ("highlight", "Highlight", Some("CmdOrCtrl+Shift+H")),
    ("-", "", None),
    ("link", "Hyperlink", Some("CmdOrCtrl+K")),
    ("-", "", None),
    ("clear-format", "Clear Format", Some("CmdOrCtrl+\\")),
];

const VIEW: &[Item] = &[
    ("source-mode", "Source Code Mode", Some("CmdOrCtrl+/")),
    ("-", "", None),
    (
        "toggle-sidebar",
        "Toggle Sidebar",
        Some("CmdOrCtrl+Shift+L"),
    ),
    ("outline", "Outline", Some("Ctrl+Cmd+1")),
    ("articles", "Articles", Some("Ctrl+Cmd+2")),
    ("file-tree", "File Tree", Some("Ctrl+Cmd+3")),
    ("search", "Search", Some("CmdOrCtrl+Shift+F")),
    ("-", "", None),
    ("focus-mode", "Focus Mode", Some("F8")),
    ("typewriter-mode", "Typewriter Mode", Some("F9")),
    ("-", "", None),
    ("word-count", "Show Status Bar", None),
];

fn items<R: Runtime>(
    app: &AppHandle<R>,
    list: &[Item],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<R>>>> {
    let mut out: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = Vec::new();
    for (id, label, accel) in list {
        if *id == "-" {
            out.push(Box::new(PredefinedMenuItem::separator(app)?));
        } else {
            out.push(Box::new(MenuItem::with_id(app, *id, *label, true, *accel)?));
        }
    }
    Ok(out)
}

fn submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    list: Vec<Box<dyn tauri::menu::IsMenuItem<R>>>,
) -> tauri::Result<Submenu<R>> {
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = list.iter().map(|b| b.as_ref()).collect();
    Submenu::with_items(app, title, true, &refs)
}

pub fn build(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let app_menu = submenu(
        app,
        "Marpora",
        vec![
            Box::new(PredefinedMenuItem::about(app, Some("About Marpora"), None)?),
            Box::new(PredefinedMenuItem::separator(app)?),
            Box::new(MenuItem::with_id(
                app,
                "preferences",
                "Preferences…",
                true,
                Some("CmdOrCtrl+,"),
            )?),
            Box::new(PredefinedMenuItem::separator(app)?),
            Box::new(PredefinedMenuItem::services(app, None)?),
            Box::new(PredefinedMenuItem::separator(app)?),
            Box::new(PredefinedMenuItem::hide(app, None)?),
            Box::new(PredefinedMenuItem::hide_others(app, None)?),
            Box::new(PredefinedMenuItem::show_all(app, None)?),
            Box::new(PredefinedMenuItem::separator(app)?),
            // Not the predefined item: windows with unsaved edits ask first.
            Box::new(MenuItem::with_id(
                app,
                "quit",
                "Quit Marpora",
                true,
                Some("CmdOrCtrl+Q"),
            )?),
        ],
    )?;

    let mut file = items(app, FILE_TOP)?;
    file.push(Box::new(Submenu::with_id_and_items(
        app,
        "open-recent",
        "Open Recent",
        true,
        &recent_items(app)?
            .iter()
            .map(|b| b.as_ref())
            .collect::<Vec<_>>(),
    )?));
    file.extend(items(app, FILE_SAVE)?);
    file.push(Box::new(submenu(app, "Export", items(app, EXPORT)?)?));
    file.extend(items(app, FILE_BOTTOM)?);

    let mut edit = items(app, EDIT_TOP)?;
    edit.push(Box::new(PredefinedMenuItem::separator(app)?));
    // Clipboard and selection go to the webview natively; ProseMirror handles the events.
    edit.push(Box::new(PredefinedMenuItem::cut(app, None)?));
    edit.push(Box::new(PredefinedMenuItem::copy(app, None)?));
    edit.push(Box::new(PredefinedMenuItem::paste(app, None)?));
    edit.push(Box::new(PredefinedMenuItem::select_all(app, None)?));
    edit.push(Box::new(PredefinedMenuItem::separator(app)?));
    edit.push(Box::new(submenu(
        app,
        "Find and Replace",
        items(app, FIND)?,
    )?));

    let current = app.state::<Store>().get().theme;
    let mut theme_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    let mut last_source = Source::Bundled;
    for theme in themes::list(app) {
        if theme.source != last_source {
            last_source = theme.source;
            theme_items.push(Box::new(PredefinedMenuItem::separator(app)?));
            if theme.source == Source::Typora {
                theme_items.push(Box::new(MenuItem::new(
                    app,
                    "From Typora",
                    false,
                    None::<&str>,
                )?));
            }
        }
        theme_items.push(Box::new(CheckMenuItem::with_id(
            app,
            format!("theme:{}", theme.id),
            &theme.name,
            true,
            theme.id == current,
            None::<&str>,
        )?));
    }

    let window = submenu(
        app,
        "Window",
        vec![
            Box::new(PredefinedMenuItem::minimize(app, None)?),
            Box::new(PredefinedMenuItem::maximize(app, None)?),
            Box::new(PredefinedMenuItem::separator(app)?),
            Box::new(PredefinedMenuItem::fullscreen(app, None)?),
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &Submenu::with_id_and_items(
                app,
                "file",
                "File",
                true,
                &file.iter().map(|b| b.as_ref()).collect::<Vec<_>>(),
            )?,
            &submenu(app, "Edit", edit)?,
            &submenu(app, "Paragraph", items(app, PARAGRAPH)?)?,
            &submenu(app, "Format", items(app, FORMAT)?)?,
            &submenu(app, "View", items(app, VIEW)?)?,
            &Submenu::with_id_and_items(
                app,
                "themes",
                "Themes",
                true,
                &theme_items.iter().map(|b| b.as_ref()).collect::<Vec<_>>(),
            )?,
            &window,
        ],
    )
}

/// File › Open Recent: recent files by name, then Clear Items.
fn recent_items(app: &AppHandle) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>> {
    let files = app.state::<Recent>().files();
    let mut out: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    for path in &files {
        let name = windows::title_for(Some(Path::new(path)));
        out.push(Box::new(MenuItem::with_id(
            app,
            format!("recent:{path}"),
            name,
            true,
            None::<&str>,
        )?));
    }
    if !files.is_empty() {
        out.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    out.push(Box::new(MenuItem::with_id(
        app,
        "recent-clear",
        "Clear Items",
        !files.is_empty(),
        None::<&str>,
    )?));
    Ok(out)
}

/// Rebuild File › Open Recent after the recent files changed.
pub fn refresh_recent(app: &AppHandle) {
    let Some(MenuItemKind::Submenu(file)) = app.menu().and_then(|m| m.get("file")) else {
        return;
    };
    let Some(MenuItemKind::Submenu(recent)) = file.get("open-recent") else {
        return;
    };
    for item in recent.items().unwrap_or_default() {
        let _ = recent.remove(&item);
    }
    for item in recent_items(app).unwrap_or_default() {
        let _ = recent.append(item.as_ref());
    }
}

pub fn handle(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            let _ = windows::open(app, None);
        }
        "quit" => quit(app),
        "preferences" => {
            let _ = windows::open_preferences(app);
        }
        "open-folder" => {
            let handle = app.clone();
            app.dialog().file().pick_folder(move |dir| {
                if let Some(dir) = dir.and_then(|d| d.into_path().ok()) {
                    let _ = windows::open_folder(&handle, dir);
                }
            });
        }
        "recent-clear" => {
            app.state::<Recent>().clear();
            refresh_recent(app);
        }
        _ if id.starts_with("recent:") => {
            let _ = windows::open(app, Some(PathBuf::from(&id["recent:".len()..])));
        }
        "open" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"])
                .pick_files(move |files| {
                    for f in files.unwrap_or_default() {
                        if let Ok(p) = f.into_path() {
                            let _ = windows::open(&handle, Some(p));
                        }
                    }
                });
        }
        _ if id.starts_with("theme:") => set_theme(app, &id["theme:".len()..]),
        _ => {
            let focused = app
                .webview_windows()
                .into_values()
                .find(|w| w.is_focused().unwrap_or(false));
            if let Some(w) = focused {
                let _ = w.emit_to(w.label(), "menu", id);
            }
        }
    }
}

/// Switch every window to theme `id` and move the menu checkmark.
pub fn set_theme(app: &AppHandle, id: &str) {
    app.state::<Store>()
        .update(app, |s| s.theme = id.to_owned());
    let Some(MenuItemKind::Submenu(menu)) = app.menu().and_then(|m| m.get("themes")) else {
        return;
    };
    let wanted = format!("theme:{id}");
    for item in menu.items().unwrap_or_default() {
        if let MenuItemKind::Check(check) = item {
            let _ = check.set_checked(check.id().as_ref() == wanted);
        }
    }
}

/// Set while File › Quit closes the windows one after the other.
#[derive(Default)]
pub struct Quitting(pub AtomicBool);

/// Close the windows, the focused one first; each asks about unsaved edits and may
/// cancel the quit (`cancel_quit`). The app exits when the last one is gone.
fn quit(app: &AppHandle) {
    app.state::<Quitting>().0.store(true, Ordering::SeqCst);
    close_next(app, None);
}

/// Continue quitting after window `closed` is gone.
pub fn close_next(app: &AppHandle, closed: Option<&str>) {
    if !app.state::<Quitting>().0.load(Ordering::SeqCst) {
        return;
    }
    let windows: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|w| Some(w.label()) != closed)
        .collect();
    let next = windows
        .iter()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.first());
    match next {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
    }
}
