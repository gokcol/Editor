const COMMANDS: &[&str] = &[
    "open_file",
    "open_recent",
    "open_folder",
    "browse_folder",
    "refresh_folder",
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
