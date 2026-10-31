package app.cloakwire.client.vpn

internal sealed class RecoveryDecision {
 object Wait:RecoveryDecision();object Cancel:RecoveryDecision()
 object ProbeActive:RecoveryDecision();object ProbeCandidate:RecoveryDecision()
 data class Reconnect(val snapshotId:String):RecoveryDecision()
 data class GiveUp(val issue:HealthIssue):RecoveryDecision()
}
/** Pure elapsed-clock policy. Network callbacks never replenish a failed session's budget. */
internal class RecoveryPolicy(var enabled:Boolean) {
 companion object { const val DEBOUNCE_MS=2000L; const val STABLE_MS=60000L; private val DELAYS=longArrayOf(2000,5000,15000) }
 var attempts=0;private set
 var healthySince:Long?=null;private set
 var dueAt:Long?=null;private set
 var issue:HealthIssue?=null;private set
 private var accepted:String?=null
 private var physical:String?=null
 private var dead=false
 private var reconnectNotBefore=0L
 var effective:String?=null;private set
 private var failures=0
 private var candidate=false
 var exhausted=false;private set
 fun accept(snapshot:String,now:Long) {
  accepted=snapshot;attempts=0;healthySince=null;issue=null;dead=false;effective=null;failures=0;candidate=false;exhausted=false
  reconnectNotBefore=now+DEBOUNCE_MS
  dueAt=now+DEBOUNCE_MS
 }
 fun network(network:String?,now:Long) {
  val changed=network!=physical
  if(changed) { physical=network;effective=null;failures=0;candidate=false;healthySince=null }
  if(accepted!=null && issue!=HealthIssue.AUTHENTICATION && !exhausted) {
   issue=if(network==null)HealthIssue.NETWORK_UNAVAILABLE else null
   if(changed || dueAt==null)dueAt=if(dead && attempts>0)maxOf(dueAt?:0,now+DEBOUNCE_MS) else now+DEBOUNCE_MS
  }
 }
 fun wake(now:Long) {
  effective=null;failures=0;candidate=false;healthySince=null
  if(accepted!=null && !exhausted && issue!=HealthIssue.AUTHENTICATION)
   dueAt=if(dead && attempts>0)maxOf(dueAt?:0,now+DEBOUNCE_MS) else now+DEBOUNCE_MS
 }
 fun stop() { accepted=null;dueAt=null;healthySince=null }
 fun engineDied(now:Long) {
  if(accepted==null || exhausted || issue==HealthIssue.AUTHENTICATION)return
  val wasDead=dead;dead=true;healthySince=null
  if(!wasDead || dueAt==null)dueAt=now+DELAYS[attempts.coerceAtMost(2)]
 }
 fun activeFinished(outcome:HealthOutcome,problem:HealthIssue?,now:Long,proof:String?=null) {
  if(accepted==null)return
  if(proof!=effective){effective=proof;failures=0;candidate=false;healthySince=null}
  if(problem==HealthIssue.AUTHENTICATION) { issue=problem;dueAt=null;return }
  if(dead && outcome!=HealthOutcome.HEALTHY && problem==HealthIssue.ENGINE_UNAVAILABLE){dueAt=maxOf(dueAt?:0,now+DEBOUNCE_MS);return}
  when(outcome) {
   HealthOutcome.HEALTHY -> {
    dead=false;failures=0;candidate=false;issue=null
    val since=healthySince
    if(since!=null && now-since>=STABLE_MS){attempts=0;reconnectNotBefore=0}
    healthySince=since?:now;dueAt=now+STABLE_MS
   }
   HealthOutcome.FAILED -> { healthySince=null;failures++;issue=problem;dueAt=if(failures>=2)now else now+DEBOUNCE_MS }
   else -> { healthySince=null;issue=problem?:HealthIssue.UNSUPPORTED_PROBE;dueAt=null }
  }
 }
 fun candidateFinished(outcome:HealthOutcome,problem:HealthIssue?,now:Long) {
  if(accepted==null)return
  if(outcome==HealthOutcome.HEALTHY && failures>=2) { candidate=true;dueAt=maxOf(now,reconnectNotBefore);issue=null }
  else { candidate=false;dueAt=null;issue=problem?:HealthIssue.UNSUPPORTED_PROBE }
 }
 fun attemptCompleted(now:Long) {
  if(attempts in 1..2) {
   reconnectNotBefore=maxOf(reconnectNotBefore,now+DELAYS[attempts])
   if((dead || candidate) && dueAt!=null)dueAt=maxOf(dueAt!!,reconnectNotBefore)
  }
 }
 fun restartFinished(success:Boolean,now:Long) {
  candidate=false;failures=0;healthySince=null
  // The floor belongs to the attempt, including a launch whose active path remains unhealthy.
  reconnectNotBefore=if(attempts<3)now+DELAYS[attempts] else Long.MAX_VALUE
  if(success) { dead=false;issue=null;dueAt=now+DEBOUNCE_MS }
  else { dead=true;issue=HealthIssue.ENGINE_UNAVAILABLE;if(attempts>=3){exhausted=true;dueAt=null}else dueAt=now+DELAYS[attempts] }
 }
 fun next(now:Long):RecoveryDecision {
  val snapshot=accepted?:return RecoveryDecision.Cancel
  if(!enabled)return RecoveryDecision.Cancel
  if(issue==HealthIssue.AUTHENTICATION)return RecoveryDecision.GiveUp(HealthIssue.AUTHENTICATION)
  if(exhausted)return RecoveryDecision.GiveUp(HealthIssue.ENGINE_UNAVAILABLE)
  if(physical==null || dueAt==null || now<dueAt!!)return RecoveryDecision.Wait
  if(dead || candidate) {
   if(attempts>=3){exhausted=true;dueAt=null;return RecoveryDecision.GiveUp(HealthIssue.ENGINE_UNAVAILABLE)}
   if(now<reconnectNotBefore){dueAt=reconnectNotBefore;return RecoveryDecision.Wait}
   attempts++
   reconnectNotBefore=if(attempts<3)now+DELAYS[attempts] else Long.MAX_VALUE
   dueAt=null;return RecoveryDecision.Reconnect(snapshot)
  }
  return if(failures>=2)RecoveryDecision.ProbeCandidate else RecoveryDecision.ProbeActive
 }
}
