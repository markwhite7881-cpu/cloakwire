//! Raw TUN/DNS notifications do not constitute a physical-path change.
pub struct PhysicalEvents<T> {
    path: Option<Option<T>>,
    wake: u64,
}
impl<T> Default for PhysicalEvents<T> {
    fn default() -> Self {
        Self {
            path: None,
            wake: 0,
        }
    }
}
impl<T: Eq> PhysicalEvents<T> {
    pub fn seen(&self) -> bool {
        self.path.is_some()
    }
    pub fn observe(&mut self, path: Option<T>, wake: u64) -> bool {
        let changed = self.path.as_ref() != Some(&path) || self.wake != wake;
        self.path = Some(path);
        self.wake = wake;
        changed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_tun_and_dns_callbacks_do_not_schedule_recovery() {
        let mut f = PhysicalEvents::default();
        assert!(f.observe(Some("Ethernet"), 1));
        assert!(!f.observe(Some("Ethernet"), 1));
    }
    #[test]
    fn changed_path_loss_return_and_wake_are_not_lost() {
        let mut f = PhysicalEvents::default();
        assert!(f.observe(Some("Ethernet"), 1));
        assert!(f.observe(Some("Wi-Fi"), 1));
        assert!(f.observe(None, 1));
        assert!(f.observe(Some("Wi-Fi"), 1));
        assert!(f.observe(Some("Wi-Fi"), 2));
        assert!(!f.observe(Some("Wi-Fi"), 2));
    }
}
