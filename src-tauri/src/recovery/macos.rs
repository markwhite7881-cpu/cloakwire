//! IOKit power notifications use their own process-lifetime CF run loop.
// https://developer.apple.com/documentation/iokit/1557114-ioregisterforsystempower
use core_foundation::runloop::{
    kCFRunLoopDefaultMode, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRun,
};
use std::{
    ffi::c_void,
    sync::atomic::{AtomicU32, Ordering},
};
static ROOT: AtomicU32 = AtomicU32::new(0);
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IORegisterForSystemPower(
        context: *mut c_void,
        port: *mut *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, u32, u32, *mut c_void),
        notifier: *mut u32,
    ) -> u32;
    fn IONotificationPortGetRunLoopSource(
        port: *mut c_void,
    ) -> core_foundation::runloop::CFRunLoopSourceRef;
    fn IOAllowPowerChange(root: u32, notification: isize) -> i32;
}
unsafe extern "C" fn power(_: *mut c_void, _: u32, kind: u32, argument: *mut c_void) {
    match kind {
        0xe0000270 | 0xe0000280 => {
            IOAllowPowerChange(ROOT.load(Ordering::Acquire), argument as isize);
        }
        0xe0000300 => crate::diagnostics::network_events::wake(),
        _ => {}
    }
}
pub(super) fn subscribe() {
    let _ = std::thread::Builder::new()
        .name("recovery-power-events".into())
        .spawn(|| unsafe {
            let mut port = std::ptr::null_mut();
            let mut notifier = 0;
            let root =
                IORegisterForSystemPower(std::ptr::null_mut(), &mut port, power, &mut notifier);
            if root == 0 || port.is_null() {
                log::warn!("recovery: macOS wake notifications unavailable");
                return;
            }
            ROOT.store(root, Ordering::Release);
            let source = IONotificationPortGetRunLoopSource(port);
            if source.is_null() {
                return;
            }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
            CFRunLoopRun();
            // Loop and registrations have process lifetime, matching native network events.
        });
}
