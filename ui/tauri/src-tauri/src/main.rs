// Suppresses the extra console window that appears on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::EngineState;
use tauri::Manager; // required for app_handle.state::<T>()

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_engine,
            commands::stop_engine,
            commands::engine_running,
            commands::read_config,
            commands::write_config,
        ])
        .on_window_event(|window, event| match event {
            // When the window is destroyed (final close), attempt a clean engine
            // shutdown so Node can flush any pending I/O before the OS reclaims it.
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                let state = app.state::<EngineState>();
                if let Ok(mut guard) = state.child.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                };
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
