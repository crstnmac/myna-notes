mod capture;
mod calendar;
mod call_detect;
mod embed;
mod fluid;
mod mcp_snapshot;

use log;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                use sha2::{Digest, Sha256};
                let salt = b"notes-app-vault-salt-v2";
                let password_bytes: &[u8] = password.as_ref();
                let mut input = Vec::from(password_bytes);
                input.extend_from_slice(salt);
                for _ in 0..100_000 {
                    let mut hasher = Sha256::new();
                    hasher.update(&input);
                    input = hasher.finalize().to_vec();
                }
                // iota_stronghold requires the derived key to be exactly the
                // BoxProvider key length (32 bytes for XChaCha20Poly1305).
                input
            })
            .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // Quick capture from anywhere: ⌘⇧N shows the window and tells the
        // frontend to open a fresh note.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("quick-capture", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("meeting_notes", log::LevelFilter::Debug)
                .build(),
        )
        .setup(|app| {
            let show = MenuItemBuilder::with_id("show", "Show Myna Notes").build(app)?;
            let recording = MenuItemBuilder::with_id("recording", "Not Recording").build(app)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show, &recording, &separator, &quit])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Myna Notes")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Err(e) = window.show() {
                                log::warn!("failed to show window: {e}");
                            }
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        crate::capture::stop_continuous_sync();
                        if let Ok(mut guard) = crate::fluid::slot().try_lock() {
                            *guard = None;
                        }
                        if let Ok(mut guard) = crate::embed::slot().try_lock() {
                            *guard = None;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            app.listen("recording-state", move |event| {
                let payload: Option<serde_json::Value> = serde_json::from_str(event.payload()).ok();
                let recording = payload
                    .and_then(|v| v.get("recording").and_then(|r| r.as_bool()))
                    .unwrap_or(false);

                if let Some(tray) = handle.tray_by_id("main-tray") {
                    let tooltip = if recording {
                        "Myna Notes — Recording"
                    } else {
                        "Myna Notes"
                    };
                    let _ = tray.set_tooltip(Some(tooltip));
                }
            });

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                if let Err(e) = app.global_shortcut().register(Shortcut::new(
                    Some(Modifiers::SUPER | Modifiers::SHIFT),
                    Code::KeyN,
                )) {
                    // A collision with another app shouldn't take down startup.
                    log::warn!("global shortcut registration failed: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fluid::transcribe_audio_fluid,
            fluid::transcribe_audio_file_fluid,
            fluid::diarize_audio_file_fluid,
            fluid::check_fluid_ready,
            fluid::setup_fluid,
            fluid::setup_fluid_model,
            fluid::download_model,
            fluid::cancel_model_setup,
            fluid::model_setup_status,
            fluid::unload_fluid,
            fluid::fluid_loaded,
            fluid::model_storage_info,
            fluid::delete_model,
            fluid::check_screen_permission,
            fluid::request_screen_permission,
            fluid::prewarm_stream,
            capture::start_continuous,
            capture::stop_continuous,
            embed::embed_text,
            embed::embed_batch,
            embed::unload_embed,
            calendar::request_calendar_access,
            calendar::list_upcoming_events,
            calendar::calendar_authorization_status,
            call_detect::detect_call_apps,
            mcp_snapshot::write_mcp_snapshot,
            mcp_snapshot::mcp_snapshot_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
