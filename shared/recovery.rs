//! Durable, app-private recovery. A failed write leaves the last checkpoint intact.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Default)]
pub struct RecoveryStore {
    checkpoint: Mutex<()>,
    close_request: Mutex<Option<bool>>,
    exit_allowed: AtomicBool,
}

/// The renderer acknowledges its latest checkpoint before normal window close
/// or Quit. A failed checkpoint leaves the window open with an actionable error.
pub fn request_close(app: &AppHandle, exit_app: bool) -> bool {
    let state = app.state::<RecoveryStore>();
    if state.exit_allowed.load(Ordering::SeqCst) || app.get_webview_window("main").is_none() {
        return false;
    }
    if let Ok(mut pending) = state.close_request.lock() {
        *pending = Some(exit_app || pending.unwrap_or(false));
    }
    let _ = app.emit_to("main", "recovery-close-requested", ());
    true
}

#[tauri::command]
pub fn recovery_finish_close(
    app: AppHandle,
    window: WebviewWindow,
    state: State<RecoveryStore>,
) -> Result<(), String> {
    let request = state
        .close_request
        .lock()
        .map_err(|_| "Close state is unavailable.")?
        .take();
    match request {
        Some(true) => {
            state.exit_allowed.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        Some(false) => {
            window.destroy().map_err(|e| e.to_string())?;
        }
        None => {}
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    version: u32,
    pub saved_at: u64,
    pub payload: Value,
}

fn location(app: &AppHandle, window: &WebviewWindow) -> Result<PathBuf, String> {
    let label: String = window.label().bytes().map(|b| format!("{b:02x}")).collect();
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery")
        .join(format!("{label}.json")))
}

fn read(path: &Path) -> Result<Option<Checkpoint>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let checkpoint: Checkpoint = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Recovery could not be read: {e}"))?;
            if checkpoint.version != 1 {
                return Err(
                    "Unsupported recovery version; existing recovery was preserved.".to_owned(),
                );
            }
            Ok(Some(checkpoint))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Recovery could not be read: {e}")),
    }
}

fn write(path: &Path, checkpoint: &Checkpoint) -> Result<(), String> {
    let bytes = serde_json::to_vec(checkpoint).map_err(|e| e.to_string())?;
    // Explicit failure, never silently omit a tab or truncate its contents.
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("Recovery exceeds 256 MB. Save some documents to disk.".to_owned());
    }
    let directory = path.parent().ok_or("Recovery folder is unavailable.")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let pending = path.with_extension("pending");
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&pending).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Recovery could not be saved: {e}"))?;
    fs::rename(&pending, path).map_err(|e| e.to_string())?;
    fs::File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn recovery_load(
    app: AppHandle,
    window: WebviewWindow,
    state: State<RecoveryStore>,
) -> Result<Option<Checkpoint>, String> {
    let _guard = state
        .checkpoint
        .lock()
        .map_err(|_| "Recovery store is unavailable.")?;
    read(&location(&app, &window)?)
}

#[tauri::command]
pub fn recovery_save(
    app: AppHandle,
    window: WebviewWindow,
    state: State<RecoveryStore>,
    payload: Value,
) -> Result<u64, String> {
    let _guard = state
        .checkpoint
        .lock()
        .map_err(|_| "Recovery store is unavailable.")?;
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    write(
        &location(&app, &window)?,
        &Checkpoint {
            version: 1,
            saved_at,
            payload,
        },
    )?;
    Ok(saved_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        std::env::temp_dir().join(format!(
            "editor-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn recovery_roundtrip_keeps_large_drafts_and_empty_checkpoint() {
        let dir = fixture();
        let path = dir.join("main.json");
        let payload = serde_json::json!({"documents": (0..15).map(|i| serde_json::json!({"id":i,"content":"x".repeat(300_000)})).collect::<Vec<_>>()});
        write(
            &path,
            &Checkpoint {
                version: 1,
                saved_at: 1,
                payload: payload.clone(),
            },
        )
        .unwrap();
        assert_eq!(read(&path).unwrap().unwrap().payload, payload);
        write(
            &path,
            &Checkpoint {
                version: 1,
                saved_at: 2,
                payload: serde_json::json!({"documents":[]}),
            },
        )
        .unwrap();
        assert_eq!(
            read(&path).unwrap().unwrap().payload["documents"],
            serde_json::json!([])
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn interrupted_pending_write_does_not_replace_checkpoint() {
        let dir = fixture();
        let path = dir.join("main.json");
        write(
            &path,
            &Checkpoint {
                version: 1,
                saved_at: 1,
                payload: serde_json::json!({"text":"saved draft"}),
            },
        )
        .unwrap();
        fs::write(path.with_extension("pending"), b"partial").unwrap();
        assert_eq!(read(&path).unwrap().unwrap().payload["text"], "saved draft");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_checkpoint_is_an_error_not_an_empty_session() {
        let dir = fixture();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("main.json");
        fs::write(&path, b"partial").unwrap();
        assert!(read(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"partial");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_write_keeps_previous_checkpoint() {
        let dir = fixture();
        let path = dir.join("main.json");
        write(
            &path,
            &Checkpoint {
                version: 1,
                saved_at: 1,
                payload: serde_json::json!({"text":"last good draft"}),
            },
        )
        .unwrap();
        // A blocked pending path simulates an I/O failure before replacement.
        fs::create_dir(path.with_extension("pending")).unwrap();
        assert!(write(
            &path,
            &Checkpoint {
                version: 1,
                saved_at: 2,
                payload: serde_json::json!({"documents":[]})
            }
        )
        .is_err());
        assert_eq!(
            read(&path).unwrap().unwrap().payload["text"],
            "last good draft"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
