//! Native project, file, recents, and settings commands for Yedit.
//!
//! This module intentionally does not expose a general-purpose filesystem API
//! to the webview. Project writes are contained to an opened workspace and a
//! standalone file can only be saved through an opaque, per-window handle.

use crate::{
    models::{
        extension_for_source_type, source_type_for_path, AppSettings, Canceled, DecodedSourceFile,
        DuplicatedFileResult, ExternalOpenFilesResult, FileNode, LegacyProjectInput,
        OpenRecentResult, OpenedSourceFile, OpenedSourceOrCanceled, Project, ProjectChange,
        ProjectOrCanceled, ProjectSourceFile, ProjectWatchUpdate, RecentEntry, RelativePathResult,
        RenamedFileResult, SaveAsResult, StandaloneSourceFile, UnwatchResponse, WatchResponse,
        WriteOpenedFileResult, MAX_PROJECT_TREE_DEPTH, MAX_RECENT_ENTRIES,
    },
    state::{CoreState, PendingExternalFiles, ProjectWatcher},
    text_encoding,
};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        mpsc::{self, Receiver},
        Mutex, OnceLock,
    },
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
const TEXT_PROBE_BYTES: usize = 8 * 1024;
/// A stable error marker that lets the renderer turn a stale standalone-file
/// binding into a recoverable unsaved draft instead of retrying autosave.
const SAVE_TARGET_MISSING: &str =
    "SAVE_TARGET_MISSING: This saved file was moved or deleted. Use Save As to choose a new location.";

#[derive(Clone, Copy)]
enum SaveTargetPolicy {
    /// Save As has explicit user approval for its selected destination.
    MayCreate,
    /// Autosave and ordinary Save must never recreate a deleted source file.
    MustExist,
}

#[derive(Clone, Debug)]
struct Workspace {
    root: PathBuf,
    real_root: PathBuf,
}

#[derive(Clone, Debug)]
struct ProjectFile {
    target: PathBuf,
    relative_path: String,
    identity: FileIdentity,
}

#[derive(Clone, Debug)]
struct ProjectDestination {
    target: PathBuf,
    relative_path: String,
}

/// A stable identity for an already-bound source file. On macOS and other
/// Unix hosts, a pathname may be deleted and recreated while keeping the same
/// spelling; device + inode lets a normal Save distinguish that replacement
/// from the document the editor originally opened.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

/// Non-Unix hosts do not expose a comparable stable identifier through this
/// module's portable metadata API. MustExist writes fail closed there rather
/// than mistaking mutable size or mtime for an object identity.
#[cfg(not(unix))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum BoundSourceKey {
    Project {
        window_label: String,
        root: PathBuf,
        relative_path: String,
    },
    Standalone {
        window_label: String,
        file_handle: String,
    },
}

/// The renderer intentionally does not receive filesystem identities. Keep
/// them beside the native binding instead: opaque standalone handles and a
/// project tab's window/root/relative-path binding are enough to reject a
/// delete-and-recreate at the same pathname before a MustExist write.
static BOUND_SOURCE_IDENTITIES: OnceLock<Mutex<HashMap<BoundSourceKey, FileIdentity>>> =
    OnceLock::new();

#[derive(Clone, Debug)]
struct BoundStandaloneFile {
    target: PathBuf,
    identity: FileIdentity,
}

struct DecodedSourceWithIdentity {
    decoded: DecodedSourceFile,
    identity: FileIdentity,
}

#[derive(Clone, Copy)]
enum ProjectReadBindingMode {
    None,
    Adopt,
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

fn file_identity(metadata: &fs::Metadata) -> FileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        FileIdentity
    }
}

fn bound_source_identities() -> &'static Mutex<HashMap<BoundSourceKey, FileIdentity>> {
    BOUND_SOURCE_IDENTITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_bound_identity(key: BoundSourceKey, identity: FileIdentity) -> Result<(), String> {
    bound_source_identities()
        .lock()
        .map_err(|_| error("Yedit's source identity store is unavailable."))?
        .entry(key)
        .or_insert(identity);
    Ok(())
}

fn replace_bound_identity(key: BoundSourceKey, identity: FileIdentity) -> Result<(), String> {
    bound_source_identities()
        .lock()
        .map_err(|_| error("Yedit's source identity store is unavailable."))?
        .insert(key, identity);
    Ok(())
}

fn bound_identity(key: &BoundSourceKey) -> Result<Option<FileIdentity>, String> {
    Ok(bound_source_identities()
        .lock()
        .map_err(|_| error("Yedit's source identity store is unavailable."))?
        .get(key)
        .cloned())
}

fn forget_bound_identity(key: &BoundSourceKey) {
    if let Ok(mut identities) = bound_source_identities().lock() {
        identities.remove(key);
    }
}

fn project_source_key(
    window_label: &str,
    workspace: &Workspace,
    relative_path: &str,
) -> BoundSourceKey {
    BoundSourceKey::Project {
        window_label: window_label.to_owned(),
        // Preserve the selected root spelling as part of the native binding.
        // If that directory itself is replaced at the same pathname, its old
        // source key still finds the previous identity and rejects the write.
        root: workspace.root.clone(),
        relative_path: relative_path.to_owned(),
    }
}

fn standalone_source_key(window_label: &str, file_handle: &str) -> BoundSourceKey {
    BoundSourceKey::Standalone {
        window_label: window_label.to_owned(),
        file_handle: file_handle.to_owned(),
    }
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
    let metadata = fs::metadata(&root).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("The selected project folder is unavailable.")
        }
    })?;
    if !metadata.is_dir() {
        return Err(error("The selected project folder is unavailable."));
    }
    let real_root = fs::canonicalize(&root).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("The selected project folder is unavailable.")
        }
    })?;
    Ok(Workspace { root, real_root })
}

