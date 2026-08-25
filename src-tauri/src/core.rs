//! Native project, file, recents, and settings commands for Yedit.
//!
//! This module intentionally does not expose a general-purpose filesystem API
//! to the webview. Project writes are contained to an opened workspace and a
//! standalone file can only be saved through an opaque, per-window handle.

use crate::{
    models::{
        extension_for_source_type, is_supported_source, source_type_for_path, AppSettings,
        Canceled, DecodedSourceFile, DuplicatedFileResult, ExternalOpenFilesResult, FileNode,
        LegacyProjectInput, OpenRecentResult, OpenedSourceFile, OpenedSourceOrCanceled, Project,
        ProjectChange, ProjectOrCanceled, ProjectSourceFile, ProjectWatchUpdate, RecentEntry,
        RelativePathResult, RenamedFileResult, SaveAsResult, StandaloneSourceFile, UnwatchResponse,
        WatchResponse, WriteOpenedFileResult, MAX_PROJECT_TREE_DEPTH, MAX_RECENT_ENTRIES,
    },
    state::{CoreState, PendingExternalFiles, ProjectWatcher},
    text_encoding,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;
use uuid::Uuid;

const PROJECT_MANIFEST_NAMES: &[&str] = &[".yedit.json", ".diagram-foundry.json"];
const IGNORED_DIRECTORIES: &[&str] = &[".git", "node_modules", ".DS_Store", "dist", "build"];
const MAX_PROJECT_WATCHERS: usize = 12;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Clone, Debug)]
struct Workspace {
    root: PathBuf,
    real_root: PathBuf,
}

#[derive(Clone, Debug)]
struct ProjectFile {
    target: PathBuf,
    relative_path: String,
}

#[derive(Clone, Debug)]
struct ProjectDestination {
    target: PathBuf,
    relative_path: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecentEntry {
    id: String,
    kind: String,
    target: PathBuf,
    name: String,
    opened_at: i64,
}

fn error(message: impl Into<String>) -> String {
    message.into()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn metadata_millis(time: Result<SystemTime, std::io::Error>) -> f64 {
    time.unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

fn normalize_absolute(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

fn absolute_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err(error("Choose a path first."));
    }
    let input = PathBuf::from(value);
    let absolute = if input.is_absolute() {
        input
    } else {
        std::env::current_dir()
            .map_err(|cause| error(format!("Could not resolve that path: {cause}")))?
            .join(input)
    };
    Ok(normalize_absolute(absolute))
}

fn is_inside(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

fn assert_project_relative_path(
    workspace: &Workspace,
    relative_path: &str,
    label: &str,
) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err(error(format!(
            "Choose a {label} inside the current project."
        )));
    }
    let relative = Path::new(relative_path);
    if relative.is_absolute() || relative_path.contains('\\') {
        return Err(error("That file is outside the current project."));
    }
    let target = normalize_absolute(workspace.root.join(relative));
    if target == workspace.root {
        return Err(error("The project folder itself cannot be changed here."));
    }
    if !target.starts_with(&workspace.root) {
        return Err(error("That file is outside the current project."));
    }
    Ok(target)
}

fn relative_path_for(root: &Path, target: &Path) -> Result<String, String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| error("That file is outside the current project."))?;
    Ok(relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn project_workspace(root: &str) -> Result<Workspace, String> {
    if root.trim().is_empty() {
        return Err(error("Choose a project folder first."));
    }
    let root = absolute_path(root)?;
    let metadata =
        fs::metadata(&root).map_err(|_| error("The selected project folder is unavailable."))?;
    if !metadata.is_dir() {
        return Err(error("The selected project folder is unavailable."));
    }
    let real_root = fs::canonicalize(&root)
        .map_err(|_| error("The selected project folder is unavailable."))?;
    Ok(Workspace { root, real_root })
}

fn project_file(workspace: &Workspace, relative_path: &str) -> Result<ProjectFile, String> {
    let target = assert_project_relative_path(workspace, relative_path, "file")?;
    let metadata =
        fs::symlink_metadata(&target).map_err(|_| error("That project file is unavailable."))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(error("Only regular project files can be changed here."));
    }
    let real_target =
        fs::canonicalize(&target).map_err(|_| error("That project file is unavailable."))?;
    if !is_inside(&workspace.real_root, &real_target) {
        return Err(error("That file resolves outside the current project."));
    }
    Ok(ProjectFile {
        relative_path: relative_path_for(&workspace.root, &target)?,
        target,
    })
}

fn regular_standalone_file(target: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(target).map_err(|_| error("That source file is unavailable."))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            "Only regular source files can be opened or saved directly.",
        ));
    }
    Ok(())
}

fn secure_existing_parent(workspace: &Workspace, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| error("The destination folder is unavailable."))?;
    let metadata =
        fs::metadata(parent).map_err(|_| error("The destination folder is unavailable."))?;
    if !metadata.is_dir() {
        return Err(error("The destination folder is unavailable."));
    }
    let real_parent =
        fs::canonicalize(parent).map_err(|_| error("The destination folder is unavailable."))?;
    if !is_inside(&workspace.real_root, &real_parent) {
        return Err(error(
            "The destination resolves outside the current project.",
        ));
    }
    Ok(())
}

