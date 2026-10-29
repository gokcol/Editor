//! Data transfer objects shared by Yedit's native commands.
//!
//! The React workbench already has a deliberately small desktop contract.
//! These types keep the Tauri side of that contract stable and use the same
//! camelCase JSON keys used by the renderer contract.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

pub const SOURCE_TYPE_IDS: &[&str] = &[
    "tikz",
    "latex",
    "metafont",
    "svg",
    "mermaid",
    "markdown",
    "text",
    "yaml",
    "json",
    "javascript",
    "typescript",
    "python",
    "php",
    "fortran",
    "sql",
    "html",
    "css",
    "c",
    "cpp",
    "pascal",
    "go",
    "ruby",
    "bash",
    "csh",
    "powershell",
    "batch",
    "vbscript",
    "swift",
    "objectivec",
    "kotlin",
];
pub const EXTRA_SOURCE_TYPE_IDS: &[&str] = &[
    "c",
    "cpp",
    "pascal",
    "go",
    "ruby",
    "bash",
    "csh",
    "powershell",
    "batch",
    "vbscript",
    "swift",
    "objectivec",
    "kotlin",
];
pub const SOURCE_TYPES_VERSION: u64 = 2;

pub const MAX_RECENT_ENTRIES: usize = 12;
pub const MAX_PROJECT_TREE_DEPTH: usize = 32;

pub fn source_type_for_path(path: &Path) -> String {
    source_kind_for_path(path).to_owned()
}

/// The same filename policy is used by file open, recovery, and build checks.
pub fn source_kind_for_path(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("C" | "H")
    ) {
        return "cpp";
    }
    match name.to_ascii_lowercase().as_str() {
        ".bashrc" | ".bash_profile" | ".bash_login" | ".bash_logout" | ".profile" | ".zshrc"
        | ".zprofile" | ".kshrc" => return "bash",
        ".cshrc" | ".tcshrc" | ".login" | ".logout" => return "csh",
        "rakefile" | "gemfile" | "guardfile" | "vagrantfile" => return "ruby",
        _ => {}
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "tex" | "latex" | "ltx" => "latex",
        "tikz" => "tikz",
        "mf" => "metafont",
        "svg" => "svg",
        "mmd" | "mermaid" => "mermaid",
        "md" | "markdown" => "markdown",
        "txt" => "text",
        "yaml" | "yml" => "yaml",
        "json" => "json",
        "js" | "cjs" | "mjs" | "jsx" => "javascript",
        "ts" | "cts" | "mts" | "tsx" => "typescript",
        "py" | "pyw" => "python",
        "php" | "php3" | "php4" | "php5" | "php6" | "php7" | "php8" | "phtml" => "php",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hh" | "hxx" | "h++" | "ipp" | "tpp" | "ixx"
        | "cppm" => "cpp",
        "pas" | "pp" | "p" | "lpr" | "dpr" => "pascal",
        "go" => "go",
        "rb" | "rake" | "gemspec" | "ru" => "ruby",
        "sh" | "bash" | "zsh" | "ksh" => "bash",
        "csh" | "tcsh" => "csh",
        "ps1" | "psm1" | "psd1" => "powershell",
        "bat" | "cmd" => "batch",
        "vbs" => "vbscript",
        "swift" => "swift",
        "m" | "mm" => "objectivec",
        "kt" | "kts" => "kotlin",
        "f" | "for" | "f90" | "f95" | "f03" | "f08" | "f18" => "fortran",
        "sql" | "ddl" | "dml" | "dql" => "sql",
        "html" | "htm" | "xhtml" => "html",
        "css" => "css",
        // An unrecognised filename is still an ordinary text document.  It
        // should never be interpreted as TikZ merely because it lacks one of
        // Yedit's first-class extensions.
        _ => "text",
    }
}

