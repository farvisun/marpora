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
    ("export-image", "Image", None),
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

/// Edit, after Cut, Copy and Paste: Typora's Copy as … and Paste as Plain Text.
const EDIT_COPY: &[Item] = &[
    ("-", "", None),
    ("copy-plain", "Copy as Plain Text", None),
    (
        "copy-markdown",
        "Copy as Markdown",
        Some("CmdOrCtrl+Shift+C"),
    ),
    ("copy-html", "Copy as HTML Code", None),
    ("copy-no-style", "Copy without Theme Styling", None),
    ("-", "", None),
    (
        "paste-plain",
        "Paste as Plain Text",
        Some("CmdOrCtrl+Shift+V"),
    ),
    ("-", "", None),
];

/// Edit › Selection, after Select All. ⌘↑, ⌘↓, ⌃A and ⌃E stay the web view's own keys,
/// which do the same, so text fields and source mode keep them.
const SELECTION: &[Item] = &[
    (
        "select-block",
        "Select Paragraph / Block",
        Some("CmdOrCtrl+Alt+P"),
    ),
    ("select-line", "Select Line / Sentence", Some("CmdOrCtrl+L")),
    ("select-scope", "Select Styled Scope", Some("CmdOrCtrl+E")),
    ("select-word", "Select Word", Some("CmdOrCtrl+D")),
    ("-", "", None),
    ("jump-top", "Jump to Top", None),
    ("jump-selection", "Jump to Selection", Some("CmdOrCtrl+J")),
    ("jump-bottom", "Jump to Bottom", None),
    ("-", "", None),
    ("jump-line-start", "Jump to Line Start", None),
    ("jump-line-end", "Jump to Line End", None),
];

const EDIT_MOVE: &[Item] = &[
    ("-", "", None),
    ("move-row-up", "Move Row Up", Some("Alt+Up")),
    ("move-row-down", "Move Row Down", Some("Alt+Down")),
    ("-", "", None),
    ("delete", "Delete", None),
];

/// Edit › Delete Range.
const DELETE_RANGE: &[Item] = &[
    (
        "delete-block",
        "Delete Paragraph / Block",
        Some("CmdOrCtrl+Alt+Shift+P"),
    ),
    (
        "delete-line",
        "Delete Line / Sentence",
        Some("CmdOrCtrl+Alt+Shift+L"),
    ),
    (
        "delete-scope",
        "Delete Styled Scope",
        Some("CmdOrCtrl+Alt+Shift+E"),
    ),
    ("delete-word", "Delete Word", Some("CmdOrCtrl+Shift+D")),
];

/// Edit › Transformations.
const TRANSFORMATIONS: &[Item] = &[
    ("upper-case", "Make Upper Case", None),
    ("lower-case", "Make Lower Case", None),
    ("capitalize", "Capitalize", None),
];

/// Edit › Find.
const FIND: &[Item] = &[
    ("find", "Find…", Some("CmdOrCtrl+F")),
    ("find-next", "Find Next", Some("CmdOrCtrl+G")),
    ("find-previous", "Find Previous", Some("CmdOrCtrl+Shift+G")),
    ("-", "", None),
    ("replace", "Find and Replace…", Some("CmdOrCtrl+Alt+F")),
    ("replace-next", "Replace Next", Some("CmdOrCtrl+Alt+E")),
    ("-", "", None),
    ("jump-selection", "Jump to Selection", None),
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
];

/// Paragraph › Table, with Typora's shortcuts.
const TABLE: &[Item] = &[
    ("table", "Insert Table", Some("CmdOrCtrl+Alt+T")),
    ("-", "", None),
    ("table-row-above", "Add Row Above", None),
    ("table-row-below", "Add Row Below", Some("CmdOrCtrl+Enter")),
    ("table-col-before", "Add Column Before", None),
    ("table-col-after", "Add Column After", None),
    ("-", "", None),
    (
        "table-row-up",
        "Move Table Row Up",
        Some("Ctrl+CmdOrCtrl+Up"),
    ),
    (
        "table-row-down",
        "Move Table Row Down",
        Some("Ctrl+CmdOrCtrl+Down"),
    ),
    (
        "table-col-left",
        "Move Table Column Left",
        Some("Ctrl+CmdOrCtrl+Left"),
    ),
    (
        "table-col-right",
        "Move Table Column Right",
        Some("Ctrl+CmdOrCtrl+Right"),
    ),
    ("-", "", None),
    (
        "table-delete-row",
        "Delete Row",
        Some("CmdOrCtrl+Shift+Backspace"),
    ),
    ("table-delete-col", "Delete Column", None),
    ("-", "", None),
    ("table-copy", "Copy Table", None),
    ("-", "", None),
    ("table-delete", "Delete Table", None),
];

/// The rest of Paragraph, after Table.
const PARAGRAPH_BLOCKS: &[Item] = &[
    ("math-block", "Math Block", Some("CmdOrCtrl+Alt+B")),
    ("code-fence", "Code Fences", Some("CmdOrCtrl+Alt+C")),
];

/// Paragraph › Alert: GitHub's alert blocks.
const ALERT: &[Item] = &[
    ("alert-note", "Note Block", None),
    ("alert-tip", "Tip Block", None),
    ("alert-important", "Important Block", None),
    ("alert-warning", "Warning Block", None),
    ("alert-caution", "Caution Block", None),
];

/// Paragraph › Code Tools.
const CODE_TOOLS: &[Item] = &[("copy-code", "Copy Code Content", None)];

