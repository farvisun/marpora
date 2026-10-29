//! Images pasted into a document, stored as Typora stores them (Preferences › Image ›
//! When Insert): next to the document, in `./assets`, in `./<name>.assets`, in a
//! folder of the user's choosing, or, with no rule or no file yet, in the app's own
//! `user-images` folder (Typora's `typora-user-images`).

use std::path::{Component, Path, PathBuf};

/// Image types a paste may store.
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg"];

/// The folder a pasted image goes to under `setting` ("", "folder", "assets",
/// "per-file-assets", or a path that may hold `${filename}`) for the document at `doc`.
pub fn storage_dir(setting: &str, doc: Option<&Path>, user_images: &Path) -> PathBuf {
    let dir = doc.and_then(Path::parent);
    let stem = doc
        .and_then(Path::file_stem)
        .map(|s| s.to_string_lossy().into_owned());
    let chosen = match (setting, dir) {
        ("folder", Some(dir)) => Some(dir.to_path_buf()),
        ("assets", Some(dir)) => Some(dir.join("assets")),
        ("per-file-assets", Some(dir)) => stem.map(|s| dir.join(format!("{s}.assets"))),
        ("" | "folder" | "assets" | "per-file-assets", _) => None,
        (custom, _) => {
            let custom = match (&stem, custom.contains("${filename}")) {
                (Some(s), true) => Some(custom.replace("${filename}", s)),
                (None, true) => None,
                (_, false) => Some(custom.to_owned()),
            };
            custom
                .map(PathBuf::from)
                .and_then(|p| match (p.is_absolute(), dir) {
                    (true, _) => Some(p),
                    (false, Some(dir)) => Some(dir.join(p)),
                    (false, None) => None,
                })
        }
    };
    chosen.unwrap_or_else(|| user_images.to_path_buf())
}

/// `image-<local time to the millisecond>.<ext>`, as Typora names pasted images.
pub fn file_name(ext: &str) -> Result<String, String> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("{ext} is not an image type"));
    }
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S%3f");
    Ok(format!("image-{stamp}.{ext}"))
}

/// How the document at `doc` refers to `image`: relative to the document's folder when
/// it is inside it and `relative` is on, as Typora's "Use relative path if possible".
pub fn src_for(image: &Path, doc: Option<&Path>, relative: bool) -> String {
    let inside = doc
        .and_then(Path::parent)
        .filter(|_| relative)
        .and_then(|dir| image.strip_prefix(dir).ok())
        .filter(|rest| rest.components().all(|c| matches!(c, Component::Normal(_))));
    match inside {
        Some(rest) => rest.to_string_lossy().into_owned(),
        None => image.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_follows_the_setting() {
        let doc = Path::new("/n/My Doc.md");
        let user = Path::new("/data/user-images");
        let dir = |s: &str, d: Option<&Path>| storage_dir(s, d, user);
        assert_eq!(dir("", Some(doc)), user);
        assert_eq!(dir("folder", Some(doc)), Path::new("/n"));
        assert_eq!(dir("assets", Some(doc)), Path::new("/n/assets"));
        assert_eq!(
            dir("per-file-assets", Some(doc)),
            Path::new("/n/My Doc.assets")
        );
        assert_eq!(dir("per-file-assets", None), user, "untitled");
        assert_eq!(
            dir("img/${filename}", Some(doc)),
            Path::new("/n/img/My Doc")
        );
        assert_eq!(dir("/pics", None), Path::new("/pics"));
        assert_eq!(dir("img", None), user);
    }

    #[test]
    fn names_and_sources() {
        let name = file_name("PNG").unwrap();
        assert!(
            name.starts_with("image-") && name.ends_with(".png") && name.len() == 27,
            "{name}"
        );
        assert!(file_name("exe").is_err());
        let doc = Some(Path::new("/n/a.md"));
        assert_eq!(
            src_for(Path::new("/n/assets/i.png"), doc, true),
            "assets/i.png"
        );
        assert_eq!(
            src_for(Path::new("/n/assets/i.png"), doc, false),
            "/n/assets/i.png"
        );
        assert_eq!(src_for(Path::new("/x/i.png"), doc, true), "/x/i.png");
        assert_eq!(src_for(Path::new("/x/i.png"), None, true), "/x/i.png");
    }
}