fn secure_create_parent(workspace: &Workspace, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| error("The destination folder is unavailable."))?;
    let relative_parent = parent
        .strip_prefix(&workspace.root)
        .map_err(|_| error("That file is outside the current project."))?;
    let mut current = workspace.root.clone();
    for component in relative_parent.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                    return Err(error("The destination folder is unavailable."));
                }
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|_| error("The destination folder is unavailable."))?;
            }
            Err(_) => return Err(error("The destination folder is unavailable.")),
        }
        let real_current = fs::canonicalize(&current)
            .map_err(|_| error("The destination folder is unavailable."))?;
        if !is_inside(&workspace.real_root, &real_current) {
            return Err(error(
                "The destination resolves outside the current project.",
            ));
        }
    }
    secure_existing_parent(workspace, target)
}

fn project_destination(
    workspace: &Workspace,
    relative_path: &str,
) -> Result<ProjectDestination, String> {
    let target = assert_project_relative_path(workspace, relative_path, "file")?;
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err(error("A file with that name already exists.")),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
        Err(cause) => {
            return Err(error(format!(
                "Could not inspect that destination: {cause}"
            )))
        }
    }
    secure_existing_parent(workspace, &target)?;
    Ok(ProjectDestination {
        relative_path: relative_path_for(&workspace.root, &target)?,
        target,
    })
}

fn project_create_destination(
    workspace: &Workspace,
    relative_path: &str,
) -> Result<ProjectDestination, String> {
    let target = assert_project_relative_path(workspace, relative_path, "file")?;
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err(error("A file with that name already exists.")),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
        Err(cause) => {
            return Err(error(format!(
                "Could not inspect that destination: {cause}"
            )))
        }
    }
    secure_create_parent(workspace, &target)?;
    Ok(ProjectDestination {
        relative_path: relative_path_for(&workspace.root, &target)?,
        target,
    })
}

fn write_no_follow_bytes(target: &Path, content: &[u8], create_new: bool) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .truncate(!create_new)
        .create_new(create_new);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(target)
        .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
    file.write_all(content)
        .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
    file.flush()
        .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
    Ok(())
}

fn write_no_follow(target: &Path, content: &str, create_new: bool) -> Result<(), String> {
    write_no_follow_bytes(target, content.as_bytes(), create_new)
}

fn decode_source(target: &Path, encoding: Option<&str>) -> Result<DecodedSourceFile, String> {
    let bytes = fs::read(target)
        .map_err(|cause| error(format!("Could not read that source file: {cause}")))?;
    if !bytes.starts_with(&[0xFF, 0xFE]) && !bytes.starts_with(&[0xFE, 0xFF]) && bytes.contains(&0)
    {
        return Err(error(
            "That file appears to be binary data. Yedit can open text in any filename extension.",
        ));
    }
    let decoded = text_encoding::decode(&bytes, encoding)?;
    Ok(DecodedSourceFile {
        content: decoded.content,
        encoding: decoded.encoding,
    })
}

fn write_source_no_follow(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
    create_new: bool,
) -> Result<String, String> {
    let (bytes, encoding) = text_encoding::encode(content, encoding)?;
    write_no_follow_bytes(target, &bytes, create_new)?;
    Ok(encoding)
}

fn save_standalone_source_encoded(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
) -> Result<String, String> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(error(
                    "Only regular source files can be opened or saved directly.",
                ));
            }
            let encoding = write_source_no_follow(target, content, encoding, false)?;
            regular_standalone_file(target)?;
            Ok(encoding)
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            let encoding = write_source_no_follow(target, content, encoding, true)?;
            regular_standalone_file(target)?;
            Ok(encoding)
        }
        Err(cause) => Err(error(format!(
            "Could not inspect that source file: {cause}"
        ))),
    }
}

fn visible_project_path(relative_path: &Path) -> bool {
    relative_path.components().all(|component| {
        let Component::Normal(name) = component else {
            return true;
        };
        let name = name.to_string_lossy();
        (!name.starts_with('.')
            || PROJECT_MANIFEST_NAMES
                .iter()
                .any(|manifest| *manifest == name))
            && !IGNORED_DIRECTORIES.iter().any(|ignored| *ignored == name)
    })
}

fn build_tree(root: &Path, relative_path: &Path, depth: usize) -> Result<Vec<FileNode>, String> {
    if depth >= MAX_PROJECT_TREE_DEPTH {
        return Ok(Vec::new());
    }
    let absolute = root.join(relative_path);
    let entries = fs::read_dir(&absolute)
        .map_err(|cause| error(format!("Could not read the project folder: {cause}")))?;
    let mut entries = entries
        .filter_map(Result::ok)
        .filter(|entry| visible_project_path(&relative_path.join(entry.file_name())))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_is_directory = left
            .file_type()
            .map(|type_| type_.is_dir())
            .unwrap_or(false);
        let right_is_directory = right
            .file_type()
            .map(|type_| type_.is_dir())
            .unwrap_or(false);
        right_is_directory.cmp(&left_is_directory).then_with(|| {
            left.file_name()
                .to_string_lossy()
                .cmp(&right.file_name().to_string_lossy())
        })
    });

    let mut nodes = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_relative = relative_path.join(&name);
        let child_absolute = root.join(&child_relative);
        let metadata = match fs::symlink_metadata(&child_absolute) {
            Ok(metadata) => metadata,
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => continue,
            Err(cause) => return Err(error(format!("Could not inspect a project item: {cause}"))),
        };
        let is_link = metadata.file_type().is_symlink();
        let is_directory = metadata.file_type().is_dir() && !is_link;
        let children = if is_directory {
            Some(build_tree(root, &child_relative, depth + 1)?)
        } else {
            None
        };
        nodes.push(FileNode {
            name: name.clone(),
            relative_path: relative_path_for(root, &child_absolute)?,
            kind: if is_directory { "directory" } else { "file" }.to_owned(),
            source_type: (!is_directory).then(|| source_type_for_path(Path::new(&name))),
            supported: (!is_directory).then(|| is_supported_source(Path::new(&name))),
            size: metadata.len(),
            modified_at: metadata_millis(metadata.modified()),
            created_at: metadata_millis(metadata.created()),
            is_symbolic_link: is_link,
            children,
        });
    }
    Ok(nodes)
}

