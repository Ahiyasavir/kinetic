use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// Engine subprocess state — shared across all Tauri commands via managed state.
pub struct EngineState {
    pub child: Mutex<Option<Child>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// Spawn `node <server_path>` and track the child process.
///
/// Returns the spawned PID on success. Errors if the server is already running,
/// the path does not exist, or `node` is not found on PATH.
#[tauri::command]
pub fn start_engine(
    state: State<'_, EngineState>,
    server_path: String,
) -> Result<u32, String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "engine state lock poisoned".to_string())?;

    // If we hold a stale handle, check whether the process is still alive.
    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(None) => return Err("engine is already running".to_string()),
            // Process has exited (or status is unknowable) — clear and restart.
            Ok(Some(_)) | Err(_) => {}
        }
        *guard = None;
    }

    let server = std::path::PathBuf::from(&server_path);
    if !server.exists() {
        return Err(format!("server.mjs not found: {}", server.display()));
    }

    // Run Node in server.mjs's directory so __dirname-relative paths resolve correctly.
    let cwd = server
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();

    let child = Command::new("node")
        .arg(&server)
        .current_dir(&cwd)
        .stdout(Stdio::null()) // control center polls via HTTP; stdout noise not needed
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn node: {e}"))?;

    let pid = child.id();
    *guard = Some(child);
    Ok(pid)
}

/// Kill the control server and clear its handle.
///
/// Idempotent — calling when no engine is running is a silent no-op.
/// On Windows this calls TerminateProcess; on Unix it sends SIGKILL.
/// Node's server holds no durable in-memory write state (all engine state is
/// on disk), so an immediate kill is safe.
#[tauri::command]
pub fn stop_engine(state: State<'_, EngineState>) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "engine state lock poisoned".to_string())?;

    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("kill failed: {e}"))?;
        let _ = child.wait(); // reap the zombie so the OS can reclaim the PID
    }
    Ok(())
}

/// Returns `true` when the control server process is alive.
#[tauri::command]
pub fn engine_running(state: State<'_, EngineState>) -> bool {
    let Ok(mut guard) = state.child.lock() else {
        return false;
    };

    match &mut *guard {
        None => false,
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            // Process exited or status unknowable — drop the stale handle.
            Ok(Some(_)) | Err(_) => {
                *guard = None;
                false
            }
        },
    }
}

/// Read `config_path` and return its raw UTF-8 contents.
/// Used by the Settings page to load the current `config.json`.
#[tauri::command]
pub fn read_config(config_path: String) -> Result<String, String> {
    std::fs::read_to_string(&config_path)
        .map_err(|e| format!("cannot read {config_path}: {e}"))
}

/// Validate `json` as well-formed JSON, then atomically write it to `config_path`.
///
/// Writes to a `.json.tmp` sibling first, then renames — so a failed write or
/// unexpected process exit can never leave the original file corrupted.
#[tauri::command]
pub fn write_config(config_path: String, json: String) -> Result<(), String> {
    // Reject malformed JSON before touching the filesystem.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("invalid JSON: {e}"))?;

    let dest = std::path::PathBuf::from(&config_path);
    let tmp = dest.with_extension("json.tmp");

    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("write to temp file failed: {e}"))?;

    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup of the orphan
        format!("atomic rename failed: {e}")
    })?;

    Ok(())
}