pub fn extension_for_source_type(source_type: &str) -> &'static str {
    match source_type {
        "latex" => "tex",
        "tikz" => "tikz",
        "metafont" => "mf",
        "svg" => "svg",
        "mermaid" => "mmd",
        "markdown" => "md",
        "text" => "txt",
        "yaml" => "yaml",
        "json" => "json",
        "javascript" => "js",
        "typescript" => "ts",
        "python" => "py",
        "php" => "php",
        "c" => "c",
        "cpp" => "cpp",
        "pascal" => "pas",
        "go" => "go",
        "ruby" => "rb",
        "bash" => "sh",
        "csh" => "csh",
        "powershell" => "ps1",
        "batch" => "bat",
        "vbscript" => "vbs",
        "swift" => "swift",
        "objectivec" => "m",
        "kotlin" => "kt",
        "fortran" => "f90",
        "sql" => "sql",
        "html" => "html",
        "css" => "css",
        _ => "tex",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub appearance: String,
    pub ui_scale: i64,
    pub editor_font_family: String,
    pub editor_font_size: i64,
    pub editor_background_color: String,
    pub editor_background_pattern: String,
    pub enabled_source_types: Vec<String>,
    pub source_types_version: u64,
    pub reference_font_size: i64,
    pub explorer_open: bool,
    pub preview_open: bool,
    pub reference_open: bool,
    pub explorer_width: i64,
    pub inspector_width: i64,
    pub preview_split: i64,
    pub auto_save: bool,
    pub safe_mode: bool,
    pub format_on_save: bool,
    pub preview_auto_render: bool,
    pub editor_word_wrap: bool,
    pub editor_minimap: bool,
    pub editor_tab_size: i64,
    pub navigation_placement: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "system".to_owned(),
            ui_scale: 110,
            editor_font_family: "SF Mono".to_owned(),
            editor_font_size: 14,
            editor_background_color: "theme".to_owned(),
            editor_background_pattern: "none".to_owned(),
            enabled_source_types: SOURCE_TYPE_IDS
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            source_types_version: SOURCE_TYPES_VERSION,
            reference_font_size: 10,
            explorer_open: true,
            preview_open: true,
            reference_open: true,
            explorer_width: 245,
            inspector_width: 390,
            preview_split: 54,
            auto_save: true,
            safe_mode: false,
            format_on_save: false,
            preview_auto_render: true,
            editor_word_wrap: true,
            editor_minimap: false,
            editor_tab_size: 2,
            navigation_placement: "bottom".to_owned(),
        }
    }
}

impl AppSettings {
    pub fn normalize(candidate: &Value) -> Self {
        let defaults = Self::default();
        let appearance = allowed_string(
            candidate,
            "appearance",
            &["system", "dark", "light"],
            &defaults.appearance,
        );
        let ui_scale = clamped_number(candidate, "uiScale", 85, 150, 5, defaults.ui_scale);
        let editor_font_family = allowed_string(
            candidate,
            "editorFontFamily",
            &[
                "SF Mono",
                "Menlo",
                "Monaco",
                "JetBrains Mono",
                "Fira Code",
                "IBM Plex Mono",
            ],
            &defaults.editor_font_family,
        );
        let editor_font_size = clamped_number(
            candidate,
            "editorFontSize",
            11,
            24,
            1,
            defaults.editor_font_size,
        );
        let editor_background_color = candidate
            .get("editorBackgroundColor")
            .and_then(Value::as_str)
            .filter(|value| *value == "theme" || is_hex_color(value))
            .unwrap_or(&defaults.editor_background_color)
            .to_owned();
        let editor_background_pattern = allowed_string(
            candidate,
            "editorBackgroundPattern",
            &["none", "grid", "dots", "lines"],
            &defaults.editor_background_pattern,
        );
        let requested_source_types = candidate
            .get("enabledSourceTypes")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>());
        // Only upgrade an older all-enabled default. Never undo custom subsets
        // or opt-outs saved by a version that already knows these modes.
        let version = candidate
            .get("sourceTypesVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let upgrade_default = version < SOURCE_TYPES_VERSION
            && requested_source_types.as_ref().is_some_and(|values| {
                SOURCE_TYPE_IDS
                    .iter()
                    .filter(|kind| {
                        !EXTRA_SOURCE_TYPE_IDS.contains(kind) && !(version < 1 && **kind == "php")
                    })
                    .all(|kind| values.contains(kind))
            });
        let mut enabled_source_types = SOURCE_TYPE_IDS
            .iter()
            .filter(|source_type| {
                requested_source_types
                    .as_ref()
                    .map(|values| {
                        values.iter().any(|value| value == *source_type) || upgrade_default
                    })
                    .unwrap_or_else(|| {
                        defaults
                            .enabled_source_types
                            .iter()
                            .any(|value| value == *source_type)
                    })
            })
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        if enabled_source_types.is_empty() {
            enabled_source_types.push("text".to_owned());
        }

        Self {
            appearance,
            ui_scale,
            editor_font_family,
            editor_font_size,
            editor_background_color,
            editor_background_pattern,
            enabled_source_types,
            source_types_version: SOURCE_TYPES_VERSION,
            reference_font_size: clamped_number(
                candidate,
                "referenceFontSize",
                9,
                18,
                1,
                defaults.reference_font_size,
            ),
            explorer_open: bool_or(candidate, "explorerOpen", defaults.explorer_open),
            preview_open: bool_or(candidate, "previewOpen", defaults.preview_open),
            reference_open: bool_or(candidate, "referenceOpen", defaults.reference_open),
            explorer_width: clamped_number(
                candidate,
                "explorerWidth",
                180,
                480,
                1,
                defaults.explorer_width,
            ),
            inspector_width: clamped_number(
                candidate,
                "inspectorWidth",
                280,
                760,
                1,
                defaults.inspector_width,
            ),
            preview_split: clamped_number(
                candidate,
                "previewSplit",
                30,
                75,
                1,
                defaults.preview_split,
            ),
            auto_save: bool_or(candidate, "autoSave", defaults.auto_save),
            safe_mode: bool_or(candidate, "safeMode", defaults.safe_mode),
            format_on_save: bool_or(candidate, "formatOnSave", defaults.format_on_save),
            preview_auto_render: bool_or(
                candidate,
                "previewAutoRender",
                defaults.preview_auto_render,
            ),
            editor_word_wrap: bool_or(candidate, "editorWordWrap", defaults.editor_word_wrap),
            editor_minimap: bool_or(candidate, "editorMinimap", defaults.editor_minimap),
            editor_tab_size: clamped_number(
                candidate,
                "editorTabSize",
                2,
                8,
                1,
                defaults.editor_tab_size,
            ),
            navigation_placement: allowed_string(
                candidate,
                "navigationPlacement",
                &["bottom", "left"],
                &defaults.navigation_placement,
            ),
        }
    }
}

