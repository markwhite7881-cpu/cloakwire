package app.cloakwire.client.vpn

/** Values are captured at native acceptance, including when recovery is disabled. */
internal data class RecoverySnapshot(
 val id:String,val config:String,val apps:String,val appsMode:String,val engine:String,
 val killSwitch:String,val blockIpv6:Boolean,val name:String,val source:ProfileSource?,val runId:String,
 val runtime:RecoveryRuntimeConfig.Wired?=null,
)
internal data class RecoveryWork(val epoch:Long,val network:String?,val snapshot:RecoverySnapshot,val decision:RecoveryDecision,val effective:String?=null)
internal data class RecoveryStatus(val enabled:Boolean,val phase:String,val attempts:Int,val issue:String?,val runId:String?)

/** Owns only policy and tokens. No lifecycle lock is held while doing probes or core I/O. */
internal class RecoveryCoordinator(enabled:Boolean) {
 private val policy=RecoveryPolicy(enabled)
 private var accepted:RecoverySnapshot?=null
 private var owner=0L
 private var generation=0L
 private var physical:String?=null
 private var inflight:RecoveryWork?=null
 private var terminal=false
 private var preparation:Long?=null
 @Synchronized fun accept(snapshot:RecoverySnapshot,now:Long):Long {
  owner++;generation++;accepted=snapshot;inflight=null;terminal=false;preparation=null
  policy.accept(snapshot.id,now);policy.network(physical,now);return owner
 }
 @Synchronized fun acceptPreparation(request:Long,snapshot:RecoverySnapshot,now:Long,commit:()->Unit):Boolean {
  if(preparation!=request)return false
  commit()
  accept(snapshot,now)
  return true
 }
 @Synchronized fun replaceAccepted(expected:RecoverySnapshot,replacement:RecoverySnapshot,publish:()->Unit):Boolean {
  if(accepted!==expected || preparation!=null)return false
  accepted=replacement;generation++;publish();return true
 }
 @Synchronized fun cancelledReplacementNeedsAttention(work:RecoveryWork,engineAlive:Boolean):Boolean = accepted===work.snapshot && preparation==null && !policy.enabled && !engineAlive
 @Synchronized fun ownsAccepted(snapshot:RecoverySnapshot):Boolean=accepted===snapshot && preparation==null
 @Synchronized fun network(network:String?,vpn:Boolean,now:Long):Boolean {
  if(vpn || physical==network)return false
  physical=network;generation++;policy.network(network,now);return true
 }
 @Synchronized fun wake(now:Long) { generation++;policy.wake(now) }
 @Synchronized fun engineDied(epoch:Long,now:Long):Boolean {
  if(epoch!=owner || accepted==null)return false
  policy.engineDied(now);return true
 }
 @Synchronized fun next(now:Long):RecoveryWork? {
  if(inflight!=null || accepted==null || !policy.enabled || preparation!=null)return null
  val decision=policy.next(now)
  if(decision is RecoveryDecision.GiveUp) { terminal=true;return null }
  if(decision==RecoveryDecision.Wait || decision==RecoveryDecision.Cancel)return null
  return RecoveryWork(generation,physical,accepted!!,decision,policy.effective).also{inflight=it}
 }
 @Synchronized fun isCurrent(work:RecoveryWork):Boolean = preparation==null && policy.enabled && work.epoch==generation && accepted===work.snapshot && work.network==physical && inflight===work
 @Synchronized fun setEnabled(enabled:Boolean,now:Long):Boolean {
  if(enabled==policy.enabled)return false
  generation++;policy.enabled=enabled
  if(enabled)policy.wake(now)
  return true
 }
 @Synchronized fun invalidateWork() { generation++;inflight=null }
 @Synchronized fun cancel() { owner++;generation++;inflight=null;accepted=null;policy.stop();terminal=false;preparation=null }
 @Synchronized fun completeRestart(work:RecoveryWork,success:Boolean,now:Long):Boolean {
  val valid=isCurrent(work)
  if(inflight===work)inflight=null
  if(accepted===work.snapshot)policy.attemptCompleted(now)
  if(!valid)return false
  policy.restartFinished(success,now);terminal=policy.exhausted;return true
 }
 @Synchronized fun completeActive(work:RecoveryWork,outcome:HealthOutcome,issue:HealthIssue?,now:Long,effective:String?=null):Boolean {
  val valid=isCurrent(work);if(inflight===work)inflight=null
  if(!valid)return false
  policy.activeFinished(outcome,issue,now,effective);return true
 }
 @Synchronized fun completeCandidate(work:RecoveryWork,outcome:HealthOutcome,issue:HealthIssue?,now:Long):Boolean {
  val valid=isCurrent(work);if(inflight===work)inflight=null
  if(!valid)return false
  policy.candidateFinished(outcome,issue,now);return true
 }
 @Synchronized fun pausePreparation(request:Long) {
  if(preparation==request)return
  preparation=request;generation++
 }
 @Synchronized fun resumePreparation(request:Long,now:Long):Boolean {
  if(preparation!=request)return false
  preparation=null;generation++;policy.wake(now);return true
 }
 @Synchronized fun preparationCurrent(request:Long):Boolean=preparation==request
 @Synchronized fun releasePreparation(now:Long):Boolean=preparation?.let{resumePreparation(it,now)}?:false
 @Synchronized fun legacyAllowed(snapshot:RecoverySnapshot):Boolean=!policy.enabled && accepted===snapshot && preparation==null
 @Synchronized fun snapshot():RecoverySnapshot?=accepted
 @Synchronized fun epoch():Long=owner
 @Synchronized fun enabled():Boolean=policy.enabled
 @Synchronized fun delay(now:Long):Long? = if(!policy.enabled || accepted==null || inflight!=null || terminal || physical==null || preparation!=null)null else policy.dueAt?.let{(it-now).coerceAtLeast(0)}
 @Synchronized fun status():RecoveryStatus {
  val issue=when {
   terminal && policy.issue!=HealthIssue.AUTHENTICATION->"retry_exhausted"
   else->policy.issue?.name?.lowercase(java.util.Locale.ROOT)
  }
  val phase=when {
   !policy.enabled || accepted==null->"idle"
   preparation!=null->"idle"
   terminal->"exhausted"
   inflight?.decision is RecoveryDecision.Reconnect->"recovering"
   inflight!=null->"checking"
   policy.issue==HealthIssue.AUTHENTICATION->"exhausted"
   policy.dueAt==null && issue!=null->"unavailable"
   policy.dueAt!=null || physical==null->"waiting"
   else->"idle"
  }
  return RecoveryStatus(policy.enabled,phase,policy.attempts,issue,accepted?.runId)
 }
}

/** The first native group payload initializes observation; it is not a network change. */
internal class RecoveryGroupState {
 private var initialized=false
 private var selections:Map<String,String> = emptyMap()
 private var value=0L
 @Synchronized fun update(next:Map<String,String>):Boolean {
  if(!initialized) {
   if(next.isEmpty())return false
   initialized=true;selections=next.toMap();value++;return false
  }
  if(next==selections)return false
  selections=next.toMap();value++;return true
 }
 @Synchronized fun revision():Long=value
}
