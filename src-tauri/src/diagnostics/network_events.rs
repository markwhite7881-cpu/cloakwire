//! Process-wide read-only OS notifications. Callbacks only bump an atomic epoch.
//! A single subscription lives until process exit; there is no per-session leak.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    OnceLock,
};
static STARTED: OnceLock<()> = OnceLock::new();
static READY: AtomicBool = AtomicBool::new(false);
static EPOCH: AtomicU64 = AtomicU64::new(1);
static WAKE_EPOCH: AtomicU64 = AtomicU64::new(1);
pub(crate) fn wake_generation() -> u64 {
    WAKE_EPOCH.load(Ordering::SeqCst)
}
pub(crate) fn wake() {
    WAKE_EPOCH.fetch_add(1, Ordering::SeqCst);
    changed();
}
fn changed() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
}
pub fn generation() -> Option<u64> {
    STARTED.get_or_init(|| {
        start();
        crate::recovery::subscribe_wake();
    });
    READY
        .load(Ordering::SeqCst)
        .then(|| EPOCH.load(Ordering::SeqCst))
}

#[cfg(windows)]
fn start() {
    use windows_sys::Win32::{
        Foundation::HANDLE, NetworkManagement::IpHelper::*, Networking::WinSock::AF_UNSPEC,
    };
    unsafe extern "system" fn interface(
        _: *const std::ffi::c_void,
        _: *const MIB_IPINTERFACE_ROW,
        _: MIB_NOTIFICATION_TYPE,
    ) {
        changed();
    }
    unsafe extern "system" fn route(
        _: *const std::ffi::c_void,
        _: *const MIB_IPFORWARD_ROW2,
        _: MIB_NOTIFICATION_TYPE,
    ) {
        changed();
    }
    unsafe extern "system" fn address(
        _: *const std::ffi::c_void,
        _: *const MIB_UNICASTIPADDRESS_ROW,
        _: MIB_NOTIFICATION_TYPE,
    ) {
        changed();
    }
    let mut handles: [HANDLE; 3] = [std::ptr::null_mut(); 3];
    // No caller context or row pointer is retained. OS owns callback row memory.
    let ok = unsafe {
        NotifyIpInterfaceChange(
            AF_UNSPEC,
            Some(interface),
            std::ptr::null(),
            0,
            &mut handles[0],
        ) == 0
            && NotifyRouteChange2(AF_UNSPEC, Some(route), std::ptr::null(), 0, &mut handles[1]) == 0
            && NotifyUnicastIpAddressChange(
                AF_UNSPEC,
                Some(address),
                std::ptr::null(),
                0,
                &mut handles[2],
            ) == 0
    };
    if !ok {
        for handle in handles {
            if !handle.is_null() {
                unsafe {
                    CancelMibChangeNotify2(handle);
                }
            }
        }
    }
    // Successful registrations intentionally have process lifetime; Windows
    // deregisters them on exit. No callback accesses destructible Rust state.
    READY.store(ok, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn start() {
    use core_foundation::{
        array::CFArray,
        runloop::{kCFRunLoopDefaultMode, CFRunLoop},
        string::CFString,
    };
    use system_configuration::dynamic_store::{
        SCDynamicStoreBuilder, SCDynamicStoreCallBackContext,
    };
    let _ = std::thread::Builder::new()
        .name("network-events".into())
        .spawn(|| {
            let context = SCDynamicStoreCallBackContext {
                callout: |_, _, _: &mut ()| changed(),
                info: (),
            };
            let Some(store) = SCDynamicStoreBuilder::new("CloakWire network health")
                .callback_context(context)
                .build()
            else {
                return;
            };
            let keys = CFArray::from_CFTypes(&[
                CFString::new("State:/Network/Global/IPv4"),
                CFString::new("State:/Network/Global/IPv6"),
                CFString::new("State:/Network/Global/DNS"),
            ]);
            let patterns = CFArray::from_CFTypes(&[CFString::new("State:/Network/Interface/.*")]);
            if !store.set_notification_keys(&keys, &patterns) {
                return;
            }
            let Some(source) = store.create_run_loop_source() else {
                return;
            };
            let run_loop = CFRunLoop::get_current();
            unsafe {
                run_loop.add_source(&source, kCFRunLoopDefaultMode);
            }
            READY.store(true, Ordering::SeqCst);
            CFRunLoop::run_current();
            READY.store(false, Ordering::SeqCst);
            changed();
            drop(source);
            drop(store);
        });
}
#[cfg(not(any(windows, target_os = "macos")))]
fn start() {}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "registers read-only native network notifications"]
    fn native_subscription_initializes_once() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if let Some(first) = super::generation() {
                assert!(first > 0);
                assert!(super::generation().is_some());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "OS notification subscription failed"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
}

/// Positive PID ownership prevents an unrelated authenticated proxy from
/// masquerading as the new core's optional listener during startup.
#[cfg(windows)]
pub async fn owns_listener(pid: u32, port: u16) -> bool {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        },
        Networking::WinSock::AF_INET,
    };
    if pid == 0 || port == 0 {
        return false;
    }
    let mut size = 0u32;
    unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    if !(4..=1024 * 1024).contains(&size) {
        return false;
    }
    let mut bytes = vec![0u8; size as usize];
    let result = unsafe {
        GetExtendedTcpTable(
            bytes.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 0 || size as usize > bytes.len() || size < 4 {
        return false;
    }
    let count = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
    let stride = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    if count > (size as usize - 4) / stride {
        return false;
    }
    for index in 0..count {
        // The byte buffer is not assumed aligned. Each row was bounds checked.
        let row = unsafe {
            std::ptr::read_unaligned(
                bytes
                    .as_ptr()
                    .add(4 + index * stride)
                    .cast::<MIB_TCPROW_OWNER_PID>(),
            )
        };
        if row.dwOwningPid == pid
            && row.dwLocalAddr == u32::from_ne_bytes([127, 0, 0, 1])
            && u16::from_be(row.dwLocalPort as u16) == port
        {
            return true;
        }
    }
    false
}
#[cfg(target_os = "macos")]
pub async fn owns_listener(pid: u32, port: u16) -> bool {
    if pid == 0 || port == 0 {
        return false;
    }
    let mut command = tokio::process::Command::new("/usr/sbin/lsof");
    command
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            "-i",
            &format!("TCP@127.0.0.1:{port}"),
            "-sTCP:LISTEN",
            "-Fn",
        ])
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    let Ok(Ok(output)) =
        tokio::time::timeout(std::time::Duration::from_millis(500), command.output()).await
    else {
        return false;
    };
    output.status.success()
        && output.stdout.len() < 65536
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == format!("n127.0.0.1:{port}"))
}
#[cfg(not(any(windows, target_os = "macos")))]
pub async fn owns_listener(_: u32, _: u16) -> bool {
    false
}
