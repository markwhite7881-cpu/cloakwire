//! Bounded, clock-driven recovery; no process, network, or UI side effects.
pub const DEBOUNCE_MS: u64 = 2_000;
pub const RETRY_MS: [u64; 3] = [2_000, 5_000, 15_000];
pub const STABLE_MS: u64 = 60_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    Healthy,
    DeadEngine,
    ActiveFailure,
    CandidateHealthy,
    Unavailable,
    Authentication,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Wait,
    ProbeActive,
    ProbeCandidate,
    Reconnect,
    GiveUp,
    Cancel,
}
#[derive(Default, Debug)]
pub struct Policy {
    pub enabled: bool,
    pub attempts: usize,
    due: Option<u64>,
    failures: u8,
    network: Option<String>,
    healthy_since: Option<u64>,
    exhausted: bool,
    retry_floor: Option<u64>,
    in_flight: bool,
}
impl Policy {
    pub fn is_exhausted(&self) -> bool {
        self.exhausted
    }
    /// All launches, including successful spawns, retain the next backoff floor.
    pub fn abandon_unstarted(&mut self) {
        if self.in_flight {
            self.attempts = self.attempts.saturating_sub(1);
            self.in_flight = false;
        }
        self.due = None;
    }
    pub fn attempt_finished(&mut self, now: u64) {
        if !self.in_flight {
            return;
        }
        self.in_flight = false;
        self.retry_floor = RETRY_MS
            .get(self.attempts)
            .map(|delay| now.saturating_add(*delay));
    }
    pub fn event(&mut self, now: u64, network: &str) {
        if !self.enabled || self.exhausted {
            return;
        }
        if self.network.as_deref() != Some(network) {
            self.network = Some(network.into());
            self.failures = 0;
        }
        self.healthy_since = None;
        if self.in_flight {
            return;
        }
        let debounce = now.saturating_add(DEBOUNCE_MS);
        let floor = *self.retry_floor.get_or_insert(debounce);
        self.due = Some(debounce.max(floor));
    }
    pub fn cancel(&mut self) {
        self.due = None;
        self.failures = 0;
        self.healthy_since = None;
    }
    pub fn next(&mut self, now: u64) -> Decision {
        if !self.enabled {
            return Decision::Cancel;
        }
        if self.exhausted {
            return Decision::GiveUp;
        }
        let Some(due) = self.due else {
            return Decision::Cancel;
        };
        if now < due {
            return Decision::Wait;
        }
        self.due = None;
        Decision::ProbeActive
    }
    pub fn observe(&mut self, now: u64, evidence: Evidence) -> Decision {
        if !self.enabled {
            return Decision::Cancel;
        }
        if evidence == Evidence::Healthy {
            self.due = None;
            self.in_flight = false;
            self.failures = 0;
            let since = *self.healthy_since.get_or_insert(now);
            if now.saturating_sub(since) >= STABLE_MS {
                self.attempts = 0;
                self.exhausted = false;
                self.retry_floor = None;
            }
            return Decision::Wait;
        }
        self.healthy_since = None;
        if self.exhausted {
            return Decision::GiveUp;
        }
        match evidence {
            Evidence::Authentication => {
                self.exhausted = true;
                self.cancel();
                Decision::GiveUp
            }
            Evidence::Unavailable => {
                self.failures = 0;
                Decision::Wait
            }
            Evidence::ActiveFailure => {
                self.failures = self.failures.saturating_add(1);
                if self.failures >= 2 {
                    Decision::ProbeCandidate
                } else {
                    Decision::ProbeActive
                }
            }
            Evidence::DeadEngine | Evidence::CandidateHealthy
                if evidence == Evidence::DeadEngine || self.failures >= 2 =>
            {
                if self.attempts >= RETRY_MS.len() {
                    self.exhausted = true;
                    self.cancel();
                    return Decision::GiveUp;
                }
                if self.in_flight {
                    return Decision::Wait;
                }
                let floor = *self
                    .retry_floor
                    .get_or_insert(now.saturating_add(RETRY_MS[0]));
                if now < floor {
                    self.due = Some(floor);
                    return Decision::Wait;
                }
                self.due = None;
                self.attempts += 1;
                self.in_flight = true;
                Decision::Reconnect
            }
            _ => Decision::Wait,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn enabled() -> Policy {
        Policy {
            enabled: true,
            ..Policy::default()
        }
    }
    #[test]
    fn disabled_preserves_current_behavior() {
        let mut p = Policy::default();
        p.event(0, "a");
        assert_eq!(p.next(3000), Decision::Cancel);
    }
    #[test]
    fn manual_stop_cancels_all() {
        let mut p = enabled();
        p.event(0, "a");
        p.cancel();
        assert_eq!(p.next(3000), Decision::Cancel);
    }
    #[test]
    fn burst_events_coalesce() {
        let mut p = enabled();
        p.event(0, "a");
        p.event(1000, "a");
        assert_eq!(p.next(2999), Decision::Wait);
        assert_eq!(p.next(3000), Decision::ProbeActive);
        assert_eq!(p.next(3001), Decision::Cancel);
    }
    #[test]
    fn healthy_active_session_no_restart() {
        let mut p = enabled();
        assert_eq!(p.observe(0, Evidence::Healthy), Decision::Wait);
        assert_eq!(p.attempts, 0);
    }
    #[test]
    fn candidate_probe_success_does_not_mark_active_session_recovered() {
        let mut p = enabled();
        assert_eq!(p.observe(0, Evidence::CandidateHealthy), Decision::Wait);
        assert_eq!(p.healthy_since, None);
    }
    #[test]
    fn restart_requires_two_current_network_failures_and_candidate() {
        let mut p = enabled();
        p.event(0, "a");
        assert_eq!(
            p.observe(2000, Evidence::ActiveFailure),
            Decision::ProbeActive
        );
        assert_eq!(
            p.observe(2100, Evidence::ActiveFailure),
            Decision::ProbeCandidate
        );
        p.event(2200, "b");
        assert_eq!(p.observe(2300, Evidence::CandidateHealthy), Decision::Wait);
    }
    #[test]
    fn unavailable_physical_network_never_restarts() {
        let mut p = enabled();
        p.event(0, "a");
        assert_eq!(p.observe(2000, Evidence::Unavailable), Decision::Wait);
        assert_eq!(p.attempts, 0);
    }
    #[test]
    fn authentication_failure_does_not_retry() {
        let mut p = enabled();
        assert_eq!(p.observe(0, Evidence::Authentication), Decision::GiveUp);
        p.event(100, "b");
        assert_eq!(p.next(3000), Decision::GiveUp);
    }
    #[test]
    fn new_network_does_not_reset_retry_budget() {
        let mut p = enabled();
        p.event(0, "a");
        p.next(2000);
        assert_eq!(p.observe(2000, Evidence::DeadEngine), Decision::Reconnect);
        p.attempt_finished(3000);
        p.event(3100, "b");
        assert_eq!(p.next(7999), Decision::Wait);
        p.next(8000);
        assert_eq!(p.observe(8000, Evidence::DeadEngine), Decision::Reconnect);
        p.attempt_finished(9000);
        p.event(9100, "c");
        assert_eq!(p.next(23999), Decision::Wait);
        p.next(24000);
        assert_eq!(p.observe(24000, Evidence::DeadEngine), Decision::Reconnect);
        p.attempt_finished(25000);
        p.event(26000, "d");
        assert_eq!(p.observe(28000, Evidence::DeadEngine), Decision::GiveUp);
        assert_eq!(p.attempts, 3);
    }

    #[test]
    fn budget_resets_only_after_confirmed_stable_health() {
        let mut p = enabled();
        p.observe(0, Evidence::DeadEngine);
        p.next(2000);
        assert_eq!(p.observe(2000, Evidence::DeadEngine), Decision::Reconnect);
        p.attempt_finished(2100);
        p.observe(3000, Evidence::Healthy);
        p.observe(62999, Evidence::Healthy);
        assert_eq!(p.attempts, 1);
        p.observe(63000, Evidence::Healthy);
        assert_eq!(p.attempts, 0);
    }
    #[test]
    fn events_cannot_override_retry_backoff() {
        let mut p = enabled();
        p.event(0, "a");
        p.next(2000);
        p.observe(2000, Evidence::DeadEngine);
        p.attempt_finished(3000);
        p.event(3100, "b");
        p.event(3900, "c");
        assert_eq!(p.next(7999), Decision::Wait);
        assert_eq!(p.next(8000), Decision::ProbeActive);
        assert_eq!(p.observe(8000, Evidence::DeadEngine), Decision::Reconnect);
    }
}

#[cfg(test)]
mod completion_backoff_tests {
    use super::*;
    #[test]
    fn first_debounce_satisfies_first_retry_floor() {
        let mut p = Policy::default();
        p.enabled = true;
        p.event(0, "a");
        assert_eq!(p.next(2000), Decision::ProbeActive);
        assert_eq!(p.observe(2000, Evidence::DeadEngine), Decision::Reconnect);
    }
    #[test]
    fn successful_spawn_still_observes_completion_backoff() {
        let mut p = Policy::default();
        p.enabled = true;
        p.observe(0, Evidence::DeadEngine);
        p.next(2000);
        p.observe(2000, Evidence::DeadEngine);
        p.attempt_finished(3000);
        p.event(3100, "new-network");
        assert_eq!(p.next(5100), Decision::Wait);
    }
}

#[cfg(test)]
mod cancelled_completion_tests {
    use super::*;
    #[test]
    fn invalidation_preserves_started_attempt_completion_floor() {
        let mut p = Policy::default();
        p.enabled = true;
        p.event(0, "a");
        p.next(2000);
        assert_eq!(p.observe(2000, Evidence::DeadEngine), Decision::Reconnect);
        p.cancel();
        p.attempt_finished(3000);
        p.event(3100, "b");
        assert_eq!(p.next(7999), Decision::Wait);
        assert_eq!(p.attempts, 1);
    }
}
