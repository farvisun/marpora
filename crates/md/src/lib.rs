//! Markdown ⇄ ProseMirror JSON for Marpora.
//!
//! Compiled natively for `marpora-core` and to WASM for the editor, so both sides
//! agree on block boundaries and on how a document is parsed.

mod options;
mod parse;
pub mod pm;
mod serialize;
#[cfg(feature = "wasm")]
mod wasm;

pub use options::{Flavor, options};
pub use parse::{Parsed, parse};
pub use serialize::{BLOCK_SEP, serialize_block, serialize_doc};
