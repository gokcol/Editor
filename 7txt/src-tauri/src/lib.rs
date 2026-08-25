mod text_encoding;

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use rfd::FileDialog;
use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Runtime,
};

const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BROWSER_ENTRIES: usize = 8_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedTextFile {
    name: String,
    path: String,
    content: String,
    is_markdown: bool,
    encoding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedTextFile {
    name: String,
    path: String,
    encoding: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileBrowser {
    name: String,
    path: String,
    parent_path: Option<String>,
    home_path: String,
    documents_path: String,
    entries: Vec<FolderEntry>,
    truncated: bool,
}

fn is_supported_text_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "txt" | "md" | "markdown"
    )
}

fn text_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("untitled.txt")
        .to_owned()
}

fn folder_name(path: &Path) -> String {
    if path.parent().is_none() {
        return "/".to_owned();
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Folder")
        .to_owned()
}

fn home_directory() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or_else(|| "Your home folder is unavailable.".to_owned())
}

fn documents_directory(home: &Path) -> PathBuf {
    let documents = home.join("Documents");
    if documents.is_dir() {
        documents
    } else {
        home.to_path_buf()
    }
}

fn read_browser_directory(path: PathBuf) -> Result<FileBrowser, String> {
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "That folder is unavailable.".to_owned())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Choose a regular folder to browse its contents.".to_owned());
    }
    let real_path =
        fs::canonicalize(&path).map_err(|_| "That folder is unavailable.".to_owned())?;
    let home = fs::canonicalize(home_directory()?)
        .map_err(|_| "Your home folder is unavailable.".to_owned())?;
    let documents = fs::canonicalize(documents_directory(&home)).unwrap_or_else(|_| home.clone());
    let directory_entries =
        fs::read_dir(&real_path).map_err(|_| "That folder cannot be read.".to_owned())?;
    let mut collected = Vec::new();
    for entry in directory_entries.flatten() {
        if collected.len() >= MAX_BROWSER_ENTRIES {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collected.push(FolderEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: "directory".to_owned(),
            });
        } else if metadata.is_file() && is_supported_text_path(&path) {
            collected.push(FolderEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: "file".to_owned(),
            });
        }
    }
    collected.sort_by(
        |left, right| match (left.kind.as_str(), right.kind.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        },
    );
    let truncated = collected.len() == MAX_BROWSER_ENTRIES;
    Ok(FileBrowser {
        name: folder_name(&real_path),
        path: real_path.to_string_lossy().into_owned(),
        parent_path: real_path
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        home_path: home.to_string_lossy().into_owned(),
        documents_path: documents.to_string_lossy().into_owned(),
        entries: collected,
        truncated,
    })
}

fn read_text_file(path: PathBuf, encoding: Option<String>) -> Result<OpenedTextFile, String> {
    if !is_supported_text_path(&path) {
        return Err(
            "7TXT opens plain text (.txt) and Markdown (.md, .markdown) files only.".to_owned(),
        );
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "That file is unavailable.".to_owned())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Only regular text files can be opened here.".to_owned());
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("That text file is larger than 16 MB.".to_owned());
    }
    let real_path = fs::canonicalize(&path).map_err(|_| "That file is unavailable.".to_owned())?;
    let bytes = fs::read(&real_path).map_err(|_| "That file is unavailable.".to_owned())?;
    let decoded = text_encoding::decode(&bytes, encoding.as_deref())?;
    Ok(OpenedTextFile {
        name: text_file_name(&real_path),
        path: real_path.to_string_lossy().into_owned(),
        is_markdown: matches!(
            real_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "md" | "markdown"
        ),
        content: decoded.content,
        encoding: decoded.encoding,
    })
}

fn checked_content(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        Err("7TXT limits a document to 16 MB.".to_owned())
    } else {
        Ok(())
    }
}

fn save_text_file(
    path: PathBuf,
    content: String,
    encoding: Option<String>,
) -> Result<SavedTextFile, String> {
    checked_content(&content)?;
    if !is_supported_text_path(&path) {
        return Err("Save as .txt, .md, or .markdown.".to_owned());
    }
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("That save target is not a regular file.".to_owned());
        }
    }
    let (bytes, encoding) = text_encoding::encode(&content, encoding.as_deref())?;
    fs::write(&path, bytes).map_err(|error| format!("Could not save this file: {error}"))?;
    let real_path =
        fs::canonicalize(&path).map_err(|_| "The saved file could not be resolved.".to_owned())?;
    Ok(SavedTextFile {
        name: text_file_name(&real_path),
        path: real_path.to_string_lossy().into_owned(),
        encoding,
    })
}

