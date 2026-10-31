package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test
class RecoveryPolicyTest {
 private fun policy()=RecoveryPolicy(true).apply { accept("accepted",0);network("wifi",0) }
 @Test fun disabled_preserves_current_behavior() {
  val p=RecoveryPolicy(false);p.accept("a",0);p.network("wifi",0);p.engineDied(0)
  assertEquals(RecoveryDecision.Cancel,p.next(2000))
 }
 @Test fun manual_stop_cancels_all_and_wake_cannot_connect() {
  val p=policy();p.engineDied(0);p.stop();p.network("mobile",5000)
  assertEquals(RecoveryDecision.Cancel,p.next(99999))
 }
 @Test fun burst_events_coalesce_and_wait_for_physical_network() {
  val p=policy();p.network("wifi",100);p.network("wifi",1900)
  assertEquals(RecoveryDecision.Wait,p.next(1999));assertEquals(RecoveryDecision.ProbeActive,p.next(2000))
  p.network(null,2001);p.engineDied(2001);assertEquals(RecoveryDecision.Wait,p.next(30000))
 }
 @Test fun new_network_never_resets_shared_retry_budget() {
  val p=policy();p.engineDied(0);assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(2000))
  p.restartFinished(false,2000);p.network("mobile",2001)
  assertEquals(RecoveryDecision.Wait,p.next(6999));assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(7000))
  p.restartFinished(false,7000);p.network("ethernet",7001)
  assertEquals(RecoveryDecision.Wait,p.next(21999));assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(22000))
  p.restartFinished(false,22000);assertTrue(p.next(99999) is RecoveryDecision.GiveUp)
 }
 @Test fun two_active_failures_and_candidate_success_allow_restart_but_do_not_mark_healthy() {
  val p=policy();assertEquals(RecoveryDecision.ProbeActive,p.next(2000))
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,2000);assertEquals(RecoveryDecision.ProbeActive,p.next(4000))
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,4000);assertEquals(RecoveryDecision.ProbeCandidate,p.next(4000))
  p.candidateFinished(HealthOutcome.HEALTHY,null,4000);assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(4000));assertNull(p.healthySince)
 }
 @Test fun network_change_discards_old_active_failures() {
  val p=policy();p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,2000);p.network("mobile",2001)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,4001);assertEquals(RecoveryDecision.ProbeActive,p.next(6001))
 }
 @Test fun authentication_failure_is_terminal_and_unavailable_is_not_restart_permission() {
  val p=policy();p.activeFinished(HealthOutcome.FAILED,HealthIssue.AUTHENTICATION,2000)
  assertEquals(RecoveryDecision.GiveUp(HealthIssue.AUTHENTICATION),p.next(30000))
  val q=policy();q.activeFinished(HealthOutcome.UNAVAILABLE,HealthIssue.UNSUPPORTED_PROBE,2000);assertEquals(RecoveryDecision.Wait,q.next(30000))
 }
 @Test fun network_or_wake_after_healthy_check_runs_after_debounce_not_stable_timer() {
  val p=policy();p.activeFinished(HealthOutcome.HEALTHY,null,2000);p.network("mobile",3000)
  assertEquals(RecoveryDecision.Wait,p.next(4999));assertEquals(RecoveryDecision.ProbeActive,p.next(5000))
  val q=policy();q.activeFinished(HealthOutcome.HEALTHY,null,2000);q.wake(3000)
  assertEquals(RecoveryDecision.ProbeActive,q.next(5000))
 }
 @Test fun owned_dead_engine_detected_during_probe_keeps_restart_permission() {
  val p=policy();p.engineDied(2000);p.activeFinished(HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE,2000)
  assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(4000))
 }
 @Test fun successful_launch_with_failed_active_path_keeps_five_and_fifteen_second_backoff() {
  val p=policy();p.engineDied(0);p.next(2000);p.restartFinished(true,2000)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,4000)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,6000)
  p.candidateFinished(HealthOutcome.HEALTHY,null,6000)
  p.network("mobile",6001)
  assertEquals(RecoveryDecision.Wait,p.next(6999))
  // Network replacement discards the old active failures/candidate, so require evidence again.
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,6002)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,6003)
  p.candidateFinished(HealthOutcome.HEALTHY,null,6003)
  assertEquals(RecoveryDecision.Wait,p.next(6999));assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(7000))
  p.restartFinished(true,7000)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,9000)
  p.activeFinished(HealthOutcome.FAILED,HealthIssue.TIMEOUT,11000)
  p.candidateFinished(HealthOutcome.HEALTHY,null,11000)
  assertEquals(RecoveryDecision.Wait,p.next(21999));assertEquals(RecoveryDecision.Reconnect("accepted"),p.next(22000))
 }
 @Test fun only_confirmed_stability_resets_budget() {
  val p=policy();p.engineDied(0);p.next(2000);p.restartFinished(true,2000);p.activeFinished(HealthOutcome.HEALTHY,null,4000)
  assertEquals(RecoveryDecision.Wait,p.next(63999));assertEquals(1,p.attempts)
  assertEquals(RecoveryDecision.ProbeActive,p.next(64000));p.activeFinished(HealthOutcome.HEALTHY,null,64000);assertEquals(0,p.attempts)
 }
}