fn project_payload(root: &str) -> Result<Project, String> {
    let workspace = project_workspace(root)?;
    let name = workspace
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path_text(&workspace.root));
    Ok(Project {
        root: path_text(&workspace.root),
        name,
        tree: build_tree(&workspace.root, Path::new(""), 0)?,
    })
}

fn safe_project_name(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = compact.chars().take(80).collect::<String>();
    if truncated.is_empty() {
        "Untitled Project".to_owned()
    } else {
        truncated
    }
}

fn current_data_path(state: &CoreState, filename: &str) -> Result<PathBuf, String> {
    let directory = state
        .app
        .path()
        .app_data_dir()
        .map_err(|cause| error(format!("Could not find Yedit's settings folder: {cause}")))?;
    Ok(directory.join(filename))
}

fn legacy_data_paths(state: &CoreState, filename: &str) -> Vec<PathBuf> {
    let Ok(home) = state.app.path().home_dir() else {
        return Vec::new();
    };
    let app_support = home.join("Library").join("Application Support");
    ["Yedit", "Diagram Foundry", "com.yedit.app", "Yedit Tauri"]
        .iter()
        .map(|name| app_support.join(name).join(filename))
        .collect()
}

fn write_atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| error("Yedit's settings folder is unavailable."))?;
    fs::create_dir_all(parent)
        .map_err(|cause| error(format!("Could not create Yedit's settings folder: {cause}")))?;
    let text = serde_json::to_string_pretty(value)
        .map_err(|cause| error(format!("Could not prepare Yedit's settings: {cause}")))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings"),
        Uuid::new_v4()
    ));
    fs::write(&temporary, format!("{text}\n"))
        .map_err(|cause| error(format!("Could not write Yedit's settings: {cause}")))?;
    fs::rename(&temporary, path)
        .map_err(|cause| error(format!("Could not save Yedit's settings: {cause}")))?;
    Ok(())
}

/// Reads Yedit's current data first, then transparently imports legacy app
/// locations. Parse errors intentionally fall through to the next
/// candidate so an interrupted older write cannot hide usable preferences.
fn read_json_with_migration(state: &CoreState, filename: &str) -> Option<(Value, bool)> {
    let current = current_data_path(state, filename).ok()?;
    let candidates = std::iter::once(current.clone()).chain(legacy_data_paths(state, filename));
    for candidate in candidates {
        let Ok(text) = fs::read_to_string(&candidate) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        return Some((value, candidate != current));
    }
    None
}

fn normalize_recent_entry(candidate: &Value) -> Option<StoredRecentEntry> {
    let kind = candidate.get("kind")?.as_str()?;
    if kind != "project" && kind != "file" {
        return None;
    }
    let target = candidate
        .get("target")
        .or_else(|| candidate.get("path"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| absolute_path(value).ok())?;
    let supplied_name = candidate
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = if supplied_name.is_empty() {
        target
            .file_name()?
            .to_string_lossy()
            .chars()
            .take(180)
            .collect()
    } else {
        supplied_name.chars().take(180).collect()
    };
    let id = candidate
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| {
            value.starts_with("recent-")
                && value.len() >= 15
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("recent-{}", Uuid::new_v4()));
    let timestamp = candidate
        .get("openedAt")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.min(now_millis() as f64) as i64)
        .unwrap_or_else(now_millis);
    Some(StoredRecentEntry {
        id,
        kind: kind.to_owned(),
        target,
        name,
        opened_at: timestamp,
    })
}

fn normalize_recent_entries(value: &Value) -> Vec<StoredRecentEntry> {
    let entries = value
        .as_array()
        .or_else(|| value.get("entries").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let mut entries = entries
        .iter()
        .filter_map(normalize_recent_entry)
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.opened_at.cmp(&left.opened_at));
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(format!("{}:{}", entry.kind, path_text(&entry.target))))
        .take(MAX_RECENT_ENTRIES)
        .collect()
}

fn public_recent_entries(entries: &[StoredRecentEntry]) -> Vec<RecentEntry> {
    entries
        .iter()
        .map(|entry| RecentEntry {
            id: entry.id.clone(),
            kind: entry.kind.clone(),
            name: entry.name.clone(),
            path: path_text(&entry.target),
            opened_at: entry.opened_at,
        })
        .collect()
}

fn read_recent_entries(state: &CoreState) -> Vec<StoredRecentEntry> {
    let Some((value, migrated)) = read_json_with_migration(state, "recent-items.json") else {
        return Vec::new();
    };
    let entries = normalize_recent_entries(&value);
    if migrated {
        let _ = write_recent_entries(state, &entries);
    }
    entries
}

