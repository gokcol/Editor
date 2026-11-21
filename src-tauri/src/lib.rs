//! Yedit's native Tauri host. The React application talks only to the
//! explicitly registered commands below; it never receives a generic shell or
//! filesystem capability.

mod core;
#[path = "../../shared/codex_ai.rs"]
mod codex_ai;
#[path = "../../shared/file_version.rs"]
mod file_version;
#[path = "../../shared/recovery.rs"]
mod recovery;
#[path = "../../shared/updates.rs"]
mod updates;
mod html_export;
mod menu;
#[path = "../../shared/recent_menu.rs"]
mod recent_menu;
mod models;
mod state;
mod text_encoding;
mod tools;

use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime};

use state::PendingExternalFiles;

fn is_regular_external_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn initial_open_paths() -> Vec<PathBuf> {
    env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| is_regular_external_file(path))
        .collect()
}

fn paths_from_instance_arguments(args: Vec<String>, cwd: &str) -> Vec<PathBuf> {
    let cwd = PathBuf::from(cwd);
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| is_regular_external_file(path))
        .collect()
}

fn queue_external_open_paths<R: Runtime>(
    app: &AppHandle<R>,
    paths: impl IntoIterator<Item = PathBuf>,
) {
    let paths = paths
        .into_iter()
        .filter_map(|path| fs::canonicalize(path).ok())
        .collect::<Vec<_>>();
    if !paths.is_empty() {
        let frontend_ready = app.state::<PendingExternalFiles>().push(paths);
        if frontend_ready {
            let _ = app.emit_to("main", "external-open-files", ());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(codex_ai::CodexAiState::default())
        .manage(recovery::RecoveryStore::default())
        .manage(updates::UpdateService::default())
        .manage(PendingExternalFiles::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            queue_external_open_paths(app, paths_from_instance_arguments(args, &cwd));
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(state::CoreState::new(handle.clone()));
            app.set_menu(menu::build_menu(&handle)?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::dispatch_menu_action(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if recovery::request_close(window.app_handle(), false) { api.prevent_close(); }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<codex_ai::CodexAiState>().cancel_all();
                window
                    .state::<state::CoreState>()
                    .release_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates::updates_info,
            updates::updates_check,
            updates::updates_open,
            codex_ai::codex_ai_status,
            codex_ai::codex_ai_login,
            codex_ai::codex_ai_ask,
            codex_ai::codex_ai_cancel,
            recovery::recovery_load,
            recovery::recovery_save,
            recovery::recovery_finish_close,
            core::project_open,
            core::project_open_file,
            core::project_reveal_open_file_folder,
            core::project_create,
            core::project_refresh,
            core::project_read_file,
            core::project_write_file,
            core::project_create_file,
            core::project_rename_file,
            core::project_duplicate_file,
            core::project_delete_file,
            core::project_watch,
            core::project_unwatch,
            tools::project_build_profiles,
            tools::project_list_tasks,
            tools::project_run_task,
            tools::project_run_build,
            tools::project_run_python,
            core::project_write_open_file,
            core::project_read_open_file,
            core::project_save_as,
            recent_menu::sync_recent_menu,
            core::recents_list,
            core::recents_migrate_legacy_projects,
            core::recents_open,
            core::recents_remove,
            core::recents_clear,
            tools::render_tikz,
            tools::render_latex,
            tools::render_metafont,
            tools::render_export,
            tools::git_status,
            tools::git_diff,
            tools::git_log,
            tools::git_stage,
            tools::git_unstage,
            tools::git_commit,
            tools::git_branches,
            tools::git_switch_branch,
            tools::clipboard_write_svg,
            tools::clipboard_write_data_uri_image,
            core::settings_load,
            core::settings_save,
            tools::shell_reveal,
            core::renderer_ready,
            core::take_pending_external_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Yedit");
    queue_external_open_paths(app.handle(), initial_open_paths());
    app.run(|app, event| {
        if matches!(&event, RunEvent::Exit) { app.state::<codex_ai::CodexAiState>().cancel_all(); }
        if let RunEvent::ExitRequested { api, .. } = &event {
            if recovery::request_close(app, true) { api.prevent_exit(); }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = event {
            queue_external_open_paths(
                app,
                urls.into_iter().filter_map(|url| url.to_file_path().ok()),
            );
        }
    });
}