/// Resolves a workspace for a write without collapsing a removed project root
/// into a generic refresh error. A dirty tab in a moved/deleted project must
/// become a recovery draft just like a removed file inside that project.
fn project_workspace_for_write(root: &str) -> Result<Workspace, String> {
    if root.trim().is_empty() {
        return Err(error("Choose a project folder first."));
    }
    let root = absolute_path(root)?;
    let metadata = fs::metadata(&root).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("The selected project folder is unavailable.")
        }
    })?;
    if !metadata.is_dir() {
        return Err(error("The selected project folder is unavailable."));
    }
    let real_root = fs::canonicalize(&root).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("The selected project folder is unavailable.")
        }
    })?;
    Ok(Workspace { root, real_root })
}

fn project_file(workspace: &Workspace, relative_path: &str) -> Result<ProjectFile, String> {
    let target = assert_project_relative_path(workspace, relative_path, "file")?;
    let metadata = fs::symlink_metadata(&target).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("That project file is unavailable.")
        }
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(error("Only regular project files can be changed here."));
    }
    let real_target = fs::canonicalize(&target).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("That project file is unavailable.")
        }
    })?;
    if !is_inside(&workspace.real_root, &real_target) {
        return Err(error("That file resolves outside the current project."));
    }
    Ok(ProjectFile {
        relative_path: relative_path_for(&workspace.root, &target)?,
        target,
        identity: file_identity(&metadata),
    })
}

fn project_target_is_missing(workspace: &Workspace, relative_path: &str) -> bool {
    let Ok(target) = assert_project_relative_path(workspace, relative_path, "file") else {
        return false;
    };
    matches!(
        fs::symlink_metadata(target),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound
    )
}

fn project_write_error(workspace: &Workspace, relative_path: &str, cause: String) -> String {
    if project_target_is_missing(workspace, relative_path) {
        SAVE_TARGET_MISSING.to_owned()
    } else {
        cause
    }
}

/// Like [`project_file`], but returns a stable recovery marker when the file
/// has been moved or deleted after it was opened in the editor.
fn project_file_for_write(
    workspace: &Workspace,
    relative_path: &str,
) -> Result<ProjectFile, String> {
    project_file(workspace, relative_path)
        .map_err(|cause| project_write_error(workspace, relative_path, cause))
}

/// Explicitly adopts a decoded or opened project source. Ordinary reads must
/// not call this: search and other background reads must never replace the
/// identity that protects a dirty tab at the same path.
fn adopt_project_binding(
    window_label: &str,
    workspace: &Workspace,
    relative_path: &str,
    identity: FileIdentity,
) -> Result<(), String> {
    replace_bound_identity(
        project_source_key(window_label, workspace, relative_path),
        identity,
    )
}

/// A picker/Finder/recent payload may describe a path that an existing tab is
/// already editing. Its renderer-side dedupe happens after this native call,
/// so preserve the existing identity here rather than silently rebind that
/// tab to a same-path replacement. A fresh path is inserted normally.
fn remember_project_binding(
    window_label: &str,
    workspace: &Workspace,
    relative_path: &str,
    identity: FileIdentity,
) -> Result<(), String> {
    remember_bound_identity(
        project_source_key(window_label, workspace, relative_path),
        identity,
    )
}

/// Converts a verified standalone handle into a project binding when its
/// containing folder is revealed. The renderer may later dedupe its converted
/// tab against an existing dirty project tab, so this must retain that tab's
/// identity instead of replacing it with a same-path file replacement.
fn remember_revealed_standalone_project_binding(
    window_label: &str,
    workspace: &Workspace,
    source: &ProjectFile,
    standalone_identity: FileIdentity,
) -> Result<(), String> {
    if source.identity != standalone_identity {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }
    remember_project_binding(
        window_label,
        workspace,
        &source.relative_path,
        standalone_identity,
    )
}

fn bound_project_identity(
    window_label: &str,
    workspace: &Workspace,
    source: &ProjectFile,
) -> Result<FileIdentity, String> {
    let key = project_source_key(window_label, workspace, &source.relative_path);
    let expected = bound_identity(&key)?.ok_or_else(|| SAVE_TARGET_MISSING.to_owned())?;
    if expected != source.identity {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }
    Ok(expected)
}

fn forget_project_binding(window_label: &str, workspace: &Workspace, relative_path: &str) {
    forget_bound_identity(&project_source_key(window_label, workspace, relative_path));
}

fn move_project_binding(
    window_label: &str,
    workspace: &Workspace,
    from_relative_path: &str,
    to_relative_path: &str,
    identity: FileIdentity,
) -> Result<(), String> {
    let from = project_source_key(window_label, workspace, from_relative_path);
    let to = project_source_key(window_label, workspace, to_relative_path);
    let mut identities = bound_source_identities()
        .lock()
        .map_err(|_| error("Yedit's source identity store is unavailable."))?;
    let remembered = identities.remove(&from).unwrap_or(identity);
    identities.insert(to, remembered);
    Ok(())
}

fn standalone_file_identity(target: &Path) -> Result<FileIdentity, String> {
    let metadata = fs::symlink_metadata(target).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error("That source file is unavailable.")
        }
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            "Only regular source files can be opened or saved directly.",
        ));
    }
    Ok(file_identity(&metadata))
}

fn regular_standalone_file(target: &Path) -> Result<(), String> {
    standalone_file_identity(target).map(|_| ())
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
    file.sync_all()
        .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
    Ok(())
}

fn write_no_follow(target: &Path, content: &str, create_new: bool) -> Result<(), String> {
    write_no_follow_bytes(target, content.as_bytes(), create_new)
}