fn write_recent_entries(state: &CoreState, entries: &[StoredRecentEntry]) -> Result<(), String> {
    let path = current_data_path(state, "recent-items.json")?;
    let stored = entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "kind": entry.kind,
                "target": path_text(&entry.target),
                "name": entry.name,
                "openedAt": entry.opened_at,
            })
        })
        .collect::<Vec<_>>();
    write_atomic_json(&path, &json!({ "version": 1, "entries": stored }))
}

fn mutate_recent_entries<F>(state: &CoreState, mutator: F) -> Result<Vec<StoredRecentEntry>, String>
where
    F: FnOnce(Vec<StoredRecentEntry>) -> Vec<StoredRecentEntry>,
{
    let _guard = state
        .recent_entries_lock
        .lock()
        .map_err(|_| error("Yedit's recent-items store is unavailable."))?;
    let value = serde_json::to_value(mutator(read_recent_entries(state)))
        .map_err(|cause| error(format!("Could not prepare recent items: {cause}")))?;
    let entries = normalize_recent_entries(&value);
    write_recent_entries(state, &entries)?;
    Ok(entries)
}

fn remember_recent_entry(
    state: &CoreState,
    kind: &str,
    target: &Path,
    name: &str,
) -> Result<Vec<StoredRecentEntry>, String> {
    let target = normalize_absolute(target.to_path_buf());
    let name = if name.trim().is_empty() {
        target
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_text(&target))
    } else {
        name.trim().chars().take(180).collect()
    };
    mutate_recent_entries(state, |current| {
        let id = current
            .iter()
            .find(|entry| entry.kind == kind && entry.target == target)
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| format!("recent-{}", Uuid::new_v4()));
        let fresh = StoredRecentEntry {
            id,
            kind: kind.to_owned(),
            target,
            name,
            opened_at: now_millis(),
        };
        let fresh_for_filter = fresh.clone();
        std::iter::once(fresh)
            .chain(current.into_iter().filter(move |entry| {
                !(entry.kind == fresh_for_filter.kind && entry.target == fresh_for_filter.target)
            }))
            .collect()
    })
}

fn remember_recent_entry_best_effort(state: &CoreState, kind: &str, target: &Path, name: &str) {
    if let Err(cause) = remember_recent_entry(state, kind, target, name) {
        log::warn!("Could not update Yedit recents: {cause}");
    }
}

fn remembered_project_payload(state: &CoreState, root: &str) -> Result<Project, String> {
    let project = project_payload(root)?;
    remember_recent_entry_best_effort(state, "project", Path::new(&project.root), &project.name);
    Ok(project)
}

fn standalone_files_for<'a>(
    files: &'a mut std::collections::HashMap<String, std::collections::HashMap<String, PathBuf>>,
    window_label: &str,
) -> &'a mut std::collections::HashMap<String, PathBuf> {
    files.entry(window_label.to_owned()).or_default()
}

fn grant_standalone_file(
    state: &CoreState,
    window_label: &str,
    target: &Path,
) -> Result<String, String> {
    let mut files = state
        .standalone_files
        .lock()
        .map_err(|_| error("Yedit's opened-file permissions are unavailable."))?;
    let known = standalone_files_for(&mut files, window_label);
    if let Some((handle, _)) = known
        .iter()
        .find(|(_, known_target)| *known_target == target)
    {
        return Ok(handle.clone());
    }
    let handle = format!("source-{}", Uuid::new_v4());
    known.insert(handle.clone(), target.to_path_buf());
    Ok(handle)
}

fn opened_standalone_file(
    state: &CoreState,
    window_label: &str,
    file_handle: &str,
) -> Result<PathBuf, String> {
    if file_handle.trim().is_empty() {
        return Err(error("The opened file reference is invalid."));
    }
    let files = state
        .standalone_files
        .lock()
        .map_err(|_| error("Yedit's opened-file permissions are unavailable."))?;
    let target = files
        .get(window_label)
        .and_then(|files| files.get(file_handle))
        .cloned()
        .ok_or_else(|| {
            error("This source file is no longer available to Yedit. Open it again to continue.")
        })?;
    regular_standalone_file(&target)?;
    Ok(target)
}

fn project_relative_source_path(project_root: Option<&str>, target: &Path) -> Option<String> {
    let project_root = project_root?.trim();
    if project_root.is_empty() {
        return None;
    }
    let workspace = project_workspace(project_root).ok()?;
    let real_target = fs::canonicalize(target).ok()?;
    if !is_inside(&workspace.real_root, &real_target) {
        return None;
    }
    let relative = real_target.strip_prefix(&workspace.real_root).ok()?;
    let relative = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    project_file(&workspace, &relative)
        .ok()
        .map(|source| source.relative_path)
}

fn standalone_source_payload(
    state: &CoreState,
    window_label: &str,
    file_path: &Path,
    project_root: Option<&str>,
    encoding: Option<&str>,
) -> Result<OpenedSourceFile, String> {
    let target = absolute_path(&path_text(file_path))?;
    regular_standalone_file(&target)?;
    let decoded = decode_source(&target, encoding)?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    if let Some(relative_path) = project_relative_source_path(project_root, &target) {
        return Ok(OpenedSourceFile::Project(ProjectSourceFile {
            name,
            source_type: source_type_for_path(&target),
            content: decoded.content,
            encoding: decoded.encoding,
            relative_path,
        }));
    }
    Ok(OpenedSourceFile::Standalone(StandaloneSourceFile {
        name,
        source_type: source_type_for_path(&target),
        content: decoded.content,
        encoding: decoded.encoding,
        file_handle: grant_standalone_file(state, window_label, &target)?,
    }))
}

