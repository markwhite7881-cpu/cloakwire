package app.cloakwire.client.vpn
import org.junit.Assert.*
import org.junit.Test

class ProbeStateTest {
 private val source=ProfileSource(ProfileRef.Manual("a"),"a".repeat(64))
 @Test fun cancellation_and_replacement_reject_late_success() {
  val state=ProbeState()
  val a=state.begin(source,"run",100)
  assertEquals(a.operationId,state.begin(source,"run",101).operationId)
  state.cancel(a.operationId)
  assertFalse(state.finish(a.operationId,HealthOutcome.HEALTHY,null,10,102))
  val b=state.begin(source.copy(revision="b".repeat(64)),"run",103)
  assertFalse(state.finish(a.operationId,HealthOutcome.HEALTHY,null,10,104))
  assertEquals(b.operationId,state.snapshot()!!.operationId)
 }
 @Test fun deadline_includes_preparation_and_a_new_run_invalidates_result() {
  val state=ProbeState();val a=state.begin(source,"run",100)
  assertFalse(state.finish(a.operationId,HealthOutcome.HEALTHY,null,10,12100))
  assertEquals(HealthIssue.TIMEOUT,state.snapshot()!!.issue)
  val b=state.begin(source,"run",13000)
  assertTrue(state.finish(b.operationId,HealthOutcome.HEALTHY,null,20,13020))
  state.invalidate()
  assertNull(state.snapshot())
 }
 @Test fun invalidating_completed_probe_removes_evidence_from_native_snapshot() {
  val state=ProbeState();val a=state.begin(source,"run",100)
  state.finish(a.operationId,HealthOutcome.HEALTHY,null,10,110)
  state.cancel(a.operationId)
  assertNull(state.snapshot())
 }
 @Test fun identity_retains_source_and_never_marks_active_session() {
  val state=ProbeState();val a=state.begin(source,"run",100)
  assertEquals(source.revision,a.identity.profileRevision)
  assertEquals(HealthScope.SELECTED_PROFILE,a.scope)
  assertNull(a.identity.runId)
  assertFalse(a.toJson().toString().contains("SECRET"))
 }
}
