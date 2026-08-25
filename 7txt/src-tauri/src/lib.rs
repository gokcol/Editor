mod text_encoding;

use std::{
    fs,
    path::{Path, PathBuf},
};

use rfd::FileDialog;
use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Runtime,
};

const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FOLDER_ENTRIES: usize = 3_000;
const MAX_FOLDER_DEPTH: usize = 18;
const IGNORED_FOLDER_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

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
    children: Vec<FolderEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFolder {
    name: String,
    path: String,
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
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Folder")
        .to_owned()
}

fn is_ignored_folder(name: &str) -> bool {
    name.starts_with('.') || IGNORED_FOLDER_NAMES.contains(&name)
}

fn collect_folder_entries(
    folder: &Path,
    depth: usize,
    count: &mut usize,
    truncated: &mut bool,
) -> Vec<FolderEntry> {
    if depth >= MAX_FOLDER_DEPTH || *count >= MAX_FOLDER_ENTRIES {
        *truncated = true;
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut collected = Vec::new();
    for entry in entries.flatten() {
        if *count >= MAX_FOLDER_ENTRIES {
            *truncated = true;
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if is_ignored_folder(&name) {
                continue;
            }
            let children = collect_folder_entries(&path, depth + 1, count, truncated);
            if !children.is_empty() {
                *count += 1;
                collected.push(FolderEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    kind: "directory".to_owned(),
                    children,
                });
            }
        } else if metadata.is_file() && is_supported_text_path(&path) {
            *count += 1;
            collected.push(FolderEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: "file".to_owned(),
                children: Vec::new(),
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
    collected
}

fn read_project_folder(path: PathBuf) -> Result<ProjectFolder, String> {
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "That folder is unavailable.".to_owned())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Choose a regular folder to browse its text and Markdown files.".to_owned());
    }
    let real_path =
        fs::canonicalize(&path).map_err(|_| "That folder is unavailable.".to_owned())?;
    let mut count = 0;
    let mut truncated = false;
    let entries = collect_folder_entries(&real_path, 0, &mut count, &mut truncated);
    Ok(ProjectFolder {
        name: folder_name(&real_path),
        path: real_path.to_string_lossy().into_owned(),
        entries,
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
fn open_folder() -> Result<Option<ProjectFolder>, String> {
    FileDialog::new()
        .pick_folder()
        .map(read_project_folder)
        .transpose()
}

#[tauri::command]
fn refresh_folder(path: String) -> Result<ProjectFolder, String> {
    read_project_folder(PathBuf::from(path))
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
    fn project_tree_keeps_supported_files_and_ignores_generated_directories() {
        let folder = std::env::temp_dir().join(format!("7txt-project-tree-{}", std::process::id()));
        fs::create_dir_all(folder.join("notes")).expect("create notes folder");
        fs::create_dir_all(folder.join("node_modules")).expect("create ignored folder");
        fs::write(folder.join("readme.md"), "# Read me").expect("create Markdown file");
        fs::write(folder.join("notes").join("draft.txt"), "Draft").expect("create text file");
        fs::write(folder.join("notes").join("image.png"), "not text")
            .expect("create unsupported file");
        fs::write(folder.join("node_modules").join("ignored.md"), "Ignored")
            .expect("create ignored file");
        let result = read_project_folder(folder.clone());
        let _ = fs::remove_dir_all(&folder);
        let tree = result.expect("project folder should be readable");
        assert_eq!(tree.entries.len(), 2);
        assert!(tree.entries.iter().any(|entry| entry.name == "readme.md"));
        let notes = tree
            .entries
            .iter()
            .find(|entry| entry.name == "notes")
            .unwrap();
        assert_eq!(notes.children.len(), 1);
        assert_eq!(notes.children[0].name, "draft.txt");
    }
}
