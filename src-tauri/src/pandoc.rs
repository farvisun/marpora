//! Export through Pandoc (Word, OpenOffice, RTF, Epub, LaTeX, ...), as Typora does,
//! when Pandoc is installed. The document's Markdown goes in on stdin and runs in the
//! document's folder, so relative image paths resolve.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub struct Format {
    /// Menu item id after `export-`.
    pub id: &'static str,
    /// Name for the save dialog's filter.
    pub name: &'static str,
    pub extension: &'static str,
    /// Pandoc's writer.
    pub writer: &'static str,
    /// Write a whole document rather than a fragment.
    pub standalone: bool,
}

/// File › Export's Pandoc formats, in Typora's order.
pub const FORMATS: &[Format] = &[
    Format {
        id: "docx",
        name: "Word",
        extension: "docx",
        writer: "docx",
        standalone: false,
    },
    Format {
        id: "odt",
        name: "OpenOffice",
        extension: "odt",
        writer: "odt",
        standalone: false,
    },
    Format {
        id: "rtf",
        name: "RTF",
        extension: "rtf",
        writer: "rtf",
        standalone: true,
    },
    Format {
        id: "epub",
        name: "Epub",
        extension: "epub",
        writer: "epub",
        standalone: false,
    },
    Format {
        id: "latex",
        name: "LaTeX",
        extension: "tex",
        writer: "latex",
        standalone: true,
    },
    Format {
        id: "mediawiki",
        name: "Media Wiki",
        extension: "wiki",
        writer: "mediawiki",
        standalone: false,
    },
    Format {
        id: "rst",
        name: "reStructuredText",
        extension: "rst",
        writer: "rst",
        standalone: false,
    },
    Format {
        id: "textile",
        name: "Textile",
        extension: "textile",
        writer: "textile",
        standalone: false,
    },
    Format {
        id: "opml",
        name: "OPML",
        extension: "opml",
        writer: "opml",
        standalone: true,
    },
];

pub fn format(id: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|f| f.id == id)
}

/// Where apps launched from the Finder find Pandoc: they do not get the shell's PATH,
/// so the usual install locations are searched too.
pub fn find(path_var: Option<&std::ffi::OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    if let Some(home) = home {
        dirs.extend([
            home.join(".local/bin"),
            home.join(".cabal/bin"),
            home.join(".ghcup/bin"),
        ]);
    }
    dirs.into_iter()
        .map(|d| d.join("pandoc"))
        .find(|p| p.is_file())
}

/// What File › Import reads, as Pandoc's readers take them.
pub const IMPORT_EXTENSIONS: &[&str] = &[
    "docx",
    "odt",
    "rtf",
    "epub",
    "html",
    "htm",
    "tex",
    "latex",
    "opml",
    "rst",
    "textile",
    "wiki",
    "mediawiki",
    "org",
    "ipynb",
];

/// File › Import: `input` as Markdown, through the Pandoc at `pandoc`.
pub fn import(pandoc: &Path, input: &Path) -> Result<String, String> {
    let mut cmd = Command::new(pandoc);
    cmd.args(["--to", "gfm", "--wrap=none"]).arg(input);
    if let Some(dir) = input.parent() {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run {}: {e}", pandoc.display()))?;
    if !out.status.success() {
        return Err(format!(
            "Pandoc could not import {}: {}",
            input.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Convert `markdown` to `output` with the Pandoc at `pandoc`, from directory `cwd`.
pub fn convert(
    pandoc: &Path,
    format: &Format,
    markdown: &str,
    output: &Path,
    cwd: Option<&Path>,
) -> Result<(), String> {
    let mut cmd = Command::new(pandoc);
    cmd.args(["--from", "markdown", "--to", format.writer, "--output"])
        .arg(output);
    if format.standalone {
        cmd.arg("--standalone");
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", pandoc.display()))?;
    // Pandoc reads all of stdin before writing, so this cannot deadlock on stderr.
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(markdown.as_bytes())
        .map_err(|e| format!("could not send the document to Pandoc: {e}"))?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Pandoc failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in Pandoc that records its arguments and copies stdin to the output.
    fn fake_pandoc(dir: &Path) -> PathBuf {
        let path = dir.join("pandoc");
        std::fs::write(
            &path,
            "#!/bin/sh\necho \"$@\" > args.txt\nwhile [ \"$1\" != --output ]; do shift; done\ncat > \"$2\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("marpora-pandoc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_pandoc_on_path_first() {
        let dir = temp_dir("find");
        let pandoc = fake_pandoc(&dir);
        assert_eq!(find(Some(dir.as_os_str()), None), Some(pandoc));
    }

    #[test]
    fn converts_from_the_document_folder() {
        let dir = temp_dir("convert");
        let pandoc = fake_pandoc(&dir);
        let out = dir.join("out.tex");
        convert(
            &pandoc,
            format("latex").unwrap(),
            "# Hi\n",
            &out,
            Some(&dir),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Hi\n");
        let args = std::fs::read_to_string(dir.join("args.txt")).unwrap();
        assert_eq!(
            args.trim(),
            format!(
                "--from markdown --to latex --output {} --standalone",
                out.display()
            )
        );
    }

    #[test]
    fn reports_pandoc_errors() {
        let dir = temp_dir("fail");
        let pandoc = dir.join("pandoc");
        std::fs::write(
            &pandoc,
            "#!/bin/sh\ncat > /dev/null\necho 'Unknown writer' >&2\nexit 2\n",
        )
        .unwrap();
        std::fs::set_permissions(&pandoc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = convert(
            &pandoc,
            format("docx").unwrap(),
            "x",
            &dir.join("o.docx"),
            None,
        )
        .unwrap_err();
        assert_eq!(err, "Pandoc failed: Unknown writer");
    }
}
