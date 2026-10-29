//! View › Present: a Marp deck shown full screen in an audience window
//! (web/src/present), while the document's window shows the presenter view and drives
//! it. The two talk through `present_send`, which hands a message to the other side as
//! a `present` event; the document's window keeps the state.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Audience windows, by label, and the document windows they show.
#[derive(Default)]
pub struct Presents(Mutex<HashMap<String, String>>);

impl Presents {
    fn owner(&self, audience: &str) -> Option<String> {
        self.0.lock().unwrap().get(audience).cloned()
    }
}

fn audience_label(owner: &str) -> String {
    format!("present-{owner}")
}

/// Open (or bring back) the audience window for `window`'s deck: full screen, on
/// another display when there is one.
#[tauri::command]
pub fn present_open(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let owner = window.label().to_owned();
    let label = audience_label(&owner);
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let here = window.current_monitor().ok().flatten();
    let other = here.and_then(|h| {
        window
            .available_monitors()
            .unwrap_or_default()
            .into_iter()
            .find(|m| m.position() != h.position())
    });
    let mut builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("present.html".into()))
            .title("Slides")
            .inner_size(960.0, 540.0);
    if let Some(m) = &other {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        builder = builder.position(p.x + 40.0, p.y + 40.0);
    }
    app.state::<Presents>()
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), owner);
    let audience = builder.build().map_err(|e| e.to_string())?;
    audience.set_fullscreen(true).map_err(|e| e.to_string())?;
    // With one display the audience covers the document; the presenter view keeps
    // the keyboard on the document's window when there are two.
    if other.is_some() {
        let _ = window.set_focus();
    }
    Ok(())
}

/// Hand `message` to the other side: from the audience to its document window, or from
/// a document window to its audience.
#[tauri::command]
pub fn present_send(app: AppHandle, window: WebviewWindow, message: Value) -> Result<(), String> {
    let presents = app.state::<Presents>();
    let target = match presents.owner(window.label()) {
        Some(owner) => owner,
        None => audience_label(window.label()),
    };
    if app.get_webview_window(&target).is_none() {
        return Ok(());
    }
    app.emit_to(&target, "present", message)
        .map_err(|e| e.to_string())
}

/// End the show: close the audience window, from either side.
#[tauri::command]
pub fn present_close(app: AppHandle, window: WebviewWindow) {
    let label = match app.state::<Presents>().owner(window.label()) {
        Some(_) => window.label().to_owned(),
        None => audience_label(window.label()),
    };
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
}

/// A window closed: an audience window tells its document window the show ended; a
/// document window takes its audience with it.
pub fn closed(app: &AppHandle, label: &str) {
    let presents = app.state::<Presents>();
    let owner = presents.0.lock().unwrap().remove(label);
    match owner {
        Some(owner) => {
            let _ = app.emit_to(&owner, "present", json!({ "closed": true }));
        }
        None => {
            if let Some(w) = app.get_webview_window(&audience_label(label)) {
                let _ = w.close();
            }
        }
    }
}