#[tauri::command]
fn open_file(encoding: Option<String>) -> Result<Option<OpenedTextFile>, String> {
    let path = FileDialog::new()
        .add_filter("Text & Markdown", &["txt", "md", "markdown"])
        .pick_file();
    path.map(|path| read_text_file(path, encoding)).transpose()
}

#[tauri::command]
fn open_recent(path: String, encoding: Option<String>) -> Result<OpenedTextFile, String> {
    read_text_file(PathBuf::from(path), encoding)
}

#[tauri::command]
fn open_folder() -> Result<Option<FileBrowser>, String> {
    FileDialog::new()
        .pick_folder()
        .map(read_browser_directory)
        .transpose()
}

#[tauri::command]
fn browse_folder(path: Option<String>) -> Result<FileBrowser, String> {
    let target = match path {
        Some(path) => PathBuf::from(path),
        None => documents_directory(&home_directory()?),
    };
    read_browser_directory(target)
}

#[tauri::command]
fn refresh_folder(path: String) -> Result<FileBrowser, String> {
    read_browser_directory(PathBuf::from(path))
}

#[tauri::command]
fn save_as(
    suggested_name: String,
    content: String,
    encoding: Option<String>,
) -> Result<Option<SavedTextFile>, String> {
    checked_content(&content)?;
    let fallback_name = if is_supported_text_path(Path::new(&suggested_name)) {
        suggested_name
    } else {
        format!("{}.txt", suggested_name.trim().trim_end_matches('.'))
    };
    let path = FileDialog::new()
        .add_filter("Text & Markdown", &["txt", "md", "markdown"])
        .set_file_name(&fallback_name)
        .save_file();
    path.map(|path| save_text_file(path, content, encoding))
        .transpose()
}

#[tauri::command]
fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<SavedTextFile, String> {
    save_text_file(PathBuf::from(path), content, encoding)
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    shortcut: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, label);
    if let Some(shortcut) = shortcut {
        builder = builder.accelerator(shortcut);
    }
    builder.build(app)
}

fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(
            app,
            "new-text",
            "New Text File",
            Some("CmdOrCtrl+N"),
        )?)
        .item(&item(
            app,
            "new-markdown",
            "New Markdown File",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .item(&item(app, "open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&item(
            app,
            "open-folder",
            "Open Folder…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item(
            app,
            "save-as",
            "Save As…",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .separator()
        .item(&item(app, "close", "Close Document", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit 7TXT"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Redo", Some("Shift+CmdOrCtrl+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find", "Find", Some("CmdOrCtrl+F"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "mode-edit", "Edit", Some("CmdOrCtrl+1"))?)
        .item(&item(
            app,
            "mode-split",
            "Split Preview",
            Some("CmdOrCtrl+2"),
        )?)
        .item(&item(
            app,
            "mode-preview",
            "Markdown Preview",
            Some("CmdOrCtrl+3"),
        )?)
        .build()?;
    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&view)
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .menu(|app| menu(app))
        .on_menu_event(|app, event| {
            let _ = app.emit_to("main", "menu-action", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            open_recent,
            open_folder,
            browse_folder,
            refresh_folder,
            save_as,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running 7TXT");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_browser_lists_folders_and_supported_files() {
        let folder = std::env::temp_dir().join(format!("7txt-file-browser-{}", std::process::id()));
        fs::create_dir_all(folder.join("notes")).expect("create notes folder");
        fs::create_dir_all(folder.join("node_modules")).expect("create nested folder");
        fs::write(folder.join("readme.md"), "# Read me").expect("create Markdown file");
        fs::write(folder.join("notes").join("draft.txt"), "Draft").expect("create text file");
        fs::write(folder.join("notes").join("image.png"), "not text")
            .expect("create unsupported file");
        let result = read_browser_directory(folder.clone());
        let _ = fs::remove_dir_all(&folder);
        let browser = result.expect("folder should be readable");
        assert_eq!(browser.entries.len(), 3);
        assert!(browser.entries.iter().any(|entry| entry.name == "notes"));
        assert!(browser
            .entries
            .iter()
            .any(|entry| entry.name == "node_modules"));
        assert!(browser
            .entries
            .iter()
            .any(|entry| entry.name == "readme.md"));
    }
}
