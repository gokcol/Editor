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
    "print_window",
    "save_as",
    "write_file",
];

fn main() {
    println!("cargo:rerun-if-changed=src/pdf_export_bridge.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/pdf_export_bridge.m")
            .flag("-fobjc-arc")
            .compile("seventxt_pdf_export");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build 7TXT's Tauri command manifest");
}
