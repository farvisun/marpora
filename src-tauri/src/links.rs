//! Where a link in a document goes when it is opened (⌘-click, Format › Hyperlink
//! Actions › Open Link): a web or mail address to the system, a file relative to the
//! document (Markdown files to Marpora, others to their app), or a heading in it.

use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    /// Handed to the system's opener.
    External(String),
    File(PathBuf),
    /// `#heading`, scrolled to by the editor.
    Anchor(String),
}

/// Schemes the system may open. Others (`javascript:`, `data:`, app-specific ones) are
/// refused: a document should not launch arbitrary handlers.
const SCHEMES: &[&str] = &["http", "https", "mailto", "ftp", "tel"];

pub fn resolve(href: &str, doc: Option<&Path>) -> Result<Target, String> {
    let href = href.trim();
    if href.is_empty() {
        return Err("the link has no address".into());
    }
    if let Some(anchor) = href.strip_prefix('#') {
        return Ok(Target::Anchor(decode(anchor)));
    }
    if let Some((scheme, rest)) = scheme(href) {
        let scheme = scheme.to_ascii_lowercase();
        if scheme == "file" {
            let path = rest.trim_start_matches("//");
            return Ok(Target::File(PathBuf::from(decode(strip_fragment(path)))));
        }
        if SCHEMES.contains(&scheme.as_str()) {
            return Ok(Target::External(href.to_owned()));
        }
        return Err(format!("{scheme}: links are not opened"));
    }
    // A bare domain, as Typora treats `www.…`.
    if href.starts_with("www.") {
        return Ok(Target::External(format!("http://{href}")));
    }
    let path = PathBuf::from(decode(strip_fragment(href)));
    let path = match path.strip_prefix("~") {
        Ok(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or(path),
        Err(_) => path,
    };
    if path.is_absolute() {
        return Ok(Target::File(path));
    }
    match doc.and_then(Path::parent) {
        Some(dir) => Ok(Target::File(dir.join(path))),
        None => Err("save the document to open links relative to it".into()),
    }
}

/// `scheme:` at the start of `href`, as RFC 3986 spells schemes; a Windows drive
/// letter is not one.
fn scheme(href: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = href.split_once(':')?;
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    (valid && scheme.len() > 1).then_some((scheme, rest))
}

fn strip_fragment(path: &str) -> &str {
    path.split(['#', '?']).next().unwrap_or(path)
}

/// Percent-decoding, keeping malformed escapes as they are.
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(Some(hi)), Some(Some(lo))) = (
                bytes.get(i + 1).map(|&b| hex(b)),
                bytes.get(i + 2).map(|&b| hex(b)),
            )
        {
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_links() {
        let doc = Some(Path::new("/n/a.md"));
        let ext = |s: &str| Ok(Target::External(s.to_owned()));
        assert_eq!(
            resolve("https://x.test/a?b#c", doc),
            ext("https://x.test/a?b#c")
        );
        assert_eq!(resolve("MAILTO:me@x.test", doc), ext("MAILTO:me@x.test"));
        assert_eq!(resolve("www.x.test", doc), ext("http://www.x.test"));
        assert!(resolve("javascript:alert(1)", doc).is_err());
        assert!(resolve("", doc).is_err());
        assert_eq!(
            resolve("#Some%20Heading", doc),
            Ok(Target::Anchor("Some Heading".into()))
        );
        let file = |s: &str| Ok(Target::File(PathBuf::from(s)));
        assert_eq!(resolve("b%20c.md#part", doc), file("/n/b c.md"));
        assert_eq!(resolve("../up.md", doc), file("/n/../up.md"));
        assert_eq!(resolve("/abs/x.pdf", None), file("/abs/x.pdf"));
        assert_eq!(resolve("file:///abs/y%2B.md", None), file("/abs/y+.md"));
        assert!(resolve("rel.md", None).is_err());
        assert_eq!(decode("100%"), "100%");
    }
}
