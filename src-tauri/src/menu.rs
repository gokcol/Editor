//! The native macOS menu is deliberately a thin command surface: the React
//! workbench remains the single place that decides whether an action is
//! meaningful for the active document.  Menu IDs are therefore the same
//! action strings used by the command palette and keyboard dispatcher.

use crate::state::CoreState;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

fn action_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut item = MenuItemBuilder::with_id(id, label);
    if let Some(accelerator) = accelerator {
        item = item.accelerator(accelerator);
    }
    item.build(app)
}

fn source_item<R: Runtime>(
    app: &AppHandle<R>,
    source_type: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    action_item(app, &format!("new-{source_type}"), label, accelerator)
}

/// Build the complete first-class menu surface for Yedit.  We keep all source
/// formats present here; the renderer already rejects a disabled format and
/// mirrors settings in its own creation palette.  This avoids a stale native
/// menu while settings are asynchronously loaded at launch.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = action_item(app, "about", "About Yedit", None)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Yedit"))?;
    let app_menu = SubmenuBuilder::new(app, "Yedit")
        .item(&about)
        .separator()
        .item(&quit)
        .build()?;

    let new_project = action_item(
        app,
        "new-project",
        "New Project…",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_file = action_item(app, "open-file", "Open File…", Some("CmdOrCtrl+O"))?;
    let open_project = action_item(
        app,
        "open-project",
        "Open Folder…",
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let open_recents = crate::recent_menu::build(app)?;
    let new_source = action_item(app, "new-file", "New Source File…", Some("CmdOrCtrl+N"))?;
    let save = action_item(app, "save", "Save", Some("CmdOrCtrl+S"))?;
    let save_as = action_item(app, "save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?;
    let encoding = action_item(app, "encoding", "Text Encoding…", None)?;
    let export = action_item(app, "export", "Export…", Some("CmdOrCtrl+E"))?;
    let project_task_file = action_item(app, "project-task-file", "Project Tasks…", None)?;

    let diagrams = SubmenuBuilder::new(app, "Diagram & Documents")
        .item(&source_item(app, "tikz", "TikZ (.tikz)", None)?)
        .item(&source_item(app, "latex", "LaTeX (.tex)", None)?)
        .item(&source_item(app, "metafont", "MetaFont (.mf)", None)?)
        .item(&source_item(app, "svg", "SVG (.svg)", None)?)
        .item(&source_item(app, "mermaid", "Mermaid (.mmd)", None)?)
        .item(&source_item(app, "markdown", "Markdown (.md)", None)?)
        .item(&source_item(app, "text", "Plain Text (.txt)", None)?)
        .build()?;
    let data = SubmenuBuilder::new(app, "Data")
        .item(&source_item(app, "yaml", "YAML (.yaml)", None)?)
        .item(&source_item(app, "json", "JSON (.json)", None)?)
        .build()?;
    let code = SubmenuBuilder::new(app, "Code & Web")
        .item(&source_item(app, "javascript", "JavaScript (.js)", None)?)
        .item(&source_item(app, "typescript", "TypeScript (.ts)", None)?)
        .item(&source_item(app, "python", "Python (.py)", None)?)
        .item(&source_item(app, "php", "PHP (.php, .phtml)", None)?)
        .item(&source_item(app, "c", "C (.c, .h)", None)?)
        .item(&source_item(app, "cpp", "C++ (.cpp, .hpp)", None)?)
        .item(&source_item(app, "pascal", "Pascal (.pas)", None)?)
        .item(&source_item(app, "go", "Go (.go)", None)?)
        .item(&source_item(app, "ruby", "Ruby (.rb)", None)?)
        .item(&source_item(app, "swift", "Swift (.swift)", None)?)
        .item(&source_item(
            app,
            "objectivec",
            "Objective-C / C++ (.m, .mm)",
            None,
        )?)
        .item(&source_item(app, "kotlin", "Kotlin (.kt, .kts)", None)?)
        .item(&source_item(
            app,
            "fortran",
            "Fortran (.f, .for, .f90, .f95…)",
            None,
        )?)
        .item(&source_item(app, "sql", "SQL (.sql)", None)?)
        .item(&source_item(app, "html", "HTML (.html)", None)?)
        .item(&source_item(app, "css", "CSS (.css)", None)?)
        .build()?;
    let scripts = SubmenuBuilder::new(app, "Shell & Windows Scripts")
        .item(&source_item(app, "bash", "Bash / shell (.sh)", None)?)
        .item(&source_item(app, "csh", "C shell (.csh, .tcsh)", None)?)
        .item(&source_item(app, "powershell", "PowerShell (.ps1)", None)?)
        .item(&source_item(
            app,
            "batch",
            "Windows batch (.bat, .cmd)",
            None,
        )?)
        .item(&source_item(app, "vbscript", "VBScript (.vbs)", None)?)
        .build()?;
    let source_as = SubmenuBuilder::new(app, "New Source As")
        .item(&diagrams)
        .item(&data)
        .item(&code)
        .item(&scripts)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_project)
        .item(&open_file)
        .item(&open_project)
        .item(&open_recents)
        .item(&project_task_file)
        .separator()
        .item(&new_source)
        .item(&source_as)
        .item(&save)
        .item(&save_as)
        .item(&encoding)
        .separator()
        .item(&export)
        .build()?;

    let undo = action_item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?;
    let redo = action_item(app, "redo", "Redo", Some("Shift+CmdOrCtrl+Z"))?;
    let format = action_item(app, "format", "Format Document", Some("Shift+Alt+F"))?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&format)
        .build()?;

    let json = SubmenuBuilder::new(app, "JSON")
        .item(&action_item(app, "json-validate", "Validate JSON", None)?)
        .item(&action_item(
            app,
            "json-pretty",
            "Pretty print JSON",
            Some("Shift+Alt+J"),
        )?)
        .item(&action_item(app, "json-minify", "Minify JSON", None)?)
        .separator()
        .item(&action_item(
            app,
            "json-schema",
            "Generate JSON Schema",
            None,
        )?)
        .separator()
        .item(&action_item(
            app,
            "json-prompt-create",
            "Create JSON with AI prompt…",
            None,
        )?)
        .item(&action_item(
            app,
            "json-prompt-analyze",
            "Analyze JSON with AI prompt…",
            None,
        )?)
        .build()?;

    let python = SubmenuBuilder::new(app, "Python")
        .item(&action_item(
            app,
            "build",
            "Run Active Python Source",
            Some("CmdOrCtrl+Shift+B"),
        )?)
        .item(&action_item(
            app,
            "python-test",
            "Test Active Python Source",
            None,
        )?)
        .separator()
        .item(&action_item(
            app,
            "python-output",
            "Show Python Output",
            None,
        )?)
        .build()?;

    let diagram = SubmenuBuilder::new(app, "Diagram")
        .item(&action_item(
            app,
            "select-tikz",
            "TikZ Source",
            Some("CmdOrCtrl+1"),
        )?)
        .item(&action_item(
            app,
            "select-latex",
            "LaTeX Source",
            Some("CmdOrCtrl+2"),
        )?)
        .item(&action_item(
            app,
            "select-metafont",
            "MetaFont Source",
            Some("CmdOrCtrl+3"),
        )?)
        .item(&action_item(
            app,
            "select-svg",
            "SVG Source",
            Some("CmdOrCtrl+4"),
        )?)
        .item(&action_item(
            app,
            "select-mermaid",
            "Mermaid Source",
            Some("CmdOrCtrl+5"),
        )?)
        .item(&action_item(
            app,
            "select-markdown",
            "Markdown Source",
            Some("CmdOrCtrl+6"),
        )?)
        .item(&action_item(
            app,
            "select-text",
            "Plain Text Source",
            Some("CmdOrCtrl+7"),
        )?)
        .separator()
        .item(&action_item(
            app,
            "render",
            "Render Preview",
            Some("CmdOrCtrl+Enter"),
        )?)
        .build()?;

    let navigation_controls = SubmenuBuilder::new(app, "Navigation Controls")
        .item(&action_item(
            app,
            "navigation-bottom",
            "Use Bottom Status Bar",
            None,
        )?)
        .item(&action_item(
            app,
            "navigation-left",
            "Use Left Activity Rail",
            None,
        )?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&action_item(
            app,
            "quick-open",
            "Quick Open…",
            Some("CmdOrCtrl+P"),
        )?)
        .item(&action_item(
            app,
            "palette",
            "Command Palette…",
            Some("Shift+CmdOrCtrl+P"),
        )?)
        .item(&navigation_controls)
        .separator()
        .item(&action_item(app, "explorer", "Toggle Explorer", None)?)
        .item(&action_item(app, "preview", "Toggle Live Preview", None)?)
        .item(&action_item(
            app,
            "editor-minimap",
            "Toggle Editor Minimap",
            None,
        )?)
        .item(&action_item(
            app,
            "references",
            "Toggle Reference Deck",
            Some("CmdOrCtrl+Shift+R"),
        )?)
        .item(&action_item(
            app,
            "reset-layout",
            "Reset Panel Layout",
            None,
        )?)
        .separator()
        .item(&action_item(
            app,
            "prompt-studio",
            "Prompt Studio…",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&action_item(app, "ask-ai", "Ask AI with Codex…", None)?)
        .item(&action_item(
            app,
            "settings",
            "Settings…",
            Some("CmdOrCtrl+,"),
        )?)
        .build()?;

    // Keep help native to macOS while letting React render the actual guide.
    // The command ids deliberately match the command palette entries, so the
    // same overlays also work from a browser build and future platform menus.
    let help = SubmenuBuilder::new(app, "Help")
        .item(&action_item(
            app,
            "help-getting-started",
            "Getting Started",
            None,
        )?)
        .item(&action_item(
            app,
            "help-shortcuts",
            "Keyboard Shortcuts",
            None,
        )?)
        .separator()
        .item(&action_item(
            app,
            "whats-new",
            "What's New in Yedit 1.0",
            None,
        )?)
        .separator()
        .item(&action_item(app, "help-about", "About Yedit", None)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file)
        .item(&edit)
        .item(&json)
        .item(&python)
        .item(&diagram)
        .item(&view)
        .item(&help)
        .build()
}

/// Forward a native menu choice to the one workbench window.  `emit_to` is
/// intentionally fallible: a menu can be clicked while the app is closing.
pub fn dispatch_menu_action<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id.is_empty() || id.starts_with("__") {
        return;
    }
    if app
        .state::<CoreState>()
        .queue_menu_action_until_ready("main", id)
    {
        return;
    }
    let _ = app.emit_to("main", "menu-action", id);
}
