package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test
class RecoveryCoordinatorTest {
 private fun snapshot(id:String="a")=RecoverySnapshot(id,"config-$id","[]","exclude","xray","on_drop",true,"server-$id",null,"run-$id")
 @Test fun old_engine_death_thread_cannot_restart_new_session() {
  val c=RecoveryCoordinator(true);val old=c.accept(snapshot(),0);c.network("wifi",false,0);c.engineDied(old,0)
  val job=c.next(2000)!!;val newer=c.accept(snapshot("b"),2001)
  assertFalse(c.isCurrent(job));assertFalse(c.engineDied(old,2002));assertTrue(c.engineDied(newer,2002))
 }
 @Test fun stop_and_disable_release_pending_work_before_deferred_io() {
  for(disable in listOf(false,true)) {
   val c=RecoveryCoordinator(true);val epoch=c.accept(snapshot(),0);c.network("wifi",false,0);c.engineDied(epoch,0)
   val job=c.next(2000)!!;if(disable)c.setEnabled(false,2001) else c.cancel()
   assertFalse(c.isCurrent(job));assertNull(c.next(99999));assertFalse(c.completeRestart(job,true,2002))
  }
 }
 @Test fun recovery_uses_accepted_snapshot_and_does_not_switch_server() {
  val c=RecoveryCoordinator(false);val original=snapshot();c.accept(original,0)
  assertEquals("config-a",c.snapshot()?.config);c.setEnabled(true,1);c.network("wifi",false,1);c.engineDied(c.epoch(),1)
  val job=c.next(2001)!!;assertSame(original,job.snapshot);assertEquals("server-a",job.snapshot.name)
 }
 @Test fun vpn_network_ignored_and_physical_identity_replaced() {
  val c=RecoveryCoordinator(true);c.accept(snapshot(),0)
  assertFalse(c.network("vpn",true,0));assertNull(c.next(2000))
  c.network("wifi-1",false,0);val job=c.next(2000)!!
  c.network("wifi-2",false,2001);assertFalse(c.isCurrent(job));assertFalse(c.completeActive(job,HealthOutcome.HEALTHY,null,2002))
  assertEquals("wifi-2",c.next(4001)!!.network)
 }
 @Test fun one_inflight_transition_and_duplicate_toggle_do_not_cancel_it() {
  val c=RecoveryCoordinator(true);c.accept(snapshot(),0);c.network("wifi",false,0)
  val job=c.next(2000)!!;assertNull(c.next(2000));c.setEnabled(true,2001);assertTrue(c.isCurrent(job))
 }
 @Test fun third_restart_failure_is_exhausted_without_needing_another_callback() {
  val c=RecoveryCoordinator(true);val epoch=c.accept(snapshot(),0);c.network("wifi",false,0);c.engineDied(epoch,0)
  var work=c.next(2000)!!;c.completeRestart(work,false,2000)
  work=c.next(7000)!!;c.completeRestart(work,false,7000)
  work=c.next(22000)!!;c.completeRestart(work,false,22000)
  assertEquals("exhausted",c.status().phase);assertEquals("retry_exhausted",c.status().issue)
 }
 @Test fun rejected_manual_preparation_retains_old_accepted_recovery_without_allowing_a_race() {
  val c=RecoveryCoordinator(true);val snapshot=snapshot();val epoch=c.accept(snapshot,0);c.network("wifi",false,0);c.engineDied(epoch,0)
  val old=c.next(2000)!!;c.pausePreparation(10)
  assertSame(snapshot,c.snapshot());assertFalse(c.isCurrent(old));assertNull(c.next(100000))
  assertTrue(c.resumePreparation(10,2001));assertNull(c.next(99999))
  assertFalse(c.completeRestart(old,false,2002));assertNull(c.next(7001));assertNotNull(c.next(7002))
 }
 @Test fun stop_or_new_preparation_cannot_be_undone_by_old_rejection() {
  val c=RecoveryCoordinator(true);c.accept(snapshot(),0);c.network("wifi",false,0);c.pausePreparation(10);c.pausePreparation(11)
  assertFalse(c.resumePreparation(10,2000));assertNull(c.next(10000))
  c.cancel();assertFalse(c.resumePreparation(11,3000));assertNull(c.next(100000));assertNull(c.snapshot())
 }
 @Test fun disabled_legacy_restart_permission_is_revoked_by_stop_preparation_or_enable() {
  val c=RecoveryCoordinator(false);val snapshot=snapshot();c.accept(snapshot,0)
  assertTrue(c.legacyAllowed(snapshot));c.pausePreparation(10);assertFalse(c.legacyAllowed(snapshot))
  c.resumePreparation(10,1);assertTrue(c.legacyAllowed(snapshot));c.setEnabled(true,2);assertFalse(c.legacyAllowed(snapshot))
  c.setEnabled(false,3);c.cancel();assertFalse(c.legacyAllowed(snapshot))
 }
 @Test fun network_change_during_an_attempt_does_not_remove_backoff_or_publish_old_completion() {
  val c=RecoveryCoordinator(true);val epoch=c.accept(snapshot(),0);c.network("wifi",false,0);c.engineDied(epoch,0)
  val work=c.next(2000)!!;c.network("mobile",false,2001)
  assertNull(c.next(100000))
  assertFalse(c.completeRestart(work,true,2200));assertNull(c.next(7199));assertNotNull(c.next(7200))
 }
 @Test fun wake_rejects_late_candidate_and_requires_fresh_active_evidence() {
  val c=RecoveryCoordinator(true);c.accept(snapshot(),0);c.network("wifi",false,0)
  var work=c.next(2000)!!;c.completeActive(work,HealthOutcome.FAILED,HealthIssue.TIMEOUT,2000)
  work=c.next(4000)!!;c.completeActive(work,HealthOutcome.FAILED,HealthIssue.TIMEOUT,4000)
  work=c.next(4000)!!;assertEquals(RecoveryDecision.ProbeCandidate,work.decision)
  c.wake(5000);assertFalse(c.completeCandidate(work,HealthOutcome.HEALTHY,null,6000))
  assertEquals(RecoveryDecision.ProbeActive,c.next(7000)!!.decision)
 }
 @Test fun optional_listener_fallback_cannot_recapture_stop_or_new_preparation() {
  for(stop in listOf(false,true)) {
   val c=RecoveryCoordinator(true);val original=snapshot();c.accept(original,0)
   val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
   var published=false;var replaced=true
   val worker=Thread {entered.countDown();release.await();replaced=c.replaceAccepted(original,original.copy(config="fallback")){published=true}}
   worker.start();assertTrue(entered.await(1,java.util.concurrent.TimeUnit.SECONDS))
   if(stop)c.cancel() else c.pausePreparation(10)
   release.countDown();worker.join(1000)
   assertFalse(worker.isAlive);assertFalse(replaced);assertFalse(published)
   if(stop)assertNull(c.snapshot()) else assertSame(original,c.snapshot())
  }
 }
 @Test fun initial_group_snapshot_is_not_a_change_but_later_selected_member_is() {
  val groups=RecoveryGroupState()
  assertFalse(groups.update(mapOf("proxy" to "one")))
  assertFalse(groups.update(mapOf("proxy" to "one")))
  assertTrue(groups.update(mapOf("proxy" to "two")))
  assertEquals(2,groups.revision())
 }
 @Test fun cancelled_replacement_after_opt_out_requires_manual_attention_only_for_same_owned_dead_core() {
  val c=RecoveryCoordinator(true);val original=snapshot();val epoch=c.accept(original,0);c.network("wifi",false,0);c.engineDied(epoch,0)
  val work=c.next(2000)!!;c.setEnabled(false,2001);c.completeRestart(work,false,2002)
  assertTrue(c.cancelledReplacementNeedsAttention(work,false));assertFalse(c.cancelledReplacementNeedsAttention(work,true))
  c.pausePreparation(10);assertFalse(c.cancelledReplacementNeedsAttention(work,false))
  c.cancel();assertFalse(c.cancelledReplacementNeedsAttention(work,false))
 }
 @Test fun stopped_service_not_restarted_by_callback() {
  val c=RecoveryCoordinator(true);c.accept(snapshot(),0);c.cancel();c.network("wifi",false,0)
  assertNull(c.next(99999));assertNull(c.snapshot())
 }
}
