package app.cloakwire.client.vpn

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** Pure operation ownership; clocks are injected and result payloads contain no core messages. */
internal class ProbeState {
 companion object { const val DEADLINE_MS=12_000L; const val CLEANUP_MS=2_000L }
 private var value:ConnectionHealth?=null
 private var source:ProfileSource?=null
 private var context:String?=null
 private var started=0L
 @Synchronized fun begin(target:ProfileSource,run:String,now:Long):ConnectionHealth {
  if(source==target && context==run && value?.outcome==HealthOutcome.CHECKING && now-started<DEADLINE_MS)return value!!
  source=target;context=run;started=now
  return ConnectionHealth(SessionIdentity(target.ref,target.revision,null,UUID.randomUUID().toString(),null),
   UUID.randomUUID().toString(),HealthScope.SELECTED_PROFILE,HealthStage.PREPARING,HealthOutcome.CHECKING,null,null,null).also{value=it}
 }
 @Synchronized fun snapshot()=value
 @Synchronized fun matches(id:String,target:ProfileSource)=value?.operationId==id && source==target && value?.outcome==HealthOutcome.CHECKING
 @Synchronized fun remaining(id:String,now:Long):Long=if(value?.operationId==id) (DEADLINE_MS-(now-started)).coerceAtLeast(0) else 0
 @Synchronized fun network(id:String,generation:String):Boolean {
  val current=value?:return false
  if(current.operationId!=id||current.outcome!=HealthOutcome.CHECKING)return false
  value=current.copy(identity=current.identity.copy(networkGeneration=generation),stage=HealthStage.CONNECTING);return true
 }
 @Synchronized fun finish(id:String,outcome:HealthOutcome,issue:HealthIssue?,latency:Long?,now:Long):Boolean {
  val current=value?:return false
  if(current.operationId!=id||current.outcome!=HealthOutcome.CHECKING)return false
  val expired=remaining(id,now)<=0
  val date=SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT).apply{timeZone=TimeZone.getTimeZone("UTC")}.format(Date())
  value=current.copy(stage=HealthStage.COMPLETE,outcome=if(expired)HealthOutcome.FAILED else outcome,
   issue=if(expired)HealthIssue.TIMEOUT else issue,checkedAt=date,latencyMs=if(expired)null else latency)
  return !expired
 }
 @Synchronized fun cancel(id:String) {
  val current=value?:return
  if(current.operationId!=id)return
  value=if(current.outcome==HealthOutcome.CHECKING)
   current.copy(stage=HealthStage.COMPLETE,outcome=HealthOutcome.CANCELLED,issue=null,latencyMs=null) else null
 }
 @Synchronized fun invalidate(){value=null;source=null;context=null}
}
