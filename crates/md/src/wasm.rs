//! WASM entry points for the editor. Values cross the boundary as JSON strings,
//! which `JSON.parse` turns into ProseMirror JSON faster than serde-wasm-bindgen.

use wasm_bindgen::prelude::*;

use crate::pm::Node;

/// `{ doc, blocks: [[start, end], ...] }` with byte offsets into the UTF-8 source.
/// `flavor_json` is a [`Flavor`](crate::Flavor); missing fields take Typora's defaults.
#[wasm_bindgen]
pub fn parse(src: &str, flavor_json: &str) -> Result<String, JsError> {
    let flavor: crate::Flavor = serde_json::from_str(flavor_json)?;
    let parsed = crate::parse(src, &flavor);
    let blocks: Vec<[usize; 2]> = parsed.blocks.iter().map(|r| [r.start, r.end]).collect();
    Ok(serde_json::json!({ "doc": parsed.doc, "blocks": blocks }).to_string())
}

/// Serialize a JSON array of top-level block nodes to one Markdown string each.
#[wasm_bindgen(js_name = serializeBlocks)]
pub fn serialize_blocks(blocks_json: &str) -> Result<Vec<String>, JsError> {
    let nodes: Vec<Node> = serde_json::from_str(blocks_json)?;
    Ok(nodes.iter().map(crate::serialize_block).collect())
}

#[wasm_bindgen(js_name = serializeDoc)]
pub fn serialize_doc(doc_json: &str) -> Result<String, JsError> {
    let doc: Node = serde_json::from_str(doc_json)?;
    Ok(crate::serialize_doc(&doc))
}
