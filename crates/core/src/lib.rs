//! Document state, workspace and file handling shared by the app, export and MCP.

pub mod document;

pub use document::{Block, Document, Patch, PatchError, RemotePatch};
pub use marpora_md::Flavor;
