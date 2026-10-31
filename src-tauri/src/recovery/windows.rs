//! Windows 8+ resume callback; no window, privileges, or suspend veto.
// https://learn.microsoft.com/windows/win32/api/powerbase/nf-powerbase-powerregistersuspendresumenotification
use std::ffi::c_void;
#[repr(C)]
struct Subscribe {
    callback: unsafe extern "system" fn(*mut c_void, u32, *mut c_void) -> u32,
    context: *mut c_void,
}
#[link(name = "Powrprof")]
extern "system" {
    fn PowerRegisterSuspendResumeNotification(
        flags: u32,
        recipient: *mut c_void,
        registration: *mut *mut c_void,
    ) -> u32;
}
unsafe extern "system" fn power(_: *mut c_void, kind: u32, _: *mut c_void) -> u32 {
    if matches!(kind, 7 | 18) {
        crate::diagnostics::network_events::wake();
    }
    0
}
pub(super) fn subscribe() {
    let parameters = Box::into_raw(Box::new(Subscribe {
        callback: power,
        context: std::ptr::null_mut(),
    }));
    let mut registration = std::ptr::null_mut();
    let result =
        unsafe { PowerRegisterSuspendResumeNotification(2, parameters.cast(), &mut registration) };
    if result != 0 {
        unsafe {
            drop(Box::from_raw(parameters));
        }
        log::warn!("recovery: Windows resume notifications unavailable");
    }
    // Successful OS registration and parameters have process lifetime. The only
    // callback access is to a static atomic, so no destructible caller context.
}
