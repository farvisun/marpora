// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `marpora mcp`: the MCP server agents start, which talks to the running app.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        return marpora_app::mcp::run();
    }
    marpora_app::run()
}
