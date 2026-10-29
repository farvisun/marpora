//! Marpora desktop app: windows, menus and IPC around `marpora-core`.

mod commands;
mod docs;
mod images;
mod library;
mod links;
mod menu;
#[cfg(target_os = "macos")]
mod native_menu;
mod pandoc;
#[cfg(target_os = "macos")]
mod pdf;
mod save;
mod search;
mod settings;
mod themes;
mod watch;
mod windows;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(docs::Docs::default())
        .manage(watch::Watcher::default())
        .manage(menu::Quitting::default())
        .manage(search::Searches::default())
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let docs = window.state::<docs::Docs>();
                // Closed with "Don't Save": keep the edits as a draft (or save them,
                // with Auto Save on).
                if let Some(id) = docs.for_window(window.label()) {
                    save::settle(window.app_handle(), id);
                }
                docs.close_window(window.label());
                menu::close_next(window.app_handle(), Some(window.label()));
                window.state::<watch::Watcher>().update(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::initial_document,
            commands::open_link,
            commands::read_clipboard,
            commands::write_clipboard,
            commands::apply_patch,
            commands::document_text,
            commands::set_document_text,
            commands::is_dirty,
            commands::save_document,
            commands::open_path,
            commands::open_here,
            commands::reload_document,
            commands::cancel_quit,
            commands::library_info,
            commands::list_folder,
            commands::list_documents,
            commands::recent_files,
            commands::clear_recent,
            commands::recent_folders,
            commands::search_library,
            commands::new_library_file,
            commands::rename_library_file,
            commands::save_image,
            commands::duplicate_library_file,
            commands::trash_library_file,
            commands::reveal_library_file,
            commands::open_library_file_in_window,
            commands::reveal_library,
            commands::switch_library_folder,
            commands::update_settings,
            commands::open_drafts_folder,
            commands::open_theme_folder,
            commands::frontend_log,
            commands::get_settings,
            commands::list_themes,
            commands::load_theme,
            commands::set_theme,
            commands::export_path,
            commands::write_export,
            commands::export_pdf,
            commands::export_image,
            commands::export_pandoc,
            commands::print_page_html,
        ])
        .setup(|app| {
            // The menu lists themes and checks the current one, so settings come first.
            app.manage(settings::Store::load(app.handle()));
            app.manage(commands::ExportGrants::default());
            app.manage(library::Recent::load(app.handle()));
            app.manage(save::Autosave::start(app.handle()));
            if let Some(dir) = save::drafts_dir(app.handle()) {
                std::thread::spawn(move || save::prune_drafts(&dir));
            }
            app.set_menu(menu::build(app.handle())?)?;
            #[cfg(target_os = "macos")]
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                native_menu::install(mtm);
            }

            let paths = std::env::args().skip(1).filter(|a| !a.starts_with('-'));
            for p in paths.map(PathBuf::from) {
                open_path(app.handle(), p)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Marpora");

    app.run(|app, event| match event {
        // Files opened from Finder or `open -a Marpora file.md`.
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let _ = open_path(app, path);
                }
            }
        }
        RunEvent::Ready => {
            // Without a file to open, start with an untitled document.
            if app.state::<docs::Docs>().is_empty() {
                let _ = windows::open(app, None);
            }
            // Debug builds: open Preferences too (parity captures; menus can't be scripted).
            #[cfg(debug_assertions)]
            if std::env::var_os("MARPORA_OPEN_PREFS").is_some() {
                let _ = windows::open_preferences(app);
            }
        }
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            let _ = windows::open(app, None);
        }
        // The last window closed: stay in the Dock, as Mac apps do, unless asked not to.
        // File › Quit exits with a code, so it is never held back.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if !app
            .state::<settings::Store>()
            .get()
            .quit_on_last_window_closed
            && !app
                .state::<menu::Quitting>()
                .0
                .load(std::sync::atomic::Ordering::SeqCst) =>
        {
            api.prevent_exit();
        }
        // Quitting without closing the windows (from the Dock, or logging out).
        RunEvent::Exit => save::settle_all(app),
        _ => {}
    });
}

/// Open a file in a window, or a folder in a window's sidebar.
fn open_path(app: &tauri::AppHandle, path: PathBuf) -> tauri::Result<()> {
    if path.is_dir() {
        windows::open_folder(app, path)
    } else if path.is_file() {
        windows::open(app, Some(path))
    } else {
        Ok(())
    }
}