#[cfg(unix)]
fn target_has_identity(target: &Path, expected: &FileIdentity) -> bool {
    fs::symlink_metadata(target)
        .ok()
        .filter(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
        .map(|metadata| file_identity(&metadata) == expected.clone())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn target_has_identity(_target: &Path, _expected: &FileIdentity) -> bool {
    false
}

/// Writes an already-bound source without ever truncating a replacement that
/// appeared at the same pathname. The descriptor is opened without O_TRUNC,
/// identified, and only then shortened and written. If the path changes while
/// that happens, writing the old unlinked descriptor is harmless and the
/// caller still receives the recoverable marker.
fn write_bound_no_follow_bytes(
    target: &Path,
    content: &[u8],
    expected: &FileIdentity,
) -> Result<(), String> {
    write_bound_versioned_bytes(target, content, expected, None).map(|_| ())
}

fn write_bound_versioned_bytes(
    target: &Path,
    content: &[u8],
    expected: &FileIdentity,
    expected_version: Option<&str>,
) -> Result<String, String> {
    if !target_has_identity(target, expected) {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(target).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error(format!("Could not write that source file: {cause}"))
        }
    })?;
    let opened_identity = file
        .metadata()
        .map(|metadata| file_identity(&metadata))
        .map_err(|cause| error(format!("Could not inspect that source file: {cause}")))?;
    if opened_identity != expected.clone() || !target_has_identity(target, expected) {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }

    if let Some(version) = expected_version { crate::file_version::check(&mut file, version)?; }
    let written_version = crate::file_version::version(content, &file.metadata().map_err(|e| e.to_string())?);

    let result = (|| {
        file.set_len(0)
            .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
        file.write_all(content)
            .map_err(|cause| error(format!("Could not write that source file: {cause}")))?;
        file.sync_all()
            .map_err(|cause| error(format!("Could not write that source file: {cause}")))
    })();
    if let Err(cause) = result {
        return if target_has_identity(target, expected) {
            Err(cause)
        } else {
            Err(SAVE_TARGET_MISSING.to_owned())
        };
    }
    if !target_has_identity(target, expected) {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }
    Ok(written_version)
}

fn looks_like_text(bytes: &[u8]) -> bool {
    // UTF-16 uses zero bytes as part of ordinary text, so keep BOM-marked
    // documents available while treating ordinary NUL-containing streams as
    // binary. This deliberately avoids relying on filename extensions.
    bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || !bytes.contains(&0)
}

fn is_probably_text_file(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut sample = [0_u8; TEXT_PROBE_BYTES];
    let Ok(read) = file.read(&mut sample) else {
        return false;
    };
    looks_like_text(&sample[..read])
}

/// Reads a source through one descriptor and returns the identity of the exact
/// bytes that were decoded. Callers that adopt a binding must use this value,
/// never a later pathname stat that could observe a replacement file.
fn decode_source_with_identity(
    target: &Path,
    encoding: Option<&str>,
) -> Result<DecodedSourceWithIdentity, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(target).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::NotFound {
            SAVE_TARGET_MISSING.to_owned()
        } else {
            error(format!("Could not read that source file: {cause}"))
        }
    })?;
    let metadata = file
        .metadata()
        .map_err(|cause| error(format!("Could not inspect that source file: {cause}")))?;
    if !metadata.file_type().is_file() {
        return Err(error(
            "Only regular source files can be opened or saved directly.",
        ));
    }
    let identity = file_identity(&metadata);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|cause| error(format!("Could not read that source file: {cause}")))?;
    if !looks_like_text(&bytes) {
        return Err(error(
            "That file appears to be binary data. Yedit can open text in any filename extension.",
        ));
    }
    let decoded = text_encoding::decode(&bytes, encoding)?;
    Ok(DecodedSourceWithIdentity {
        decoded: DecodedSourceFile {
            disk_version: crate::file_version::version(&bytes, &metadata),
            content: decoded.content,
            encoding: decoded.encoding,
        },
        identity,
    })
}

