//! Intent ownership is independent of profile/catalog revisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Token {
    pub epoch: u64,
    pub network: u64,
    pub run: u64,
    pub wake: u64,
}
pub struct Intent<T> {
    pub epoch: u64,
    pub network: u64,
    pub wake: u64,
    pub enabled: bool,
    pub pending_manual: usize,
    pub accepted: Option<(u64, T)>,
}
impl<T> Default for Intent<T> {
    fn default() -> Self {
        Self {
            epoch: 0,
            network: 0,
            wake: 0,
            enabled: false,
            pending_manual: 0,
            accepted: None,
        }
    }
}
impl<T> Intent<T> {
    pub fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
    }
    pub fn stop(&mut self) {
        self.invalidate();
        self.accepted = None;
    }
    pub fn capture(&mut self, run: u64, snapshot: T) {
        self.accepted = Some((run, snapshot));
    }
    pub fn token(&self) -> Option<Token> {
        if !self.enabled || self.pending_manual != 0 {
            return None;
        }
        self.accepted.as_ref().map(|(run, _)| Token {
            epoch: self.epoch,
            network: self.network,
            run: *run,
            wake: self.wake,
        })
    }
    pub fn current(&self, token: Token) -> bool {
        self.token() == Some(token)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> Intent<String> {
        let mut i = Intent::default();
        i.enabled = true;
        i.capture(1, "accepted server A".into());
        i
    }
    #[test]
    fn stale_wake_cannot_restart_new_profile() {
        let mut i = live();
        let old = i.token().unwrap();
        i.invalidate();
        i.capture(2, "new B".into());
        assert!(!i.current(old));
        assert!(i.current(i.token().unwrap()));
    }
    #[test]
    fn stop_during_backoff_has_no_spawn() {
        let mut i = live();
        let old = i.token().unwrap();
        i.stop();
        assert!(!i.current(old));
        assert!(i.token().is_none());
    }
    #[test]
    fn rejected_manual_candidate_preserves_snapshot_but_cancels_work() {
        let mut i = live();
        let old = i.token().unwrap();
        i.invalidate();
        assert!(!i.current(old));
        assert_eq!(i.accepted.as_ref().unwrap().1, "accepted server A");
    }
    #[test]
    fn recovery_uses_accepted_snapshot_not_unsaved_ui_settings() {
        let i = live();
        let mut ui = String::from("accepted server A");
        ui.replace_range(.., "foreign server B");
        assert_ne!(i.accepted.as_ref().unwrap().1, ui);
    }
    #[test]
    fn disabled_captures_snapshot_for_later_enabling() {
        let mut i = Intent::default();
        i.capture(5, "same settings");
        assert!(i.token().is_none());
        i.enabled = true;
        assert_eq!(i.token().unwrap().run, 5);
    }
    #[test]
    fn changed_network_invalidates_inflight_evidence() {
        let mut i = live();
        let old = i.token().unwrap();
        i.network += 1;
        assert!(!i.current(old));
    }
    #[test]
    fn new_manual_request_blocks_background_lifecycle() {
        let mut i = live();
        let old = i.token().unwrap();
        i.pending_manual += 1;
        assert!(!i.current(old));
        assert!(i.token().is_none());
    }
    #[test]
    fn disabling_invalidates_all_pending_work() {
        let mut i = live();
        let old = i.token().unwrap();
        i.enabled = false;
        i.invalidate();
        i.enabled = true;
        assert!(!i.current(old));
    }
}
