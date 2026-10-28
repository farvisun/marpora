//! Marpora desktop app: windows, menus and IPC around `marpora-core`.

mod commands;
mod docs;
mod library;
mod menu;
mod pandoc;
#[cfg(target_os = "macos")]
mod pdf;
mod settings;
mod themes;
mod windows;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(docs::Docs::default())
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<docs::Docs>().close_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::initial_document,
            commands::apply_patch,
            commands::document_text,
            commands::set_document_text,
            commands::is_dirty,
            commands::save_document,
            commands::open_path,
            commands::open_here,
            commands::library_info,
            commands::list_folder,
            commands::list_documents,
            commands::recent_files,
            commands::frontend_log,
            commands::get_settings,
            commands::list_themes,
            commands::load_theme,
            commands::set_theme,
            commands::export_path,
            commands::write_export,
            commands::export_pdf,
            commands::export_pandoc,
            commands::print_page_html,
        ])
        .setup(|app| {
            // The menu lists themes and checks the current one, so settings come first.
            app.manage(settings::Store::load(app.handle()));
            app.manage(commands::ExportGrants::default());
            app.manage(library::Recent::load(app.handle()));
            app.set_menu(menu::build(app.handle())?)?;

            let paths: Vec<PathBuf> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .map(PathBuf::from)
                .filter(|p| p.is_file())
                .collect();
            for p in &paths {
                windows::open(app.handle(), Some(p.clone()))?;
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
                    let _ = windows::open(app, Some(path));
                }
            }
        }
        RunEvent::Ready => {
            // Without a file to open, start with an untitled document.
            if app.state::<docs::Docs>().is_empty() {
                let _ = windows::open(app, None);
            }
        }
        RunEvent::Reopen { has_visible_windows: false, .. } => {
            let _ = windows::open(app, None);
        }
        _ => {}
    });
}