#[cfg(test)]
fn decode_source(target: &Path, encoding: Option<&str>) -> Result<DecodedSourceFile, String> {
    Ok(decode_source_with_identity(target, encoding)?.decoded)
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

fn write_bound_source_no_follow(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
    expected: &FileIdentity,
) -> Result<String, String> {
    let (bytes, encoding) = text_encoding::encode(content, encoding)?;
    write_bound_no_follow_bytes(target, &bytes, expected)?;
    Ok(encoding)
}

fn save_standalone_source_encoded(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
    policy: SaveTargetPolicy,
) -> Result<String, String> {
    let expected_identity = if matches!(policy, SaveTargetPolicy::MustExist) {
        Some(standalone_file_identity(target)?)
    } else {
        None
    };
    save_standalone_source_encoded_with_identity(
        target,
        content,
        encoding,
        policy,
        expected_identity,
    )
}

fn save_bound_standalone_source_encoded(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
    identity: FileIdentity,
) -> Result<String, String> {
    save_standalone_source_encoded_with_identity(
        target,
        content,
        encoding,
        SaveTargetPolicy::MustExist,
        Some(identity),
    )
}

fn save_standalone_source_encoded_with_identity(
    target: &Path,
    content: &str,
    encoding: Option<&str>,
    policy: SaveTargetPolicy,
    expected_identity: Option<FileIdentity>,
) -> Result<String, String> {
    let (create_new, current_identity) = match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(error(
                    "Only regular source files can be opened or saved directly.",
                ));
            }
            (false, Some(file_identity(&metadata)))
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            if matches!(policy, SaveTargetPolicy::MustExist) {
                return Err(SAVE_TARGET_MISSING.to_owned());
            }
            (true, None)
        }
        Err(cause) => Err(error(format!(
            "Could not inspect that source file: {cause}"
        )))?,
    };

    if matches!(policy, SaveTargetPolicy::MustExist) {
        let expected = expected_identity
            .or(current_identity.clone())
            .ok_or_else(|| SAVE_TARGET_MISSING.to_owned())?;
        if current_identity.as_ref() != Some(&expected) {
            return Err(SAVE_TARGET_MISSING.to_owned());
        }
        return write_bound_source_no_follow(target, content, encoding, &expected);
    }

    let encoding = write_source_no_follow(target, content, encoding, create_new)?;
    regular_standalone_file(target)?;
    Ok(encoding)
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
        let is_regular_file = metadata.file_type().is_file() && !is_link;
        nodes.push(FileNode {
            name: name.clone(),
            relative_path: relative_path_for(root, &child_absolute)?,
            kind: if is_directory { "directory" } else { "file" }.to_owned(),
            source_type: is_regular_file.then(|| source_type_for_path(Path::new(&name))),
            // A text data file is openable regardless of whether it is named
            // `.dat`, `.conf`, or with an application-specific suffix.
            supported: (!is_directory)
                .then(|| is_regular_file && is_probably_text_file(&child_absolute)),
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
    identity: FileIdentity,
) -> Result<String, String> {
    let known_handles = {
        let files = state
            .standalone_files
            .lock()
            .map_err(|_| error("Yedit's opened-file permissions are unavailable."))?;
        files
            .get(window_label)
            .map(|known| {
                known
                    .iter()
                    .filter(|(_, known_target)| *known_target == target)
                    .map(|(handle, _)| handle.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    for handle in known_handles {
        if bound_identity(&standalone_source_key(window_label, &handle))?.as_ref()
            == Some(&identity)
        {
            return Ok(handle);
        }
    }

    let handle = format!("source-{}", Uuid::new_v4());
    let mut files = state
        .standalone_files
        .lock()
        .map_err(|_| error("Yedit's opened-file permissions are unavailable."))?;
    let known = standalone_files_for(&mut files, window_label);
    known.insert(handle.clone(), target.to_path_buf());
    drop(files);
    remember_bound_identity(standalone_source_key(window_label, &handle), identity)?;
    Ok(handle)
}

/// Resolves an opaque standalone-file handle without assuming the target still
/// exists. Write commands use this so they can distinguish a stale target from
/// a revoked handle and offer Save As recovery.
fn permitted_standalone_file(
    state: &CoreState,
    window_label: &str,
    file_handle: &str,
) -> Result<BoundStandaloneFile, String> {
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
    drop(files);
    let identity = bound_identity(&standalone_source_key(window_label, file_handle))?
        .ok_or_else(|| SAVE_TARGET_MISSING.to_owned())?;
    Ok(BoundStandaloneFile { target, identity })
}

fn project_source_for_target(
    project_root: Option<&str>,
    target: &Path,
) -> Option<(Workspace, ProjectFile)> {
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
        .map(|source| (workspace, source))
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
    let project_source = project_source_for_target(project_root, &target);
    let decoded = decode_source_with_identity(&target, encoding)?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    if let Some((workspace, source)) = project_source {
        // The open payload contains these exact descriptor bytes. Bind that
        // descriptor's identity, rather than re-statting `target` after a
        // possible delete-and-recreate race.
        remember_project_binding(
            window_label,
            &workspace,
            &source.relative_path,
            decoded.identity.clone(),
        )?;
        return Ok(OpenedSourceFile::Project(ProjectSourceFile {
            disk_version: decoded.decoded.disk_version,
            name,
            source_type: source_type_for_path(&target),
            content: decoded.decoded.content,
            encoding: decoded.decoded.encoding,
            relative_path: source.relative_path,
        }));
    }
    Ok(OpenedSourceFile::Standalone(StandaloneSourceFile {
        disk_version: decoded.decoded.disk_version,
        name,
        source_type: source_type_for_path(&target),
        content: decoded.decoded.content,
        encoding: decoded.decoded.encoding,
        file_handle: grant_standalone_file(state, window_label, &target, decoded.identity)?,
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

/// Opens the parent folder of an independently opened file in Yedit's Files
/// area. The caller supplies only its opaque standalone-file handle; the
/// native side resolves the permitted path and never accepts an arbitrary
/// filesystem location from the webview.
#[tauri::command]
pub fn project_reveal_open_file_folder(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    file_handle: String,
) -> Result<Project, String> {
    let source = permitted_standalone_file(state.inner(), window.label(), &file_handle)?;
    regular_standalone_file(&source.target)?;
    let parent = source
        .target
        .parent()
        .ok_or_else(|| error("The containing folder is unavailable."))?;
    let workspace = project_workspace(&path_text(parent))?;
    let relative_path = relative_path_for(&workspace.root, &source.target)?;
    let project_source = project_file(&workspace, &relative_path)?;
    remember_revealed_standalone_project_binding(
        window.label(),
        &workspace,
        &project_source,
        source.identity,
    )?;
    remembered_project_payload(state.inner(), &path_text(parent))
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

fn project_read_file_with_binding_mode(
    window_label: &str,
    root: String,
    relative_path: String,
    encoding: Option<String>,
    binding_mode: ProjectReadBindingMode,
) -> Result<DecodedSourceFile, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &relative_path)?;
    let decoded = decode_source_with_identity(&source.target, encoding.as_deref())?;
    if matches!(binding_mode, ProjectReadBindingMode::Adopt) {
        return adopt_decoded_project_source(window_label, &workspace, &source, decoded);
    }
    Ok(decoded.decoded)
}

fn adopt_decoded_project_source(
    window_label: &str,
    workspace: &Workspace,
    source: &ProjectFile,
    decoded: DecodedSourceWithIdentity,
) -> Result<DecodedSourceFile, String> {
    adopt_project_binding(
        window_label,
        workspace,
        &source.relative_path,
        decoded.identity,
    )?;
    Ok(decoded.decoded)
}

#[cfg(test)]
fn project_read_file_for_binding(
    window_label: &str,
    root: String,
    relative_path: String,
    encoding: Option<String>,
) -> Result<DecodedSourceFile, String> {
    project_read_file_with_binding_mode(
        window_label,
        root,
        relative_path,
        encoding,
        ProjectReadBindingMode::Adopt,
    )
}

#[cfg(test)]
fn project_read_file_without_binding(
    window_label: &str,
    root: String,
    relative_path: String,
    encoding: Option<String>,
) -> Result<DecodedSourceFile, String> {
    project_read_file_with_binding_mode(
        window_label,
        root,
        relative_path,
        encoding,
        ProjectReadBindingMode::None,
    )
}

#[tauri::command]
pub fn project_read_file(
    window: WebviewWindow,
    root: String,
    relative_path: String,
    encoding: Option<String>,
    binding_mode: Option<String>,
) -> Result<DecodedSourceFile, String> {
    let binding_mode = if binding_mode.as_deref() == Some("adopt") {
        ProjectReadBindingMode::Adopt
    } else {
        ProjectReadBindingMode::None
    };
    project_read_file_with_binding_mode(window.label(), root, relative_path, encoding, binding_mode)
}

fn project_write_file_for_binding(
    window_label: &str,
    root: String,
    relative_path: String,
    content: String,
    encoding: Option<String>,
) -> Result<RelativePathResult, String> {
    project_write_file_versioned(window_label, root, relative_path, content, encoding, None)
}

fn project_write_file_versioned(
    window_label: &str, root: String, relative_path: String, content: String,
    encoding: Option<String>, expected_version: Option<&str>,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace_for_write(&root)?;
    let source = project_file_for_write(&workspace, &relative_path)?;
    let expected = bound_project_identity(window_label, &workspace, &source)?;
    let (bytes, _) = text_encoding::encode(&content, encoding.as_deref())?;
    let disk_version = write_bound_versioned_bytes(&source.target, &bytes, &expected, expected_version)
        .map_err(|cause| project_write_error(&workspace, &source.relative_path, cause))?;
    // Recheck after the write so a changed symlink cannot leave a source with
    // a silently broken project binding.
    let source = project_file_for_write(&workspace, &source.relative_path)?;
    if source.identity != expected {
        return Err(SAVE_TARGET_MISSING.to_owned());
    }
    adopt_project_binding(window_label, &workspace, &source.relative_path, expected)?;
    Ok(RelativePathResult {
        relative_path: source.relative_path,
        disk_version: Some(disk_version),
    })
}

#[tauri::command]
pub fn project_write_file(
    window: WebviewWindow,
    root: String,
    relative_path: String,
    content: String,
    encoding: Option<String>,
    expected_version: Option<String>,
) -> Result<RelativePathResult, String> {
    let version = expected_version.ok_or_else(|| crate::file_version::SAVE_CONFLICT.to_owned())?;
    project_write_file_versioned(window.label(), root, relative_path, content, encoding, Some(&version))
}

#[tauri::command]
pub fn project_create_file(
    window: WebviewWindow,
    root: String,
    relative_path: String,
    content: String,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace(&root)?;
    let destination = project_create_destination(&workspace, &relative_path)?;
    write_no_follow(&destination.target, &content, true)?;
    let source = project_file(&workspace, &destination.relative_path)?;
    adopt_project_binding(
        window.label(),
        &workspace,
        &source.relative_path,
        source.identity,
    )?;
    Ok(RelativePathResult {
        relative_path: source.relative_path,
        disk_version: Some(crate::file_version::version(content.as_bytes(), &fs::metadata(&source.target).map_err(|e| e.to_string())?)),
    })
}

#[tauri::command]
pub fn project_rename_file(
    window: WebviewWindow,
    root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<RenamedFileResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &from_relative_path)?;
    let expected = bound_project_identity(window.label(), &workspace, &source)?;
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
    move_project_binding(
        window.label(),
        &workspace,
        &source.relative_path,
        &destination.relative_path,
        expected,
    )?;
    Ok(RenamedFileResult {
        relative_path: destination.relative_path,
        previous_relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_duplicate_file(
    window: WebviewWindow,
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
    let copied_source = project_file(&workspace, &destination.relative_path)?;
    adopt_project_binding(
        window.label(),
        &workspace,
        &copied_source.relative_path,
        copied_source.identity,
    )?;
    Ok(DuplicatedFileResult {
        relative_path: destination.relative_path,
        source_relative_path: source.relative_path,
    })
}

#[tauri::command]
pub fn project_delete_file(
    window: WebviewWindow,
    root: String,
    relative_path: String,
) -> Result<RelativePathResult, String> {
    let workspace = project_workspace(&root)?;
    let source = project_file(&workspace, &relative_path)?;
    let _ = bound_project_identity(window.label(), &workspace, &source)?;
    fs::remove_file(&source.target)
        .map_err(|cause| error(format!("Could not delete that project file: {cause}")))?;
    forget_project_binding(window.label(), &workspace, &source.relative_path);
    Ok(RelativePathResult {
        relative_path: source.relative_path,
        disk_version: None,
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
    expected_version: Option<String>,
) -> Result<WriteOpenedFileResult, String> {
    let source = permitted_standalone_file(state.inner(), window.label(), &file_handle)?;
    let expected_version = expected_version.ok_or_else(|| crate::file_version::SAVE_CONFLICT.to_owned())?;
    let (bytes, _) = text_encoding::encode(&content, encoding.as_deref())?;
    let disk_version = write_bound_versioned_bytes(&source.target, &bytes, &source.identity, Some(&expected_version))?;
    let name = source
        .target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    Ok(WriteOpenedFileResult { name, disk_version })
}

#[tauri::command]
pub fn project_read_open_file(
    window: WebviewWindow,
    state: State<'_, CoreState>,
    file_handle: String,
    encoding: Option<String>,
) -> Result<DecodedSourceFile, String> {
    let source = permitted_standalone_file(state.inner(), window.label(), &file_handle)?;
    let decoded = decode_source_with_identity(&source.target, encoding.as_deref())?;
    // The renderer may reject this asynchronous result after the user edits.
    // Do not rebind before that guard runs: retaining the old identity turns a
    // same-path replacement into recovery instead of an accidental overwrite.
    Ok(decoded.decoded)
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
            disk_version: None,
            name: None,
            relative_path: None,
            file_handle: None,
            canceled: Some(true),
        });
    };
    let target = absolute_path(&path_text(&target))?;
    save_standalone_source_encoded(
        &target,
        &content,
        encoding.as_deref(),
        SaveTargetPolicy::MayCreate,
    )?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| error("That source file is unavailable."))?;
    if let Some((workspace, source)) = project_source_for_target(project_root.as_deref(), &target) {
        // Save As is explicit user authorization to bind this selected source.
        adopt_project_binding(
            window.label(),
            &workspace,
            &source.relative_path,
            source.identity,
        )?;
        return Ok(SaveAsResult {
            disk_version: Some(crate::file_version::version(&text_encoding::encode(&content, encoding.as_deref())?.0, &fs::metadata(&target).map_err(|e| e.to_string())?)),
            name: Some(name),
            relative_path: Some(source.relative_path),
            file_handle: None,
            canceled: None,
        });
    }
    let file_handle = grant_standalone_file(
        state.inner(),
        window.label(),
        &target,
        standalone_file_identity(&target)?,
    )?;
    remember_recent_entry_best_effort(state.inner(), "file", &target, &name);
    Ok(SaveAsResult {
        disk_version: Some(crate::file_version::version(&text_encoding::encode(&content, encoding.as_deref())?.0, &fs::metadata(&target).map_err(|e| e.to_string())?)),
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

#[cfg(test)]
mod tests {
    use super::{
        adopt_decoded_project_source, adopt_project_binding, bound_identity, build_tree,
        decode_source, decode_source_with_identity, forget_bound_identity, project_file,
        project_read_file_for_binding, project_read_file_without_binding, project_source_key,
        project_workspace, project_write_file_for_binding, remember_bound_identity,
        remember_project_binding, remember_revealed_standalone_project_binding,
        save_bound_standalone_source_encoded, save_standalone_source_encoded,
        standalone_file_identity, standalone_source_key, SaveTargetPolicy, SAVE_TARGET_MISSING,
    };
    use std::{fs, path::Path};
    use uuid::Uuid;

    #[test]
    fn conflict_standalone_checks_bytes_before_truncating_and_allows_reviewed_retry() {
        let root = std::env::temp_dir().join(format!("yedit-conflict-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("draft.txt");
        fs::write(&target, "original").unwrap();
        let opened = decode_source_with_identity(&target, None).unwrap();
        let modified = fs::metadata(&target).unwrap().modified().unwrap();
        // Same inode, same size, and same modification time: byte version wins.
        fs::write(&target, "external").unwrap();
        fs::File::options().write(true).open(&target).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        let save = |version: &str| super::write_bound_versioned_bytes(&target, b"my edits", &opened.identity, Some(version));
        assert_eq!(save(&opened.decoded.disk_version).unwrap_err(), crate::file_version::SAVE_CONFLICT);
        assert_eq!(fs::read(&target).unwrap(), b"external");
        let reviewed = decode_source(&target, None).unwrap();
        let saved = save(&reviewed.disk_version).unwrap();
        assert_eq!(saved, decode_source(&target, None).unwrap().disk_version);
        assert_eq!(fs::read(&target).unwrap(), b"my edits");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflict_project_read_for_comparison_does_not_authorize_a_write() {
        let root = std::env::temp_dir().join(format!("yedit-project-conflict-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("draft.txt");
        let window = format!("conflict-{}", Uuid::new_v4());
        let root_string = root.to_string_lossy().into_owned();
        fs::write(&target, "original").unwrap();
        let opened = project_read_file_for_binding(&window, root_string.clone(), "draft.txt".into(), None).unwrap();
        fs::write(&target, "outside").unwrap();
        let reviewed = project_read_file_without_binding(&window, root_string.clone(), "draft.txt".into(), None).unwrap();
        let save = |version: &str| super::project_write_file_versioned(&window, root_string.clone(), "draft.txt".into(), "my edits".into(), None, Some(version));
        assert_eq!(save(&opened.disk_version).unwrap_err(), crate::file_version::SAVE_CONFLICT);
        fs::write(&target, "changed again").unwrap();
        assert_eq!(save(&reviewed.disk_version).unwrap_err(), crate::file_version::SAVE_CONFLICT);
        assert_eq!(fs::read(&target).unwrap(), b"changed again");
        let current = decode_source(&target, None).unwrap();
        assert!(save(&current.disk_version).is_ok());
        fs::remove_file(&target).unwrap();
        assert_eq!(save(&current.disk_version).unwrap_err(), SAVE_TARGET_MISSING);
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_tree_allows_text_with_an_arbitrary_extension() {
        let root = std::env::temp_dir().join(format!("yedit-text-tree-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(root.join("KOSE.DAT"), b"1 2 3\n4 5 6\n").expect("write text fixture");
        fs::write(root.join("HHO.EXE"), b"MZ\0\x01\x02").expect("write binary fixture");

        let tree = build_tree(&root, Path::new(""), 0).expect("build project tree");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            tree.iter()
                .find(|node| node.name == "KOSE.DAT")
                .and_then(|node| node.supported),
            Some(true)
        );
        assert_eq!(
            tree.iter()
                .find(|node| node.name == "HHO.EXE")
                .and_then(|node| node.supported),
            Some(false)
        );
    }

    #[test]
    fn stale_standalone_save_target_is_not_recreated() {
        let root = std::env::temp_dir().join(format!("yedit-stale-save-{}", Uuid::new_v4()));
        let missing = root.join("untitled.txt");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&missing, "Original draft").expect("create source file");
        fs::remove_file(&missing).expect("remove source file");

        let result = save_standalone_source_encoded(
            &missing,
            "Recovered draft",
            None,
            SaveTargetPolicy::MustExist,
        );

        assert_eq!(
            result.expect_err("a stale save target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        assert!(!missing.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_standalone_read_target_reports_a_recoverable_missing_file_error() {
        let root = std::env::temp_dir().join(format!("yedit-stale-read-{}", Uuid::new_v4()));
        let missing = root.join("untitled.txt");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&missing, "Original draft").expect("create source file");
        fs::remove_file(&missing).expect("remove source file");

        let result = decode_source(&missing, None);

        assert_eq!(
            result.expect_err("a stale read target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_project_save_target_is_not_recreated() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-project-save-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture folder");
        let missing = root.join("removed.txt");
        fs::write(&missing, "Original").expect("create source file");
        fs::remove_file(&missing).expect("remove source file");

        let result = project_write_file_for_binding(
            "stale-project-save",
            root.to_string_lossy().into_owned(),
            "removed.txt".to_owned(),
            "Recovered draft".to_owned(),
            None,
        );

        assert_eq!(
            result.expect_err("a stale project target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        assert!(!missing.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_project_read_target_reports_a_recoverable_missing_file_error() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-project-read-{}", Uuid::new_v4()));
        let missing = root.join("removed.txt");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&missing, "Original").expect("create source file");
        fs::remove_file(&missing).expect("remove source file");

        let result = project_read_file_for_binding(
            "stale-project-read",
            root.to_string_lossy().into_owned(),
            "removed.txt".to_owned(),
            None,
        );

        assert_eq!(
            result.expect_err("a stale project read target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_project_root_reports_a_recoverable_missing_file_error() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-project-root-{}", Uuid::new_v4()));
        let source = root.join("removed.txt");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&source, "Original").expect("create source file");
        fs::remove_dir_all(&root).expect("remove project root");

        let result = project_write_file_for_binding(
            "stale-project-root",
            root.to_string_lossy().into_owned(),
            "removed.txt".to_owned(),
            "Recovered draft".to_owned(),
            None,
        );

        assert_eq!(
            result.expect_err("a missing project root must be recoverable"),
            SAVE_TARGET_MISSING
        );
        assert!(!root.exists());
    }

    #[test]
    fn stale_standalone_replacement_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!("yedit-stale-replacement-{}", Uuid::new_v4()));
        let target = root.join("bound.txt");
        let window_label = format!("replacement-window-{}", Uuid::new_v4());
        let file_handle = format!("source-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Original draft").expect("create source file");
        let key = standalone_source_key(&window_label, &file_handle);
        remember_bound_identity(
            key.clone(),
            standalone_file_identity(&target).expect("identify bound source"),
        )
        .expect("retain standalone identity");

        fs::remove_file(&target).expect("remove original source");
        fs::write(&target, "Replacement source").expect("recreate source path");
        let expected = bound_identity(&key)
            .expect("read retained identity")
            .expect("source identity remains bound");
        let result =
            save_bound_standalone_source_encoded(&target, "Recovered draft", None, expected);

        assert_eq!(
            result.expect_err("a replaced standalone target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement source"),
            "Replacement source"
        );
        forget_bound_identity(&key);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_project_replacement_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!(
            "yedit-stale-project-replacement-{}",
            Uuid::new_v4()
        ));
        let target = root.join("bound.txt");
        let window_label = format!("replacement-window-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Original project source").expect("create source file");
        project_read_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            None,
        )
        .expect("read and bind project source");

        fs::remove_file(&target).expect("remove original project source");
        fs::write(&target, "Replacement project source").expect("recreate source path");
        let result = project_write_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            "Recovered project draft".to_owned(),
            None,
        );

        assert_eq!(
            result.expect_err("a replaced project target must be recoverable"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement project source"),
            "Replacement project source"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_non_adopting_project_read_preserves_the_dirty_binding() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-non-adopting-read-{}", Uuid::new_v4()));
        let target = root.join("bound.txt");
        let window_label = format!("search-window-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Original dirty source").expect("create source file");
        project_read_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            None,
        )
        .expect("open and bind project source");

        fs::remove_file(&target).expect("remove original project source");
        fs::write(&target, "Replacement found by search").expect("recreate source path");
        let search_read = project_read_file_without_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            None,
        )
        .expect("search may read the replacement without adopting it");
        assert_eq!(search_read.content, "Replacement found by search");

        let result = project_write_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            "Dirty editor content".to_owned(),
            None,
        );
        assert_eq!(
            result.expect_err("a search read must not erase the old binding"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement source"),
            "Replacement found by search"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_picker_project_binding_preserves_an_existing_dirty_binding() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-picker-binding-{}", Uuid::new_v4()));
        let target = root.join("bound.txt");
        let window_label = format!("picker-window-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Original dirty source").expect("create source file");
        let workspace = project_workspace(&root.to_string_lossy()).expect("open project workspace");
        let original = project_file(&workspace, "bound.txt").expect("resolve original source");
        let key = project_source_key(&window_label, &workspace, &original.relative_path);
        adopt_project_binding(
            &window_label,
            &workspace,
            &original.relative_path,
            original.identity.clone(),
        )
        .expect("bind original dirty source");

        fs::remove_file(&target).expect("remove original project source");
        fs::write(&target, "Replacement opened by Finder").expect("recreate source path");
        let replacement = project_file(&workspace, "bound.txt").expect("resolve replacement");
        // Finder/recent payload delivery can race with renderer-side tab
        // dedupe. It must insert a fresh tab binding but never replace this
        // existing dirty tab's original identity.
        remember_project_binding(
            &window_label,
            &workspace,
            &replacement.relative_path,
            replacement.identity,
        )
        .expect("remember picker payload without rebinding");
        assert_eq!(
            bound_identity(&key)
                .expect("read retained identity")
                .expect("original identity remains bound"),
            original.identity
        );

        let result = project_write_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            "Dirty editor content".to_owned(),
            None,
        );
        assert_eq!(
            result.expect_err("a picker payload must not erase the old binding"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement source"),
            "Replacement opened by Finder"
        );
        forget_bound_identity(&key);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_reveal_conversion_preserves_an_existing_dirty_project_binding() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-reveal-binding-{}", Uuid::new_v4()));
        let target = root.join("bound.txt");
        let window_label = format!("reveal-window-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Original dirty project source").expect("create source file");
        let workspace = project_workspace(&root.to_string_lossy()).expect("open project workspace");
        let original = project_file(&workspace, "bound.txt").expect("resolve original source");
        let key = project_source_key(&window_label, &workspace, &original.relative_path);
        adopt_project_binding(
            &window_label,
            &workspace,
            &original.relative_path,
            original.identity.clone(),
        )
        .expect("bind original dirty project source");

        fs::remove_file(&target).expect("remove original project source");
        fs::write(&target, "Replacement revealed from standalone tab")
            .expect("recreate source path");
        let replacement = project_file(&workspace, "bound.txt").expect("resolve replacement");
        // This models a standalone handle for the replacement being converted
        // into a project tab after Reveal folder. It must not replace A's
        // binding before React has a chance to dedupe the two tabs.
        remember_revealed_standalone_project_binding(
            &window_label,
            &workspace,
            &replacement,
            replacement.identity.clone(),
        )
        .expect("remember standalone reveal conversion without rebinding");
        assert_eq!(
            bound_identity(&key)
                .expect("read retained identity")
                .expect("original identity remains bound"),
            original.identity
        );

        let result = project_write_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            "Dirty editor content".to_owned(),
            None,
        );
        assert_eq!(
            result.expect_err("reveal conversion must not erase the old binding"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement source"),
            "Replacement revealed from standalone tab"
        );
        forget_bound_identity(&key);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_adopt_binds_the_descriptor_that_was_decoded() {
        let root =
            std::env::temp_dir().join(format!("yedit-stale-decoded-identity-{}", Uuid::new_v4()));
        let target = root.join("bound.txt");
        let window_label = format!("decoded-window-{}", Uuid::new_v4());
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Decoded original source").expect("create source file");
        let workspace = project_workspace(&root.to_string_lossy()).expect("open project workspace");
        let source = project_file(&workspace, "bound.txt").expect("resolve project source");
        let decoded =
            decode_source_with_identity(&source.target, None).expect("decode original source");

        fs::remove_file(&target).expect("remove decoded source");
        fs::write(&target, "Replacement after decode").expect("recreate source path");
        let adopted = adopt_decoded_project_source(&window_label, &workspace, &source, decoded)
            .expect("adopt decoded descriptor identity");
        assert_eq!(adopted.content, "Decoded original source");

        let result = project_write_file_for_binding(
            &window_label,
            root.to_string_lossy().into_owned(),
            "bound.txt".to_owned(),
            "Would overwrite replacement".to_owned(),
            None,
        );
        assert_eq!(
            result.expect_err("the decoded inode must remain the adopted binding"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read replacement source"),
            "Replacement after decode"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_unbound_project_write_fails_closed() {
        let root = std::env::temp_dir().join(format!(
            "yedit-stale-unbound-project-write-{}",
            Uuid::new_v4()
        ));
        let target = root.join("unbound.txt");
        fs::create_dir_all(&root).expect("create fixture folder");
        fs::write(&target, "Unbound source").expect("create source file");

        let result = project_write_file_for_binding(
            "unbound-project-window",
            root.to_string_lossy().into_owned(),
            "unbound.txt".to_owned(),
            "Must not write without an adopted source".to_owned(),
            None,
        );

        assert_eq!(
            result.expect_err("a MustExist project write needs a retained binding"),
            SAVE_TARGET_MISSING
        );
        assert_eq!(
            fs::read_to_string(&target).expect("read untouched source"),
            "Unbound source"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_as_policy_can_create_a_new_standalone_target() {
        let root = std::env::temp_dir().join(format!("yedit-save-as-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create fixture folder");
        let target = root.join("saved.txt");

        let result = save_standalone_source_encoded(
            &target,
            "Saved with Save As",
            None,
            SaveTargetPolicy::MayCreate,
        );

        assert_eq!(result.expect("Save As may create its target"), "utf-8");
        assert_eq!(
            fs::read_to_string(&target).expect("read saved file"),
            "Saved with Save As"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
