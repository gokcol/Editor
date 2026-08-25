//! Yedit's native Tauri host. The React application talks only to the
//! explicitly registered commands below; it never receives a generic shell or
//! filesystem capability.

mod core;
mod html_export;
mod menu;
mod models;
mod state;
mod text_encoding;
mod tools;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
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
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<state::CoreState>()
                    .release_window(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            core::project_open,
            core::project_open_file,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Yedit");
}
