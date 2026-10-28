//! The Markdown dialect Typora writes: GFM plus `$$` math blocks, footnotes and YAML
//! front matter, with optional inline math, highlight and sub/superscript.

use comrak::Options;
use serde::{Deserialize, Serialize};

/// Optional syntax, as in Typora's Preferences → Markdown. The defaults (all off)
/// match Typora's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Flavor {
    pub inline_math: bool,
    pub highlight: bool,
    pub subscript: bool,
    pub superscript: bool,
}

impl Flavor {
    /// Every optional extension on.
    pub fn all() -> Self {
        Flavor {
            inline_math: true,
            highlight: true,
            subscript: true,
            superscript: true,
        }
    }
}

/// `math_dollars` stays on whatever the flavor: `$$` blocks are always math, and
/// `parse` turns other math back into text when inline math is off.
pub fn options(flavor: &Flavor) -> Options<'static> {
    let mut o = Options::default();
    let ext = &mut o.extension;
    ext.strikethrough = true;
    ext.table = true;
    ext.autolink = true;
    ext.tasklist = true;
    ext.superscript = flavor.superscript;
    ext.subscript = flavor.subscript;
    ext.highlight = flavor.highlight;
    ext.footnotes = true;
    ext.math_dollars = true;
    ext.front_matter_delimiter = Some("---".to_owned());
    o.parse.leave_footnote_definitions = true;
    o
}
