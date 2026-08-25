mod text_encoding;

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use rfd::FileDialog;
use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, RunEvent, Runtime, State,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    modified_millis: u64,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedFile {
    name: String,
    path: String,
}

#[derive(Default)]
struct PendingExternalFiles {
    paths: Mutex<Vec<String>>,
    frontend_ready: AtomicBool,
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

fn read_browser_directory(path: PathBuf, show_hidden: bool) -> Result<FileBrowser, String> {
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
        if !show_hidden && name.starts_with('.') {
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

fn reveal_text_file_folder(path: PathBuf, show_hidden: bool) -> Result<FileBrowser, String> {
    if !is_supported_text_path(&path) {
        return Err("7TXT can reveal plain text and Markdown files only.".to_owned());
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "That file is unavailable.".to_owned())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Only regular text files can be revealed here.".to_owned());
    }
    let real_path = fs::canonicalize(&path).map_err(|_| "That file is unavailable.".to_owned())?;
    let parent = real_path
        .parent()
        .ok_or_else(|| "That file has no containing folder.".to_owned())?;
    read_browser_directory(parent.to_path_buf(), show_hidden)
}

fn initial_open_paths() -> Vec<PathBuf> {
    env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file() && is_supported_text_path(path))
        .collect()
}

fn queue_external_open_paths<R: Runtime>(
    app: &AppHandle<R>,
    paths: impl IntoIterator<Item = PathBuf>,
) {
    let paths = paths
        .into_iter()
        .filter(|path| path.is_file() && is_supported_text_path(path))
        .filter_map(|path| fs::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return;
    }

    let frontend_ready = {
        let state = app.state::<PendingExternalFiles>();
        let mut pending = state
            .paths
            .lock()
            .expect("external file queue lock poisoned");
        for path in &paths {
            if !pending.contains(path) {
                pending.push(path.clone());
            }
        }
        state.frontend_ready.load(Ordering::Acquire)
    };
    if frontend_ready {
        let _ = app.emit_to("main", "external-open-files", &paths);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
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
        .map(|path| read_browser_directory(path, false))
        .transpose()
}

#[tauri::command]
fn browse_folder(path: Option<String>, show_hidden: Option<bool>) -> Result<FileBrowser, String> {
    let target = match path {
        Some(path) => PathBuf::from(path),
        None => documents_directory(&home_directory()?),
    };
    read_browser_directory(target, show_hidden.unwrap_or(false))
}

#[tauri::command]
fn refresh_folder(path: String, show_hidden: Option<bool>) -> Result<FileBrowser, String> {
    read_browser_directory(PathBuf::from(path), show_hidden.unwrap_or(false))
}

#[tauri::command]
fn reveal_file_folder(path: String, show_hidden: Option<bool>) -> Result<FileBrowser, String> {
    reveal_text_file_folder(PathBuf::from(path), show_hidden.unwrap_or(false))
}

#[tauri::command]
fn take_pending_open_files(state: State<PendingExternalFiles>) -> Vec<String> {
    state.frontend_ready.store(true, Ordering::Release);
    let mut pending = state
        .paths
        .lock()
        .expect("external file queue lock poisoned");
    std::mem::take(&mut *pending)
}

#[tauri::command]
fn file_fingerprint(path: String) -> Result<FileFingerprint, String> {
    let path = PathBuf::from(path);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "That file is unavailable.".to_owned())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Only regular text files can be watched here.".to_owned());
    }
    let modified_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    Ok(FileFingerprint {
        modified_millis,
        size: metadata.len(),
    })
}

fn valid_browser_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("Use a simple file or folder name, without a path.".to_owned());
    }
    Ok(name)
}

fn regular_browser_path(path: PathBuf) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "That file or folder is unavailable.".to_owned())?;
    if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
        return Err("Choose a regular file or folder.".to_owned());
    }
    fs::canonicalize(path).map_err(|_| "That file or folder is unavailable.".to_owned())
}

#[tauri::command]
fn create_browser_entry(
    parent_path: String,
    name: String,
    kind: String,
) -> Result<FolderEntry, String> {
    let parent = regular_browser_path(PathBuf::from(parent_path))?;
    if !parent.is_dir() {
        return Err("Choose a folder to create an item in.".to_owned());
    }
    let name = valid_browser_name(&name)?;
    let target = parent.join(name);
    if target.exists() {
        return Err("An item with that name already exists.".to_owned());
    }
    match kind.as_str() {
        "directory" => {
            fs::create_dir(&target).map_err(|error| format!("Could not create folder: {error}"))?
        }
        "file" => {
            if !is_supported_text_path(&target) {
                return Err("New files must use .txt, .md, or .markdown.".to_owned());
            }
            fs::write(&target, b"").map_err(|error| format!("Could not create file: {error}"))?;
        }
        _ => return Err("Choose a text file or folder to create.".to_owned()),
    }
    Ok(FolderEntry {
        name: name.to_owned(),
        path: target.to_string_lossy().into_owned(),
        kind,
    })
}

