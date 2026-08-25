//! Process-local state for the native Yedit command layer.

use notify::RecommendedWatcher;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::AppHandle;

/// A single native project watcher, scoped to the webview that created it.
pub struct ProjectWatcher {
    pub window_label: String,
    pub root: PathBuf,
    /// Keeping this value alive keeps notify's OS watcher registered.
    #[allow(dead_code)]
    pub watcher: RecommendedWatcher,
}

/// Finder may deliver files before the React workbench has installed its
/// event listener. Keep those native paths briefly, then turn them into
/// opaque standalone-file permissions only when the intended webview asks.
#[derive(Default)]
pub struct PendingExternalFiles {
    paths: Mutex<Vec<PathBuf>>,
    frontend_ready: AtomicBool,
}

impl PendingExternalFiles {
    pub fn push(&self, paths: Vec<PathBuf>) -> bool {
        let mut pending = self
            .paths
            .lock()
            .expect("external file queue lock poisoned");
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
        self.frontend_ready.load(Ordering::Acquire)
    }

    pub fn take(&self) -> Vec<PathBuf> {
        self.frontend_ready.store(true, Ordering::Release);
        let mut pending = self
            .paths
            .lock()
            .expect("external file queue lock poisoned");
        std::mem::take(&mut *pending)
    }
}

/// State deliberately keeps renderer-issued capabilities narrow:
///
/// - Standalone source file paths are only addressable through a random,
///   per-window handle.
/// - Project watching is owned by the creating window and is released when it
///   is explicitly stopped (or when Tauri drops application state at exit).
pub struct CoreState {
    pub app: AppHandle,
    pub standalone_files: Mutex<HashMap<String, HashMap<String, PathBuf>>>,
    pub project_watchers: Mutex<HashMap<String, ProjectWatcher>>,
    pub recent_entries_lock: Mutex<()>,
    menu_delivery: Mutex<MenuDeliveryState>,
}

#[derive(Default)]
struct MenuDeliveryState {
    ready_windows: HashSet<String>,
    pending_actions: Vec<String>,
}

impl CoreState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            standalone_files: Mutex::new(HashMap::new()),
            project_watchers: Mutex::new(HashMap::new()),
            recent_entries_lock: Mutex::new(()),
            menu_delivery: Mutex::new(MenuDeliveryState::default()),
        }
    }

    /// Returns `true` when an action was held for a renderer that has not
    /// installed its event listeners yet. The queue is intentionally native
    /// state rather than a frontend timeout, preserving reliable readiness
    /// behaviour across native menu clicks.
    pub fn queue_menu_action_until_ready(&self, window_label: &str, action: &str) -> bool {
        let Ok(mut delivery) = self.menu_delivery.lock() else {
            // Do not make a native File/Edit menu unusable because a mutex was
            // poisoned. The caller will make a best-effort direct emission.
            return false;
        };
        if delivery.ready_windows.contains(window_label) {
            return false;
        }
        delivery.pending_actions.push(action.to_owned());
        true
    }

    /// Marks a webview as ready and drains native actions chosen before its
    /// `listen("menu-action")` subscription was registered.
    pub fn renderer_ready(&self, window_label: &str) -> Vec<String> {
        let Ok(mut delivery) = self.menu_delivery.lock() else {
            return Vec::new();
        };
        delivery.ready_windows.insert(window_label.to_owned());
        std::mem::take(&mut delivery.pending_actions)
    }

    /// Removes opaque file permissions and native watchers belonging to a
    /// closed webview. Call this from the Tauri window-event hook if Yedit
    /// later supports multiple workbench windows.
    pub fn release_window(&self, window_label: &str) {
        if let Ok(mut files) = self.standalone_files.lock() {
            files.remove(window_label);
        }
        if let Ok(mut watchers) = self.project_watchers.lock() {
            watchers.retain(|_, record| record.window_label != window_label);
        }
        if let Ok(mut delivery) = self.menu_delivery.lock() {
            delivery.ready_windows.remove(window_label);
        }
    }
}
