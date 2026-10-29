//! Theme discovery. Themes use Typora's layout: `<name>.css` plus an optional `<name>/`
//! folder for its assets, so Typora themes work unchanged. They come from:
//!
//! - the app bundle (`marpora`, `marpora-night`), served by the web frontend;
//! - Marpora's `themes` folder in the app config directory (ids `user/<name>`);
//! - Typora's themes folder, when Typora is installed (ids `typora/<name>`).
//!
//! `base.user.css` and `<name>.user.css` in Marpora's folder are appended to every
//! theme and to `<name>` respectively, as in Typora.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const BUNDLED: &[(&str, &str)] = &[("marpora", "Marpora"), ("marpora-night", "Marpora Night")];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub source: Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Bundled,
    User,
    Typora,
}

/// CSS for the editor to inject. `css` is `None` for bundled themes, which the
/// frontend loads itself; `dir` is where relative `url()`s in `css` resolve from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCss {
    pub css: Option<String>,
    pub dir: Option<String>,
    /// User overrides (`base.user.css`, `<name>.user.css`), each with its directory.
    pub user: Vec<(String, String)>,
}

pub fn user_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("themes"))
}

/// The user's Marp slide themes: CSS files with a `/* @theme name */` comment.
pub fn marp_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("marp-themes"))
}

/// The CSS of each Marp theme in `dir`, by file name; files too large to be a theme
/// are left out.
pub fn marp_css(dir: &Path) -> Vec<String> {
    css_stems(dir)
        .into_iter()
        .filter_map(|stem| {
            let path = dir.join(format!("{stem}.css"));
            let size = std::fs::metadata(&path).ok()?.len();
            (size <= 2 << 20)
                .then(|| std::fs::read_to_string(&path).ok())
                .flatten()
        })
        .collect()
}

fn typora_dir(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().data_dir().ok()?;
    if cfg!(target_os = "macos") {
        Some(base.join("abnerworks.Typora/themes"))
    } else {
        Some(base.join("Typora/themes"))
    }
}

pub fn list(app: &AppHandle) -> Vec<ThemeInfo> {
    let mut out: Vec<ThemeInfo> = BUNDLED
        .iter()
        .map(|(id, name)| ThemeInfo {
            id: (*id).to_owned(),
            name: (*name).to_owned(),
            source: Source::Bundled,
        })
        .collect();
    for (dir, prefix, source) in [
        (user_dir(app), "user", Source::User),
        (typora_dir(app), "typora", Source::Typora),
    ] {
        let Some(dir) = dir else { continue };
        for stem in css_stems(&dir) {
            out.push(ThemeInfo {
                id: format!("{prefix}/{stem}"),
                name: display_name(&stem),
                source,
            });
        }
    }
    out
}

pub fn load(app: &AppHandle, id: &str) -> Option<ThemeCss> {
    let (theme_dir, name) = match id.split_once('/') {
        Some(("user", name)) => (user_dir(app)?, name),
        Some(("typora", name)) => (typora_dir(app)?, name),
        Some(_) => return None,
        None => {
            BUNDLED.iter().find(|(b, _)| *b == id)?;
            return Some(ThemeCss {
                css: None,
                dir: None,
                user: user_css(app, id),
            });
        }
    };
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return None;
    }
    let css = std::fs::read_to_string(theme_dir.join(format!("{name}.css"))).ok()?;
    Some(ThemeCss {
        css: Some(css),
        dir: Some(theme_dir.to_string_lossy().into_owned()),
        user: user_css(app, name),
    })
}

fn user_css(app: &AppHandle, name: &str) -> Vec<(String, String)> {
    let Some(dir) = user_dir(app) else {
        return Vec::new();
    };
    ["base.user.css".to_owned(), format!("{name}.user.css")]
        .iter()
        .filter_map(|f| std::fs::read_to_string(dir.join(f)).ok())
        .map(|css| (css, dir.to_string_lossy().into_owned()))
        .collect()
}

/// Theme names in `dir`: `*.css` files that are not user overrides, sorted.
fn css_stems(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut stems: Vec<String> = entries
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            let stem = name.strip_suffix(".css")?;
            (!stem.ends_with(".user") && !stem.starts_with('.')).then(|| stem.to_owned())
        })
        .collect();
    stems.sort_by_key(|s| s.to_lowercase());
    stems
}

/// `solarized-dark` → `Solarized Dark`, as Typora names themes in its menu.
fn display_name(stem: &str) -> String {
    stem.split(['-', '_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{display_name, marp_css};

    #[test]
    fn names_like_typora() {
        assert_eq!(display_name("github"), "Github");
        assert_eq!(display_name("solarized-dark"), "Solarized Dark");
    }

    #[test]
    fn marp_themes_are_the_css_files() {
        let dir = std::env::temp_dir().join(format!("marpora-marp-themes-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.css"), "/* @theme b */").unwrap();
        std::fs::write(dir.join("a.css"), "/* @theme a */").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a theme").unwrap();
        let css = marp_css(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(css, ["/* @theme a */", "/* @theme b */"]);
    }
}