async fn selected_file_path(
    receiver: oneshot::Receiver<Result<Option<PathBuf>, String>>,
) -> Result<Option<PathBuf>, String> {
    receiver
        .await
        .map_err(|_| error("The native file picker did not return a result."))?
}

fn finish_dialog_path(selected: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    selected
        .map(|file| {
            file.into_path()
                .map_err(|cause| error(format!("The selected path is unavailable: {cause}")))
        })
        .transpose()
}

async fn pick_project_folder(window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Open a Yedit project")
        .set_can_create_directories(true)
        .pick_folder(move |selected| {
            let _ = sender.send(finish_dialog_path(selected));
        });
    selected_file_path(receiver).await
}

async fn pick_project_parent(window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Choose where to create the project")
        .set_can_create_directories(true)
        .pick_folder(move |selected| {
            let _ = sender.send(finish_dialog_path(selected));
        });
    selected_file_path(receiver).await
}

async fn pick_source_file(window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Open a file in Yedit")
        .pick_file(move |selected| {
            let _ = sender.send(finish_dialog_path(selected));
        });
    selected_file_path(receiver).await
}

fn save_file_name(suggested_name: &str, source_type: &str) -> String {
    let source_name = Path::new(suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("diagram");
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("diagram");
    format!("{}.{}", stem, extension_for_source_type(source_type))
}

async fn save_source_file(
    window: &WebviewWindow,
    suggested_name: &str,
    source_type: &str,
) -> Result<Option<PathBuf>, String> {
    let extension = extension_for_source_type(source_type);
    let (sender, receiver) = oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Save source as")
        .set_file_name(save_file_name(suggested_name, source_type))
        .add_filter(format!("{source_type} source"), &[extension])
        .save_file(move |selected| {
            let _ = sender.send(finish_dialog_path(selected));
        });
    selected_file_path(receiver).await
}

/// Opens a project folder through the native macOS picker.
#[tauri::command]
pub async fn project_open(
    window: WebviewWindow,
    state: State<'_, CoreState>,
) -> Result<ProjectOrCanceled, String> {
    let Some(root) = pick_project_folder(&window).await? else {
        return Ok(ProjectOrCanceled::Canceled(Canceled { canceled: true }));
    };
    Ok(ProjectOrCanceled::Project(remembered_project_payload(
        state.inner(),
        &path_text(&root),
    )?))
}

/// Opens an individual regular text file. Known source extensions receive
/// their specialised editor mode; all other text opens as plain text.
#[tauri::command]
pub async fn project_open_file(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    project_root: Option<String>,
    encoding: Option<String>,
) -> Result<OpenedSourceOrCanceled, String> {
    let Some(path) = pick_source_file(&window).await? else {
        return Ok(OpenedSourceOrCanceled::Canceled(Canceled {
            canceled: true,
        }));
    };
    let source = standalone_source_payload(
        state.inner(),
        window.label(),
        &path,
        project_root.as_deref(),
        encoding.as_deref(),
    )?;
    if let OpenedSourceFile::Standalone(file) = &source {
        if let Some(target) = state.standalone_files.lock().ok().and_then(|files| {
            files
                .get(window.label())
                .and_then(|files| files.get(&file.file_handle))
                .cloned()
        }) {
            remember_recent_entry_best_effort(state.inner(), "file", &target, &file.name);
        }
    }
    Ok(OpenedSourceOrCanceled::Source(source))
}

/// Drains Finder-delivered file paths. Paths never cross the webview boundary:
/// the native side validates and decodes each one before returning the normal
/// opaque opened-file payload used by the Open command.
#[tauri::command]
pub fn take_pending_external_files(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    pending: State<'_, PendingExternalFiles>,
    project_root: Option<String>,
) -> Result<ExternalOpenFilesResult, String> {
    let mut files = Vec::new();
    let mut errors = Vec::new();
    for path in pending.take() {
        match standalone_source_payload(
            state.inner(),
            window.label(),
            &path,
            project_root.as_deref(),
            None,
        ) {
            Ok(source) => {
                if let OpenedSourceFile::Standalone(file) = &source {
                    remember_recent_entry_best_effort(state.inner(), "file", &path, &file.name);
                }
                files.push(source);
            }
            Err(cause) => {
                let name = path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "That file".to_owned());
                errors.push(format!("{name}: {cause}"));
            }
        }
    }
    Ok(ExternalOpenFilesResult { files, errors })
}

