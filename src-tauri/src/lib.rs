//! Marpora desktop app: windows, menus and IPC around `marpora-core`.

mod agent;
mod ai;
mod commands;
#[cfg(target_os = "macos")]
mod context_menu;
mod docs;
mod images;
mod library;
mod links;
pub mod mcp;
mod menu;
#[cfg(target_os = "macos")]
mod native_menu;
mod pandoc;
#[cfg(target_os = "macos")]
mod pdf;
#[cfg(target_os = "macos")]
mod pptx;
mod present;
mod save;
mod search;
mod settings;
mod themes;
mod watch;
mod windows;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let builder = tauri::Builder::default();
    // Debug builds: `MARPORA_BACKGROUND` starts the app without taking the front (see
    // the activation policy in setup and windows.rs).
    #[cfg(all(debug_assertions, target_os = "macos"))]
    let builder =
        builder.activate_ignoring_other_apps(std::env::var_os("MARPORA_BACKGROUND").is_none());
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(docs::Docs::default())
        .manage(watch::Watcher::default())
        .manage(menu::Quitting::default())
        .manage(menu::WindowFlags::default())
        .manage(menu::ClosedFiles::default())
        .manage(search::Searches::default())
        .manage(ai::Tasks::default())
        .manage(present::Presents::default())
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                agent::focused(window.label());
                menu::sync_window_checks(window.app_handle(), window.label());
            }
            if let WindowEvent::Destroyed = event {
                present::closed(window.app_handle(), window.label());
                window.state::<menu::WindowFlags>().forget(window.label());
                let docs = window.state::<docs::Docs>();
                // Closed with "Don't Save": keep the edits as a draft (or save them,
                // with Auto Save on).
                if let Some(id) = docs.for_window(window.label()) {
                    save::settle(window.app_handle(), id);
                    if let Some(path) = docs.with(id, |open| open.path.clone()).flatten() {
                        window.state::<menu::ClosedFiles>().push(path);
                    }
                }
                docs.close_window(window.label());
                menu::close_next(window.app_handle(), Some(window.label()));
                window.state::<watch::Watcher>().update(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::initial_document,
            commands::open_link,
            commands::reveal_document,
            commands::trash_document,
            commands::read_clipboard,
            commands::write_clipboard,
            commands::set_context_menu,
            commands::image_file_action,
            commands::relocate_image,
            commands::relocate_images,
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
            commands::report_selection,
            ai::ai_start,
            ai::ai_cancel,
            ai::ai_set_key,
            ai::ai_keys,
            commands::pin_recent_folder,
            commands::remove_recent_folder,
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
            commands::export_slides_pdf,
            commands::export_slides_pptx,
            commands::marp_themes,
            commands::open_marp_theme_folder,
            present::present_open,
            present::present_send,
            present::present_close,
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
            agent::serve(app.handle());
            if let Some(dir) = save::drafts_dir(app.handle()) {
                std::thread::spawn(move || save::prune_drafts(&dir));
            }
            app.set_menu(menu::build(app.handle())?)?;
            // Debug builds: `MARPORA_BACKGROUND` keeps the app from ever coming to the
            // front, so checks of the real app leave the user's typing alone.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if std::env::var_os("MARPORA_BACKGROUND").is_some() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            #[cfg(target_os = "macos")]
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                native_menu::install(mtm);
                // Debug builds: the menu bar as text, for checks without the app in front.
                #[cfg(debug_assertions)]
                if std::env::var_os("MARPORA_MENU_PROBE").is_some()
                    && let Some(menu) =
                        objc2_app_kit::NSApplication::sharedApplication(mtm).mainMenu()
                {
                    let mut out = Vec::new();
                    context_menu::describe(&menu, 0, &mut out);
                    eprintln!("MENU {}", out.join(" | "));
                }
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
                let _ = windows::open_preferences(app, None);
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
