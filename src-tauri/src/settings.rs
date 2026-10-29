//! App-wide preferences, stored as JSON in the app config directory and broadcast to
//! every window as a `settings` event when they change.

use std::path::PathBuf;
use std::sync::Mutex;

use marpora_core::Flavor;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Theme id, see `themes.rs`.
    pub theme: String,
    /// Optional Markdown syntax. Windows read it when they open, like Typora, which
    /// asks for a restart when these change.
    pub flavor: Flavor,
    /// Number display equations (Typora's "Auto Numbering Math Equations", on by default).
    pub auto_number_math: bool,
    /// Save documents that have a file shortly after each edit (off by default, as in
    /// Typora).
    pub auto_save: bool,
    /// Keep copies of unsaved edits in `draftsRecover` (on by default, as in Typora).
    pub backup_unsaved_drafts: bool,
    /// Keep File › Open Recent and Quick Open's recent files.
    pub record_recent: bool,
    /// List dot files and folders in the sidebar.
    pub show_hidden_files: bool,
    /// Quit when the last window closes, instead of staying in the Dock as Mac apps do.
    pub quit_on_last_window_closed: bool,
    /// Sidebar order, as Typora's sort types: 0 natural, -10 natural descending, ±1 name,
    /// ±2 modification date, ±3 creation date (negative is descending).
    pub list_sort: i32,
    pub tree_sort: i32,
    /// Sidebar "Group By Folder" turned off: one sorted list, folders mixed with files.
    pub list_no_group: bool,
    pub tree_no_group: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "marpora".to_owned(),
            flavor: Flavor::default(),
            auto_number_math: true,
            auto_save: false,
            backup_unsaved_drafts: true,
            record_recent: true,
            show_hidden_files: false,
            quit_on_last_window_closed: false,
            list_sort: 0,
            tree_sort: 0,
            list_no_group: false,
            tree_no_group: false,
        }
    }
}

pub struct Store {
    path: Option<PathBuf>,
    settings: Mutex<Settings>,
}

impl Store {
    pub fn load(app: &AppHandle) -> Self {
        let path = app.path().app_config_dir().ok().map(|d| d.join("settings.json"));
        let settings = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store {
            path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Merge `patch`, a JSON object of camelCase fields, into the settings. Unknown or
    /// mistyped fields are refused as a whole.
    pub fn merge(&self, app: &AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
        let mut value = serde_json::to_value(self.get()).map_err(|e| e.to_string())?;
        let (Some(fields), serde_json::Value::Object(patch)) = (value.as_object_mut(), patch)
        else {
            return Err("settings must be an object".into());
        };
        for (key, v) in patch {
            if !fields.contains_key(&key) {
                return Err(format!("unknown setting {key}"));
            }
            fields.insert(key, v);
        }
        let next: Settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(self.update(app, |s| *s = next))
    }

    /// Change, save and broadcast the settings.
    pub fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Settings)) -> Settings {
        let settings = {
            let mut s = self.settings.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        if let Some(path) = &self.path {
            let saved = path
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(path, serde_json::to_string_pretty(&settings)?));
            if let Err(e) = saved {
                eprintln!("could not save settings to {}: {e}", path.display());
            }
        }
        let _ = app.emit("settings", &settings);
        settings
    }
}
