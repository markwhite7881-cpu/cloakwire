pub mod coordinator;
mod event_filter;
pub mod intent;
#[cfg(target_os = "macos")]
mod macos;
pub mod policy;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) fn subscribe_wake() {
    windows::subscribe();
}
#[cfg(target_os = "macos")]
pub(crate) fn subscribe_wake() {
    macos::subscribe();
}
#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn subscribe_wake() {}
