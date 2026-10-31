package app.cloakwire.client.vpn

import android.content.*
import android.net.ConnectivityManager
import android.os.*
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A candidate process has a different Android process/lease from diagnostics and the session. */
internal class RecoveryProbeClient(private val context:Context) {
 data class Result(val outcome:HealthOutcome,val issue:HealthIssue?,val effective:String?=null)
 private val main=Handler(Looper.getMainLooper())
 private data class Job(val id:String,val done:CountDownLatch=CountDownLatch(1),var result:Result=Result(HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE),var connection:ServiceConnection?=null,var remote:Messenger?=null,var file:File?=null,var cancelled:Boolean=false)
 @Volatile private var current:Job?=null
 fun cancel() { val job=current?:return;job.cancelled=true;job.done.countDown();main.post{release(job)} }
 private fun release(job:Job) {
  runCatching{job.remote?.send(Message.obtain(null,2))}
  job.connection?.let{runCatching{context.unbindService(it)}};job.connection=null
  job.file?.delete();job.file=null
  if(current===job)current=null
 }
 fun probe(snapshot:RecoverySnapshot,stamp:String,config:String,tag:String,isCurrent:()->Boolean):Result {
  val job=Job(UUID.randomUUID().toString())
  synchronized(this) { if(current!=null)return Result(HealthOutcome.UNAVAILABLE,HealthIssue.ENGINE_UNAVAILABLE);current=job }
  main.post {
   if(job.cancelled || !isCurrent()){job.done.countDown();release(job);return@post}
   val cm=context.getSystemService(ConnectivityManager::class.java)
   val network=ProbePlatform.choose(cm)
   if(network==null || ProbePlatform.stamp(cm,network)!=stamp){job.result=Result(HealthOutcome.UNAVAILABLE,HealthIssue.NETWORK_UNAVAILABLE);job.done.countDown();release(job);return@post}
   try {
    val directory=File(context.cacheDir,"profile-probe-input").apply{check(isDirectory||mkdirs())}
    val file=File(directory,job.id+".json");file.writeText(config);job.file=file
    val reply=Messenger(Handler(Looper.getMainLooper()){message->
     if(message.sendingUid==android.os.Process.myUid() && message.data.getString("operation")==job.id && !job.cancelled && isCurrent()) {
      val outcome=runCatching{HealthOutcome.valueOf(message.data.getString("outcome")!!)}.getOrDefault(HealthOutcome.UNAVAILABLE)
      val issue=runCatching{HealthIssue.valueOf(message.data.getString("issue")!!)}.getOrNull()
      job.result=Result(outcome,issue)
     }
     job.done.countDown();release(job);true
    })
    val connection=object:ServiceConnection {
     override fun onServiceConnected(name:ComponentName,binder:IBinder) {
      if(job.cancelled || !isCurrent()){job.done.countDown();release(job);return}
      job.remote=Messenger(binder)
      try { job.remote!!.send(Message.obtain(null,1).apply {
       data=Bundle().apply {
        putString("operation",job.id);putString("engine",if(snapshot.engine=="xray")"xray" else "singbox")
        putString("path",file.absolutePath);putString("tag",tag)
        putLong("network",network.networkHandle);putString("networkStamp",stamp);putLong("remaining",ProbeState.DEADLINE_MS)
       };replyTo=reply
      }) }catch(_:Exception){job.done.countDown();release(job)}
     }
     override fun onServiceDisconnected(name:ComponentName){job.done.countDown();release(job)}
     override fun onBindingDied(name:ComponentName){job.done.countDown();release(job)}
     override fun onNullBinding(name:ComponentName){job.done.countDown();release(job)}
    }
    job.connection=connection
    if(!context.bindService(Intent(context,RecoveryProbeService::class.java),connection,Context.BIND_AUTO_CREATE)){job.done.countDown();release(job)}
   }catch(_:Exception){job.done.countDown();release(job)}
  }
  try { if(!job.done.await(ProbeState.DEADLINE_MS+ProbeState.CLEANUP_MS,TimeUnit.MILLISECONDS))job.result=Result(HealthOutcome.UNAVAILABLE,HealthIssue.TIMEOUT) }
  catch(_:InterruptedException){Thread.currentThread().interrupt();job.cancelled=true}
  finally{main.post{release(job)}}
  return if(job.cancelled || !isCurrent())Result(HealthOutcome.CANCELLED,null) else job.result
 }
}