/// Creates Yedit's intentionally empty, predictable folder structure.
#[tauri::command]
pub async fn project_create(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    name: String,
) -> Result<ProjectOrCanceled, String> {
    let Some(parent) = pick_project_parent(&window).await? else {
        return Ok(ProjectOrCanceled::Canceled(Canceled { canceled: true }));
    };
    let parent = absolute_path(&path_text(&parent))?;
    let metadata =
        fs::metadata(&parent).map_err(|_| error("The selected project folder is unavailable."))?;
    if !metadata.is_dir() {
        return Err(error("The selected project folder is unavailable."));
    }
    let name = safe_project_name(&name);
    let root = parent.join(&name);
    match fs::symlink_metadata(&root) {
        Ok(_) => return Err(error("A folder with that project name already exists.")),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
        Err(cause) => return Err(error(format!("Could not create that project: {cause}"))),
    }
    fs::create_dir_all(root.join("diagrams"))
        .and_then(|_| fs::create_dir_all(root.join("documents")))
        .and_then(|_| fs::create_dir_all(root.join("notes")))
        .map_err(|cause| error(format!("Could not create that project: {cause}")))?;
    let manifest = json!({ "name": name, "version": 1 });
    fs::write(
        root.join(".yedit.json"),
        serde_json::to_string_pretty(&manifest)
            .map_err(|cause| error(format!("Could not prepare that project: {cause}")))?,
    )
    .map_err(|cause| error(format!("Could not create that project: {cause}")))?;
    Ok(ProjectOrCanceled::Project(remembered_project_payload(
        state.inner(),
        &path_text(&root),
    )?))
}

#[tauri::command]
pub fn project_refresh(root: String) -> Result<Project, String> {
    project_payload(&root)
}

#[tauri::command]
pub fn project_read_file(
    root: String,
    relative_path: String,
    encoding: Option<String>,
) -> Result<DecodedSourceFile, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &relative_path)?;
    decode_source(&source.target, encoding.as_deref())
}

