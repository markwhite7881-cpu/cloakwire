//! System tray implementation for desktop platforms (Windows, macOS, Linux).

use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub const TRAY_ID: &str = "main-tray";
pub const MENU_STATUS: &str = "tray_status";
pub const MENU_TOGGLE: &str = "tray_toggle";
pub const MENU_SHOW: &str = "tray_show";
pub const MENU_QUIT: &str = "tray_quit";

pub struct TrayMenuHandles {
    pub status_item: MenuItem<tauri::Wry>,
    pub toggle_item: MenuItem<tauri::Wry>,
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let status_item = MenuItemBuilder::with_id(MENU_STATUS, "○ Cloakwire: Disconnected")
        .enabled(false)
        .build(app)?;

    let toggle_item = MenuItemBuilder::with_id(MENU_TOGGLE, "Connect")
        .build(app)?;

    let show_item = MenuItemBuilder::with_id(MENU_SHOW, "Show Cloakwire")
        .build(app)?;

    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "Quit")
        .build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&toggle_item)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Cloakwire - Idle");

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                MENU_SHOW => {
                    show_main_window(app);
                }
                MENU_TOGGLE => {
                    let _ = app.emit("tray:toggle-connect", ());
                }
                MENU_QUIT => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(pm) = app_handle.try_state::<Arc<crate::process::ProcessManager>>() {
                            let _ = pm.stop().await;
                        }
                        #[cfg(not(target_os = "android"))]
                        {
                            let _ = crate::killswitch::cleanup_stale_rules();
                        }
                        app_handle.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(Arc::new(TrayMenuHandles {
        status_item,
        toggle_item,
    }));

    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

pub fn update_tray_state(app: &AppHandle, connected: bool, profile_name: Option<&str>) {
    if let Some(handles) = app.try_state::<Arc<TrayMenuHandles>>() {
        if connected {
            let label = match profile_name {
                Some(name) if !name.is_empty() => format!("● Connected: {name}"),
                _ => "● Connected".to_string(),
            };
            let _ = handles.status_item.set_text(label);
            let _ = handles.toggle_item.set_text("Disconnect");
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_tooltip(Some("Cloakwire - Protected"));
            }
        } else {
            let _ = handles.status_item.set_text("○ Cloakwire: Disconnected");
            let _ = handles.toggle_item.set_text("Connect");
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_tooltip(Some("Cloakwire - Idle"));
            }
        }
    }
}
