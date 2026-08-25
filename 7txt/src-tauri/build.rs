const COMMANDS: &[&str] = &[
    "open_file",
    "open_recent",
    "open_folder",
    "browse_folder",
    "refresh_folder",
    "reveal_file_folder",
    "take_pending_open_files",
    "file_fingerprint",
    "create_browser_entry",
    "rename_browser_entry",
    "move_browser_entry_to_trash",
    "export_document",
    "save_as",
    "write_file",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build 7TXT's Tauri command manifest");
}