#[tauri::command]
pub fn project_write_file(
    root: String,
    relative_path: String,
    content: String,
    encoding: Option<String>,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &relative_path)?;
    write_source_no_follow(&source.target, &content, encoding.as_deref(), false)?;
    // Recheck after the write so a changed symlink cannot leave a source with
    // a silently broken project binding.
    let source = project_file(&workspace, &source.relative_path)?;
    Ok(RelativePathResult {
        relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_create_file(
    root: String,
    relative_path: String,
    content: String,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace(&root)?;
    let destination = project_create_destination(&workspace, &relative_path)?;
    write_no_follow(&destination.target, &content, true)?;
    let source = project_file(&workspace, &destination.relative_path)?;
    Ok(RelativePathResult {
        relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_rename_file(
    root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<RenamedFileResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &from_relative_path)?;
    let destination_path = assert_project_relative_path(&workspace, &to_relative_path, "file")?;
    if source.target == destination_path {
        return Ok(RenamedFileResult {
            relative_path: source.relative_path,
            previous_relative_path: relative_path_for(&workspace.root, &destination_path)?,
        });
    }
    let destination = project_destination(&workspace, &to_relative_path)?;
    fs::rename(&source.target, &destination.target)
        .map_err(|cause| error(format!("Could not rename that project file: {cause}")))?;
    Ok(RenamedFileResult {
        relative_path: destination.relative_path,
        previous_relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_duplicate_file(
    root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<DuplicatedFileResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &from_relative_path)?;
    let destination = project_destination(&workspace, &to_relative_path)?;
    let contents = fs::read(&source.target)
        .map_err(|cause| error(format!("Could not read that project file: {cause}")))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut copied = options
        .open(&destination.target)
        .map_err(|cause| error(format!("Could not duplicate that project file: {cause}")))?;
    copied
        .write_all(&contents)
        .map_err(|cause| error(format!("Could not duplicate that project file: {cause}")))?;
    Ok(DuplicatedFileResult {
        relative_path: destination.relative_path,
        source_relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_delete_file(
    root: String,
    relative_path: String,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &relative_path)?;
    fs::remove_file(&source.target)
        .map_err(|cause| error(format!("Could not delete that project file: {cause}")))?;
    Ok(RelativePathResult {
        relative_path: source.relative_path,
    })
}

fn notify_event_type(kind: &EventKind) -> String {
    match kind {
        EventKind::Modify(_) => "change",
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any | EventKind::Other => "rename",
        _ => "change",
    }
    .to_owned()
}

fn queue_notify_event(root: &Path, event: Event, changes: &mut BTreeMap<String, String>) {
    let event_type = notify_event_type(&event.kind);
    for path in event.paths {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if !visible_project_path(relative) {
            continue;
        }
        let relative_path = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        changes.insert(relative_path, event_type.clone());
    }
}

fn flush_notify_changes(
    app: &tauri::AppHandle,
    window_label: &str,
    watch_id: &str,
    root: &str,
    changes: &mut BTreeMap<String, String>,
) {
    if changes.is_empty() {
        return;
    }
    let changes = std::mem::take(changes)
        .into_iter()
        .map(|(relative_path, event_type)| ProjectChange {
            relative_path,
            event_type,
        })
        .collect();
    let payload = ProjectWatchUpdate {
        watch_id: watch_id.to_owned(),
        root: root.to_owned(),
        changes,
        error: None,
        warning: None,
        mode: None,
    };
    let _ = app.emit_to(window_label, "project-changed", payload);
}

fn emit_watch_error(
    app: &tauri::AppHandle,
    window_label: &str,
    watch_id: &str,
    root: &str,
    message: String,
) {
    let payload = ProjectWatchUpdate {
        watch_id: watch_id.to_owned(),
        root: root.to_owned(),
        changes: Vec::new(),
        error: Some(message),
        warning: None,
        mode: Some("native".to_owned()),
    };
    let _ = app.emit_to(window_label, "project-changed", payload);
}

fn consume_project_watch_events(
    app: tauri::AppHandle,
    window_label: String,
    watch_id: String,
    root: PathBuf,
    receiver: Receiver<notify::Result<Event>>,
) {
    let root_text = path_text(&root);
    let mut changes = BTreeMap::new();
    loop {
        let event = match receiver.recv() {
            Ok(event) => event,
            Err(_) => return,
        };
        match event {
            Ok(event) => queue_notify_event(&root, event, &mut changes),
            Err(cause) => emit_watch_error(
                &app,
                &window_label,
                &watch_id,
                &root_text,
                cause.to_string(),
            ),
        }
        let deadline = Instant::now() + WATCH_DEBOUNCE;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(remaining) {
                Ok(Ok(event)) => queue_notify_event(&root, event, &mut changes),
                Ok(Err(cause)) => emit_watch_error(
                    &app,
                    &window_label,
                    &watch_id,
                    &root_text,
                    cause.to_string(),
                ),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        flush_notify_changes(&app, &window_label, &watch_id, &root_text, &mut changes);
    }
}

#[tauri::command]
pub fn project_watch(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    root: String,
) -> Result<WatchResponse, String> {
    let workspace = project_workspace(&root)?;
    let window_label = window.label().to_owned();
    {
        let watchers = state
            .project_watchers
            .lock()
            .map_err(|_| error("Yedit's project watchers are unavailable."))?;
        if let Some((watch_id, record)) = watchers.iter().find(|(_, record)| {
            record.window_label == window_label && record.root == workspace.root
        }) {
            return Ok(WatchResponse {
                watch_id: watch_id.clone(),
                root: path_text(&record.root),
                recursive: true,
                limited: Some(false),
                mode: Some("native".to_owned()),
            });
        }
        if watchers.len() >= MAX_PROJECT_WATCHERS {
            return Err(error(
                "Too many project folders are being watched. Stop an unused watcher first.",
            ));
        }
    }

    let watch_id = format!("project-watch-{}", Uuid::new_v4());
    let callback_root = workspace.root.clone();
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|cause| error(format!("Could not watch that project: {cause}")))?;
    watcher
        .watch(&workspace.root, RecursiveMode::Recursive)
        .map_err(|cause| error(format!("Could not watch that project: {cause}")))?;

    let app = state.app.clone();
    let worker_label = window_label.clone();
    let worker_id = watch_id.clone();
    thread::Builder::new()
        .name(format!(
            "yedit-watch-{}",
            &watch_id["project-watch-".len()..]
        ))
        .spawn(move || {
            consume_project_watch_events(app, worker_label, worker_id, callback_root, receiver)
        })
        .map_err(|cause| error(format!("Could not start that project watcher: {cause}")))?;
    state
        .project_watchers
        .lock()
        .map_err(|_| error("Yedit's project watchers are unavailable."))?
        .insert(
            watch_id.clone(),
            ProjectWatcher {
                window_label,
                root: workspace.root.clone(),
                watcher,
            },
        );
    Ok(WatchResponse {
        watch_id,
        root: path_text(&workspace.root),
        recursive: true,
        limited: Some(false),
        mode: Some("native".to_owned()),
    })
}

#[tauri::command]
pub fn project_unwatch(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    watch_id: String,
) -> Result<UnwatchResponse, String> {
    let mut watchers = state
        .project_watchers
        .lock()
        .map_err(|_| error("Yedit's project watchers are unavailable."))?;
    if let Some(record) = watchers.get(&watch_id) {
        if record.window_label != window.label() {
            return Err(error("That project watcher belongs to another window."));
        }
    }
    Ok(UnwatchResponse {
        stopped: watchers.remove(&watch_id).is_some(),
    })
}

#[tauri::command]
pub fn project_write_open_file(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    file_handle: String,
    content: String,
    encoding: Option<String>,
) -> Result<WriteOpenedFileResult, String> {
    let target = opened_standalone_file(state.inner(), window.label(), &file_handle)?;
    save_standalone_source_encoded(&target, &content, encoding.as_deref())?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    Ok(WriteOpenedFileResult { name })
}

#[tauri::command]
pub fn project_read_open_file(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    file_handle: String,
    encoding: Option<String>,
) -> Result<DecodedSourceFile, String> {
    let target = opened_standalone_file(state.inner(), window.label(), &file_handle)?;
    decode_source(&target, encoding.as_deref())
}

#[tauri::command]
pub async fn project_save_as(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    suggested_name: String,
    content: String,
    source_type: String,
    project_root: Option<String>,
    encoding: Option<String>,
) -> Result<SaveAsResult, String> {
    let Some(target) = save_source_file(&window, &suggested_name, &source_type).await? else {
        return Ok(SaveAsResult {
            name: None,
            relative_path: None,
            file_handle: None,
            canceled: Some(true),
        });
    };
    let target = absolute_path(&path_text(&target))?;
    save_standalone_source_encoded(&target, &content, encoding.as_deref())?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    if let Some(relative_path) = project_relative_source_path(project_root.as_deref(), &target) {
        return Ok(SaveAsResult {
            name: Some(name),
            relative_path: Some(relative_path),
            file_handle: None,
            canceled: None,
        });
    }
    let file_handle = grant_standalone_file(state.inner(), window.label(), &target)?;
    remember_recent_entry_best_effort(state.inner(), "file", &target, &name);
    Ok(SaveAsResult {
        name: Some(name),
        relative_path: None,
        file_handle: Some(file_handle),
        canceled: None,
    })
}

#[tauri::command]
pub fn recents_list(state: State<'_, CoreState>) -> Result<Vec<RecentEntry>, String> {
    let _guard = state
        .recent_entries_lock
        .lock()
        .map_err(|_| error("Yedit's recent-items store is unavailable."))?;
    Ok(public_recent_entries(&read_recent_entries(state.inner())))
}

/// Imports the folder-only list kept by Yedit's pre-native renderer builds.
/// Entries that no longer exist are harmlessly skipped.
#[tauri::command]
pub fn recents_migrate_legacy_projects(
    state: State<'_, CoreState>,
    projects: Vec<LegacyProjectInput>,
) -> Result<Vec<RecentEntry>, String> {
    let discovered = projects
        .into_iter()
        .take(MAX_RECENT_ENTRIES)
        .filter_map(|candidate| {
            let workspace = project_workspace(&candidate.root).ok()?;
            let name = if candidate.name.trim().is_empty() {
                workspace.root.file_name()?.to_string_lossy().into_owned()
            } else {
                candidate.name.trim().chars().take(180).collect()
            };
            Some((workspace.root, name))
        })
        .collect::<Vec<_>>();
    let entries = mutate_recent_entries(state.inner(), |current| {
        let mut known = current
            .iter()
            .map(|entry| format!("{}:{}", entry.kind, path_text(&entry.target)))
            .collect::<HashSet<_>>();
        let now = now_millis();
        let migrated = discovered
            .iter()
            .enumerate()
            .filter_map(|(index, (target, name))| {
                let key = format!("project:{}", path_text(target));
                if !known.insert(key) {
                    return None;
                }
                Some(StoredRecentEntry {
                    id: format!("recent-{}", Uuid::new_v4()),
                    kind: "project".to_owned(),
                    target: target.clone(),
                    name: name.clone(),
                    opened_at: now - MAX_RECENT_ENTRIES as i64 - index as i64,
                })
            });
        current.into_iter().chain(migrated).collect()
    })?;
    Ok(public_recent_entries(&entries))
}

#[tauri::command]
pub fn recents_open(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    id: String,
    project_root: Option<String>,
    encoding: Option<String>,
) -> Result<OpenRecentResult, String> {
    if id.trim().is_empty() {
        return Err(error("That recent item is invalid."));
    }
    let entry = {
        let _guard = state
            .recent_entries_lock
            .lock()
            .map_err(|_| error("Yedit's recent-items store is unavailable."))?;
        read_recent_entries(state.inner())
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| error("That recent item is no longer available."))?
    };
    if entry.kind == "project" {
        return Ok(OpenRecentResult::Project {
            project: remembered_project_payload(state.inner(), &path_text(&entry.target))?,
        });
    }
    let file = standalone_source_payload(
        state.inner(),
        window.label(),
        &entry.target,
        project_root.as_deref(),
        encoding.as_deref(),
    )?;
    let name = match &file {
        OpenedSourceFile::Project(file) => &file.name,
        OpenedSourceFile::Standalone(file) => &file.name,
    };
    remember_recent_entry_best_effort(state.inner(), "file", &entry.target, name);
    Ok(OpenRecentResult::File { file })
}

#[tauri::command]
pub fn recents_remove(state: State<'_, CoreState>, id: String) -> Result<Vec<RecentEntry>, String> {
    if id.trim().is_empty() {
        return Err(error("That recent item is invalid."));
    }
    let entries = mutate_recent_entries(state.inner(), |current| {
        current.into_iter().filter(|entry| entry.id != id).collect()
    })?;
    Ok(public_recent_entries(&entries))
}

#[tauri::command]
pub fn recents_clear(state: State<'_, CoreState>) -> Result<Vec<RecentEntry>, String> {
    let entries = mutate_recent_entries(state.inner(), |_| Vec::new())?;
    Ok(public_recent_entries(&entries))
}

fn load_settings_inner(state: &CoreState) -> AppSettings {
    let Some((value, migrated)) = read_json_with_migration(state, "settings.json") else {
        return AppSettings::default();
    };
    let settings = AppSettings::normalize(&value);
    if migrated {
        let _ = save_settings_inner(state, &settings);
    }
    settings
}

fn save_settings_inner(state: &CoreState, settings: &AppSettings) -> Result<(), String> {
    let path = current_data_path(state, "settings.json")?;
    write_atomic_json(&path, settings)
}

#[tauri::command]
pub fn settings_load(state: State<'_, CoreState>) -> Result<AppSettings, String> {
    Ok(load_settings_inner(state.inner()))
}

#[tauri::command]
pub fn settings_save(state: State<'_, CoreState>, settings: Value) -> Result<AppSettings, String> {
    let settings = AppSettings::normalize(&settings);
    save_settings_inner(state.inner(), &settings)?;
    Ok(settings)
}

/// Native menus are available before React has mounted. Deliver early actions
/// only after the workbench has
/// registered its `menu-action` listener.
#[tauri::command]
pub fn renderer_ready(window: WebviewWindow, state: State<'_, CoreState>) -> Value {
    for action in state.renderer_ready(window.label()) {
        let _ = state.app.emit_to(window.label(), "menu-action", action);
    }
    json!({ "ok": true })
}