const PARAGRAPH_LISTS: &[Item] = &[
    ("-", "", None),
    ("quote", "Quote", Some("CmdOrCtrl+Alt+Q")),
    ("-", "", None),
    ("ordered-list", "Ordered List", Some("CmdOrCtrl+Alt+O")),
    ("bullet-list", "Unordered List", Some("CmdOrCtrl+Alt+U")),
    ("task-list", "Task List", Some("CmdOrCtrl+Alt+X")),
];

/// Paragraph › Task Status.
const TASK_STATUS: &[Item] = &[
    ("task-toggle", "Toggle Task Status", Some("Ctrl+X")),
    ("-", "", None),
    ("task-complete", "Mark as Complete", None),
    ("task-incomplete", "Mark as Incomplete", None),
];

/// Paragraph › List Indentation.
const LIST_INDENTATION: &[Item] = &[
    ("indent", "Indent", Some("CmdOrCtrl+]")),
    ("outdent", "Outdent", Some("CmdOrCtrl+[")),
];

const PARAGRAPH_END: &[Item] = &[
    ("-", "", None),
    ("paragraph-before", "Insert Paragraph Before", None),
    ("paragraph-after", "Insert Paragraph After", None),
    ("-", "", None),
    ("link-reference", "Link Reference", Some("CmdOrCtrl+Alt+L")),
    ("footnote", "Footnotes", Some("CmdOrCtrl+Alt+R")),
    ("-", "", None),
    ("hr", "Horizontal Line", Some("CmdOrCtrl+Alt+-")),
    ("toc", "Table of Contents", None),
    ("front-matter", "YAML Front Matter", None),
];

const FORMAT: &[Item] = &[
    ("strong", "Strong", Some("CmdOrCtrl+B")),
    ("em", "Emphasis", Some("CmdOrCtrl+I")),
    ("underline", "Underline", Some("CmdOrCtrl+U")),
    ("code", "Code", Some("Ctrl+`")),
    ("-", "", None),
    ("inline-math", "Inline Math", Some("Ctrl+M")),
    ("strike", "Strike", Some("Ctrl+Shift+`")),
    ("highlight", "Highlight", Some("CmdOrCtrl+Shift+H")),
    ("sup", "Superscript", None),
    ("sub", "Subscript", None),
    ("comment", "Comment", Some("Ctrl+-")),
    ("-", "", None),
    ("link", "Hyperlink", Some("CmdOrCtrl+K")),
];

/// Format › Hyperlink Actions.
const LINK_ACTIONS: &[Item] = &[
    ("open-link", "Open Link", None),
    ("copy-link", "Copy Link Address", None),
];

const FORMAT_END: &[Item] = &[
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
    edit.extend(items(app, EDIT_COPY)?);
    let mut selection: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> =
        vec![Box::new(PredefinedMenuItem::select_all(app, None)?)];
    selection.extend(items(app, SELECTION)?);
    edit.push(Box::new(submenu(app, "Selection", selection)?));
    edit.extend(items(app, EDIT_MOVE)?);
    edit.push(Box::new(submenu(
        app,
        "Delete Range",
        items(app, DELETE_RANGE)?,
    )?));
    edit.push(Box::new(PredefinedMenuItem::separator(app)?));
    // Filled with macOS's own items by native_menu.rs.
    for title in ["Spelling and Grammar", "Substitutions"] {
        edit.push(Box::new(submenu(app, title, Vec::new())?));
    }
    edit.push(Box::new(submenu(
        app,
        "Transformations",
        items(app, TRANSFORMATIONS)?,
    )?));
    edit.push(Box::new(PredefinedMenuItem::separator(app)?));
    edit.push(Box::new(submenu(app, "Find", items(app, FIND)?)?));
    edit.push(Box::new(PredefinedMenuItem::separator(app)?));
    edit.push(Box::new(submenu(app, "Speech", Vec::new())?));

    let mut paragraph = items(app, PARAGRAPH)?;
    paragraph.push(Box::new(submenu(app, "Table", items(app, TABLE)?)?));
    paragraph.extend(items(app, PARAGRAPH_BLOCKS)?);
    paragraph.push(Box::new(submenu(
        app,
        "Code Tools",
        items(app, CODE_TOOLS)?,
    )?));
    paragraph.push(Box::new(submenu(app, "Alert", items(app, ALERT)?)?));
    paragraph.extend(items(app, PARAGRAPH_LISTS)?);
    paragraph.push(Box::new(submenu(
        app,
        "Task Status",
        items(app, TASK_STATUS)?,
    )?));
    paragraph.push(Box::new(submenu(
        app,
        "List Indentation",
        items(app, LIST_INDENTATION)?,
    )?));
    paragraph.extend(items(app, PARAGRAPH_END)?);

    let mut format = items(app, FORMAT)?;
    format.push(Box::new(submenu(
        app,
        "Hyperlink Actions",
        items(app, LINK_ACTIONS)?,
    )?));
    format.extend(items(app, FORMAT_END)?);

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

    let mut view = items(app, VIEW)?;
    view.push(Box::new(CheckMenuItem::with_id(
        app,
        "status-bar",
        "Status Bar",
        true,
        app.state::<Store>().get().show_status_bar,
        None::<&str>,
    )?));

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
            &submenu(app, "Paragraph", paragraph)?,
            &submenu(app, "Format", format)?,
            &Submenu::with_id_and_items(
                app,
                "view",
                "View",
                true,
                &view.iter().map(|b| b.as_ref()).collect::<Vec<_>>(),
            )?,
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
        "status-bar" => {
            let shown = app
                .state::<Store>()
                .update(app, |s| s.show_status_bar = !s.show_status_bar)
                .show_status_bar;
            if let Some(MenuItemKind::Submenu(view)) = app.menu().and_then(|m| m.get("view"))
                && let Some(MenuItemKind::Check(check)) = view.get("status-bar")
            {
                let _ = check.set_checked(shown);
            }
        }
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