#[tauri::command]
fn rename_browser_entry(path: String, name: String) -> Result<String, String> {
    let source = regular_browser_path(PathBuf::from(path))?;
    let parent = source
        .parent()
        .ok_or_else(|| "That item cannot be renamed.".to_owned())?;
    let target = parent.join(valid_browser_name(&name)?);
    if target.exists() {
        return Err("An item with that name already exists.".to_owned());
    }
    fs::rename(&source, &target).map_err(|error| format!("Could not rename item: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn move_browser_entry_to_trash(path: String) -> Result<(), String> {
    let source = regular_browser_path(PathBuf::from(path))?;
    let trash = home_directory()?.join(".Trash");
    fs::create_dir_all(&trash).map_err(|error| format!("Could not open Trash: {error}"))?;
    let name = source
        .file_name()
        .ok_or_else(|| "That item cannot be moved to Trash.".to_owned())?
        .to_string_lossy();
    let mut target = trash.join(name.as_ref());
    let mut suffix = 2usize;
    while target.exists() {
        target = trash.join(format!("{} {}", name, suffix));
        suffix += 1;
    }
    fs::rename(&source, &target).map_err(|error| {
        format!("Could not move this item to Trash. If it is on another disk, move it in Finder: {error}")
    })
}

#[tauri::command]
fn export_document(
    suggested_name: String,
    content: String,
    extension: String,
) -> Result<Option<ExportedFile>, String> {
    let extension = extension.trim_start_matches('.').to_ascii_lowercase();
    if !matches!(extension.as_str(), "html" | "htm") {
        return Err("7TXT can export this document as HTML.".to_owned());
    }
    let fallback_name = if suggested_name
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        suggested_name
    } else {
        format!(
            "{}.{}",
            suggested_name.trim().trim_end_matches('.'),
            extension
        )
    };
    let path = FileDialog::new()
        .add_filter("HTML", &[extension.as_str()])
        .set_file_name(&fallback_name)
        .save_file();
    path.map(|path| {
        fs::write(&path, content).map_err(|error| format!("Could not export HTML: {error}"))?;
        let real_path = fs::canonicalize(&path)
            .map_err(|_| "The exported file could not be resolved.".to_owned())?;
        Ok(ExportedFile {
            name: text_file_name(&real_path),
            path: real_path.to_string_lossy().into_owned(),
        })
    })
    .transpose()
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
        .item(&item(app, "print", "Print…", Some("CmdOrCtrl+P"))?)
        .item(&item(app, "export-html", "Export HTML…", None)?)
        .item(&item(app, "export-pdf", "Export PDF…", None)?)
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
        .item(&item(
            app,
            "go-to-line",
            "Go to Line…",
            Some("CmdOrCtrl+L"),
        )?)
        .item(&item(
            app,
            "command-palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
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
        .separator()
        .item(&item(app, "toggle-editor-split", "Split Editor", None)?)
        .item(&item(app, "zen", "Zen Mode", None)?)
        .build()?;
    MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&view)
        .build()
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingExternalFiles::default())
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
            reveal_file_folder,
            take_pending_open_files,
            file_fingerprint,
            create_browser_entry,
            rename_browser_entry,
            move_browser_entry_to_trash,
            export_document,
            save_as,
            write_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building 7TXT");
    queue_external_open_paths(app.handle(), initial_open_paths());
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = event {
            queue_external_open_paths(
                app,
                urls.into_iter().filter_map(|url| url.to_file_path().ok()),
            );
        }
    });
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
        let result = read_browser_directory(folder.clone(), false);
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

    #[test]
    fn revealing_a_text_file_browses_its_containing_folder() {
        let folder =
            std::env::temp_dir().join(format!("7txt-reveal-folder-{}", std::process::id()));
        fs::create_dir_all(&folder).expect("create reveal folder");
        let document = folder.join("notes.txt");
        fs::write(&document, "Notes").expect("create text file");
        let result = reveal_text_file_folder(document, false);
        let _ = fs::remove_dir_all(&folder);
        let browser = result.expect("text file parent should be browseable");
        assert!(browser
            .entries
            .iter()
            .any(|entry| entry.name == "notes.txt"));
    }
}
