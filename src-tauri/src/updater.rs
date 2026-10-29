//! Updates from the GitHub releases (tauri.conf.json › plugins.updater): checked quietly
//! at launch and on Marpora › Check for Updates…. An update installs when the user
//! agrees; then the app quits as Quit does (asking about unsaved documents) and opens
//! again.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Quitting to finish an update: the app opens again once its windows are closed.
#[derive(Default)]
pub struct Restarting(pub AtomicBool);

/// One check at a time.
static CHECKING: AtomicBool = AtomicBool::new(false);

/// Look for an update. `quiet`: only speak up when there is one (the launch check).
pub fn check(app: &AppHandle, quiet: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app, quiet).await {
            eprintln!("update check failed: {e}");
            if !quiet {
                app.dialog()
                    .message(format!("Marpora could not check for updates.\n\n{e}"))
                    .title("Check for Updates")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
        CHECKING.store(false, Ordering::SeqCst);
    });
}

async fn run(app: &AppHandle, quiet: bool) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        if !quiet {
            app.dialog()
                .message(format!(
                    "Marpora {} is the newest version.",
                    app.package_info().version
                ))
                .title("You’re up to date")
                .show(|_| {});
        }
        return Ok(());
    };
    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| format!("\n\n{n}"))
        .unwrap_or_default();
    // Off the main thread (an async task), so waiting for the answer blocks nothing.
    let install = app
        .dialog()
        .message(format!(
            "Marpora {} is available; you have {}.{notes}",
            update.version, update.current_version
        ))
        .title("A new version of Marpora")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and Relaunch".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !install {
        return Ok(());
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.state::<Restarting>().0.store(true, Ordering::SeqCst);
    let handle = app.clone();
    app.run_on_main_thread(move || crate::menu::quit(&handle))
        .map_err(|e| e.to_string())
}