fn allowed_string(candidate: &Value, key: &str, allowed: &[&str], fallback: &str) -> String {
    candidate
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| allowed.iter().any(|allowed| *allowed == *value))
        .unwrap_or(fallback)
        .to_owned()
}

fn bool_or(candidate: &Value, key: &str, fallback: bool) -> bool {
    candidate
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn clamped_number(
    candidate: &Value,
    key: &str,
    min: i64,
    max: i64,
    step: i64,
    fallback: i64,
) -> i64 {
    let Some(value) = candidate.get(key).and_then(Value::as_f64) else {
        return fallback;
    };
    if !value.is_finite() {
        return fallback;
    }
    let rounded = value.round() as i64;
    let stepped = if step > 1 {
        ((rounded as f64 / step as f64).round() as i64) * step
    } else {
        rounded
    };
    stepped.clamp(min, max)
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    pub size: u64,
    pub modified_at: f64,
    pub created_at: f64,
    pub is_symbolic_link: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Project {
    pub root: String,
    pub name: String,
    pub tree: Vec<FileNode>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Canceled {
    pub canceled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum ProjectOrCanceled {
    Project(Project),
    Canceled(Canceled),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSourceFile {
    pub disk_version: String,
    pub name: String,
    pub source_type: String,
    pub content: String,
    pub encoding: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneSourceFile {
    pub disk_version: String,
    pub name: String,
    pub source_type: String,
    pub content: String,
    pub encoding: String,
    pub file_handle: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum OpenedSourceFile {
    Project(ProjectSourceFile),
    Standalone(StandaloneSourceFile),
}

/// Files forwarded by Finder after the native application has finished
/// launching. Each payload is opened through the same opaque-file capability
/// path as the normal Open command; errors are kept alongside successful
/// files so a mixed Finder selection can still open what is readable.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenFilesResult {
    pub files: Vec<OpenedSourceFile>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSourceFile {
    pub disk_version: String,
    pub content: String,
    pub encoding: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum OpenedSourceOrCanceled {
    Source(OpenedSourceFile),
    Canceled(Canceled),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativePathResult {
    pub relative_path: String,
    pub disk_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFileResult {
    pub relative_path: String,
    pub previous_relative_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatedFileResult {
    pub relative_path: String,
    pub source_relative_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOpenedFileResult {
    pub name: String,
    pub disk_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAsResult {
    pub disk_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub opened_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectInput {
    pub root: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OpenRecentResult {
    Project { project: Project },
    File { file: OpenedSourceFile },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchResponse {
    pub watch_id: String,
    pub root: String,
    pub recursive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnwatchResponse {
    pub stopped: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChange {
    pub relative_path: String,
    pub event_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWatchUpdate {
    pub watch_id: String,
    pub root: String,
    pub changes: Vec<ProjectChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[cfg(test)]
mod settings_tests {
    use super::{
        extension_for_source_type, source_kind_for_path, source_type_for_path, AppSettings,
        SOURCE_TYPE_IDS,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn navigation_defaults_to_bottom_and_minimap_defaults_off() {
        let settings = AppSettings::normalize(&json!({}));
        assert_eq!(settings.navigation_placement, "bottom");
        assert!(!settings.editor_minimap);
    }

    #[test]
    fn settings_keep_explicit_minimap_and_validate_navigation_placement() {
        let left = AppSettings::normalize(&json!({
            "editorMinimap": true,
            "navigationPlacement": "left",
        }));
        assert!(left.editor_minimap);
        assert_eq!(left.navigation_placement, "left");

        let invalid = AppSettings::normalize(&json!({ "navigationPlacement": "floating" }));
        assert_eq!(invalid.navigation_placement, "bottom");
    }

    #[test]
    fn unknown_filename_extensions_open_as_plain_text() {
        assert_eq!(source_type_for_path(Path::new("settings.conf")), "text");
        assert_eq!(source_type_for_path(Path::new("README")), "text");
    }

    #[test]
    fn extended_languages_detect_files_and_preserve_default_migrations() {
        for (name, kind) in [
            ("source.c", "c"),
            ("header.h", "c"),
            ("source.C", "cpp"),
            ("header.H", "cpp"),
            ("header.hpp", "cpp"),
            ("module.cppm", "cpp"),
            ("unit.pas", "pascal"),
            ("app.dpr", "pascal"),
            ("main.go", "go"),
            ("Gemfile", "ruby"),
            ("folder/Rakefile", "ruby"),
            ("script.rb", "ruby"),
            ("script.sh", "bash"),
            (".bashrc", "bash"),
            ("folder/.zshrc", "bash"),
            ("script.tcsh", "csh"),
            (".cshrc", "csh"),
            ("script.ps1", "powershell"),
            ("module.psm1", "powershell"),
            ("script.cmd", "batch"),
            ("script.vbs", "vbscript"),
            ("main.swift", "swift"),
            ("main.m", "objectivec"),
            ("main.mm", "objectivec"),
            ("main.kt", "kotlin"),
            ("build.kts", "kotlin"),
            ("query.dml", "sql"),
            ("query.dql", "sql"),
            ("Gemfile.lock", "text"),
            ("source.cpp.bak", "text"),
        ] {
            assert_eq!(source_kind_for_path(Path::new(name)), kind, "{name}");
        }
        for kind in super::EXTRA_SOURCE_TYPE_IDS {
            let name = format!("source.{}", extension_for_source_type(kind));
            assert_eq!(source_kind_for_path(Path::new(&name)), *kind);
        }
        let old_default: Vec<_> = SOURCE_TYPE_IDS
            .iter()
            .filter(|kind| !super::EXTRA_SOURCE_TYPE_IDS.contains(kind))
            .collect();
        let upgraded = AppSettings::normalize(
            &json!({ "enabledSourceTypes": old_default, "sourceTypesVersion": 1 }),
        );
        assert_eq!(upgraded.enabled_source_types, SOURCE_TYPE_IDS);
        let opted_out = AppSettings::normalize(
            &json!({ "enabledSourceTypes": old_default, "sourceTypesVersion": 2 }),
        );
        assert!(!opted_out
            .enabled_source_types
            .iter()
            .any(|kind| kind == "swift"));
        let custom = AppSettings::normalize(
            &json!({ "enabledSourceTypes": ["text", "sql"], "sourceTypesVersion": 1 }),
        );
        assert_eq!(custom.enabled_source_types, ["text", "sql"]);
    }

    #[test]
    fn php_file_types_and_save_extension() {
        for extension in [
            "php", "phtml", "php3", "php4", "php5", "php6", "php7", "php8", "PHP", "PHTML",
        ] {
            assert_eq!(
                source_type_for_path(Path::new(&format!("index.{extension}"))),
                "php"
            );
        }
        assert_eq!(extension_for_source_type("php"), "php");
        assert_eq!(source_type_for_path(Path::new("index.php.txt")), "text");
        assert_eq!(source_type_for_path(Path::new("settings.inc")), "text");
    }

    #[test]
    fn php_settings_upgrade_default_once_and_preserve_custom_choices() {
        let old_types: Vec<_> = SOURCE_TYPE_IDS
            .iter()
            .filter(|kind| **kind != "php")
            .collect();
        let upgraded = AppSettings::normalize(&json!({ "enabledSourceTypes": old_types }));
        assert!(upgraded
            .enabled_source_types
            .iter()
            .any(|kind| kind == "php"));
        assert_eq!(upgraded.source_types_version, super::SOURCE_TYPES_VERSION);
        let disabled = AppSettings::normalize(
            &json!({ "enabledSourceTypes": old_types, "sourceTypesVersion": 1 }),
        );
        assert!(!disabled
            .enabled_source_types
            .iter()
            .any(|kind| kind == "php"));
        let custom = AppSettings::normalize(&json!({ "enabledSourceTypes": ["text", "json"] }));
        assert_eq!(custom.enabled_source_types, ["text", "json"]);
        assert!(AppSettings::default()
            .enabled_source_types
            .iter()
            .any(|kind| kind == "php"));
    }
}
